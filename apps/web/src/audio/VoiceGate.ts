/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { normalizeVoiceGateSettings, type VoiceGateLevel, type VoiceGateSettings } from "./voice-gate-types";

/** Sample-clocked microphone gain and voice activation, independent of page timers. */
export class VoiceGate implements VoiceGateLevel {
    public levelDb = -100;
    public voiceDetected = false;
    public thresholdDb = -50;

    private settings: VoiceGateSettings;
    private inputGain: number;
    private gateGain = 0;
    private noiseFloorDb?: number;
    private holdSeconds = 0;
    private readonly gainSmoothing: number;
    private readonly attack: number;
    private readonly release: number;

    public constructor(
        private readonly sampleRate: number,
        settings: Partial<VoiceGateSettings> = {},
    ) {
        this.settings = normalizeVoiceGateSettings(settings);
        this.inputGain = this.settings.inputVolume / 100;
        this.gainSmoothing = 1 - Math.exp(-1 / (sampleRate * 0.005));
        this.attack = 1 - Math.exp(-1 / (sampleRate * 0.003));
        this.release = 1 - Math.exp(-1 / (sampleRate * 0.02));
    }

    /** Apply changes without resetting the speech hangover or creating discontinuities. */
    public updateSettings(settings: Partial<VoiceGateSettings>): void {
        const next = normalizeVoiceGateSettings(settings);
        if (this.noiseFloorDb !== undefined && next.inputVolume > 0 && this.settings.inputVolume > 0) {
            this.noiseFloorDb += 20 * Math.log10(next.inputVolume / this.settings.inputVolume);
        }
        this.settings = next;
    }

    /** Write one mono render quantum, retaining the ungated level for the meter. */
    public process(input: Float32Array | undefined, output: Float32Array): void {
        const seconds = output.length / this.sampleRate;
        const targetGain = this.settings.inputVolume / 100;
        let energy = 0;
        for (let i = 0; i < output.length; i++) {
            this.inputGain += (targetGain - this.inputGain) * this.gainSmoothing;
            if (Math.abs(this.inputGain - targetGain) < 0.000001) this.inputGain = targetGain;
            const sample = (input?.[i] ?? 0) * this.inputGain;
            output[i] = sample;
            energy += sample * sample;
        }
        this.levelDb = Math.max(-100, 10 * Math.log10(energy / output.length || 1e-10));

        // Learn ambient sound while speech is absent. Faster downward adaptation follows quiet pauses
        // without allowing a sustained word to raise the threshold and cut itself off.
        if (this.noiseFloorDb === undefined && this.levelDb > -100) {
            this.noiseFloorDb = Math.min(-30, this.levelDb);
        } else if (this.noiseFloorDb !== undefined && (!this.voiceDetected || this.levelDb < this.noiseFloorDb)) {
            const timeConstant = this.levelDb < this.noiseFloorDb ? 0.15 : 1.5;
            this.noiseFloorDb += (this.levelDb - this.noiseFloorDb) * (1 - Math.exp(-seconds / timeConstant));
        }
        this.thresholdDb = this.settings.automaticSensitivity
            ? Math.max(-80, Math.min(-20, (this.noiseFloorDb ?? -60) + 10))
            : this.settings.sensitivity;

        // A lower closing threshold and a 200 ms hold avoid chopping quiet syllables and brief pauses.
        const threshold = this.thresholdDb - (this.voiceDetected ? 4 : 0);
        if (targetGain > 0 && this.levelDb > -100 && this.levelDb >= threshold) {
            this.voiceDetected = true;
            this.holdSeconds = 0.2;
        } else {
            this.holdSeconds = Math.max(0, this.holdSeconds - seconds);
            this.voiceDetected = targetGain > 0 && this.holdSeconds > 0;
        }
        const targetGate = this.voiceDetected ? 1 : 0;
        const smoothing = this.voiceDetected ? this.attack : this.release;
        for (let i = 0; i < output.length; i++) {
            this.gateGain += (targetGate - this.gateGain) * smoothing;
            if (Math.abs(this.gateGain - targetGate) < 0.000001) this.gateGain = targetGate;
            output[i] *= this.gateGain;
        }
    }
}
