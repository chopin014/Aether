/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { VoiceGate } from "./VoiceGate";
import { type VoiceGateSettings, type VoiceGateLevel } from "./voice-gate-types";

declare const sampleRate: number;

class VoiceGateWorklet extends AudioWorkletProcessor {
    private readonly gate: VoiceGate;
    private framesSinceReport = 0;
    private destroyed = false;

    public constructor(options: AudioWorkletNodeOptions = {}) {
        super();
        this.gate = new VoiceGate(sampleRate, options.processorOptions as VoiceGateSettings);
        this.port.onmessage = (event: MessageEvent<VoiceGateSettings | { destroy: true }>): void => {
            if ("destroy" in event.data) this.destroyed = true;
            else this.gate.updateSettings(event.data);
        };
    }

    public process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
        if (this.destroyed) return false;
        const output = outputs[0]?.[0];
        if (!output) return true;
        this.gate.process(inputs[0]?.[0], output);
        this.framesSinceReport += output.length;
        if (this.framesSinceReport >= sampleRate / 20) {
            this.framesSinceReport = 0;
            this.port.postMessage({
                levelDb: this.gate.levelDb,
                voiceDetected: this.gate.voiceDetected,
                thresholdDb: this.gate.thresholdDb,
            } satisfies VoiceGateLevel);
        }
        return true;
    }
}

registerProcessor("aether-voice-gate", VoiceGateWorklet);
