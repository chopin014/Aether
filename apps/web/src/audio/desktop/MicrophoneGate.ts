/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/** How the microphone is turned into what is sent to the call. */
export interface MicrophoneGateConfig {
    /** How much of the microphone level is kept, from 0 to 1. */
    volume: number;
    /**
     * Where speech starts, in dB relative to full scale (-100 is silence, 0 the loudest sound).
     * "auto" follows the background noise, and null never closes the gate.
     */
    threshold: number | "auto" | null;
    /** Only let sound through while {@link MicrophoneGate.setPushToTalkActive} says so, ignoring the threshold. */
    pushToTalk: boolean;
}

/** The quietest level the meters and the sensitivity setting use. */
export const MIN_LEVEL_DB = -100;

/** How long the gate stays open after the level last reached the threshold, so words do not end abruptly. */
const HOLD_MS = 300;
/** How fast the gain follows the gate, so it opens and closes without clicking. */
const OPEN_RAMP_MS = 3;
const CLOSE_RAMP_MS = 25;
/** The automatic threshold sits this far above the noise floor, which may be anywhere in this range. */
const AUTO_MARGIN_DB = 10;
const AUTO_FLOOR_RANGE_DB = [-80, -40] as const;
/** How quickly the noise floor estimate may rise, so that long speech does not become the "noise". */
const AUTO_FLOOR_RISE_DB_PER_SECOND = 0.5;

/** The loudness of a block of samples, in dB relative to full scale. */
export function levelDb(samples: Float32Array): number {
    if (samples.length === 0) return MIN_LEVEL_DB;
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    const rms = Math.sqrt(sum / samples.length);
    return rms > 0 ? Math.max(MIN_LEVEL_DB, 20 * Math.log10(rms)) : MIN_LEVEL_DB;
}

/**
 * Decides, block by block, whether the microphone is let through, and applies the volume.
 * Pure signal logic with no audio objects, so the threshold and push to talk behaviour can be tested directly.
 */
export class MicrophoneGate {
    private config: MicrophoneGateConfig = { volume: 1, threshold: "auto", pushToTalk: false };
    private pushToTalkActive = false;
    private shortcutMuted = false;
    private holdLeftMs = 0;
    private floorDb: number = AUTO_FLOOR_RANGE_DB[0];
    private floorKnown = false;
    private gain = 0;
    private _open = false;
    private _level = MIN_LEVEL_DB;
    private _threshold: number | null = null;

    public constructor(private readonly sampleRate: number) {}

    /** Whether sound is being let through. */
    public get open(): boolean {
        return this._open;
    }

    /** The loudness of the most recent block. */
    public get level(): number {
        return this._level;
    }

    /** The threshold in use for the most recent block, or null when there is none. */
    public get threshold(): number | null {
        return this._threshold;
    }

    public configure(config: MicrophoneGateConfig): void {
        this.config = { ...config, volume: Math.min(1, Math.max(0, config.volume)) };
    }

    public setPushToTalkActive(active: boolean): void {
        this.pushToTalkActive = active;
    }

    /** Hold-to-mute silences samples without changing the user's explicit mute state. */
    public setShortcutMuted(muted: boolean): void {
        this.shortcutMuted = muted;
    }

    /** Applies the gate and volume to one block of samples. `output` may be the same array as `input`. */
    public processBlock(input: Float32Array, output: Float32Array): void {
        const durationMs = (input.length / this.sampleRate) * 1000;
        this._level = levelDb(input);
        this._threshold = this.resolveThreshold(durationMs);
        this._open = this.shouldOpen(durationMs);
        // Explicit privacy controls close immediately, including the first block after a backend reset.
        if (this.shortcutMuted || this.config.volume === 0 || (this.config.pushToTalk && !this.pushToTalkActive)) {
            this._open = false;
            this.gain = 0;
            this.holdLeftMs = 0;
            output.fill(0);
            return;
        }

        const target = this._open ? this.config.volume : 0;
        const rampMs = target > this.gain ? OPEN_RAMP_MS : CLOSE_RAMP_MS;
        const step = 1 / ((rampMs / 1000) * this.sampleRate);
        for (let i = 0; i < input.length; i++) {
            if (this.gain < target) this.gain = Math.min(target, this.gain + step);
            else if (this.gain > target) this.gain = Math.max(target, this.gain - step);
            output[i] = input[i] * this.gain;
        }
    }

    private resolveThreshold(durationMs: number): number | null {
        const { threshold } = this.config;
        if (threshold === "auto") {
            const [lowest, highest] = AUTO_FLOOR_RANGE_DB;
            // The first block is the best guess there is; after that the floor drops to any quieter moment at
            // once and creeps up otherwise.
            const risen = this.floorKnown
                ? this.floorDb + (AUTO_FLOOR_RISE_DB_PER_SECOND * durationMs) / 1000
                : Infinity;
            this.floorDb = Math.min(highest, Math.max(lowest, Math.min(this._level, risen)));
            this.floorKnown = true;
            return this.floorDb + AUTO_MARGIN_DB;
        }
        // The lowest setting means "everything passes", like it does in a gate that is fully open.
        return threshold === null || threshold <= MIN_LEVEL_DB ? null : threshold;
    }

    private shouldOpen(durationMs: number): boolean {
        if (this.config.pushToTalk) return this.pushToTalkActive;
        if (this._threshold === null) return true;
        if (this._level >= this._threshold) this.holdLeftMs = HOLD_MS;
        else this.holdLeftMs = Math.max(0, this.holdLeftMs - durationMs);
        return this.holdLeftMs > 0;
    }
}
