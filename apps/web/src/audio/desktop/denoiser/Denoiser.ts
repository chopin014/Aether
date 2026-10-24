/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/** What `aether-denoiser.wasm` exports; see `apps/web/native/aether-denoiser`. */
export interface DenoiserExports {
    memory: WebAssembly.Memory;
    denoiser_alloc(length: number): number;
    denoiser_create(attenuationLimitDb: number): number;
    denoiser_frame_length(state: number): number;
    denoiser_set_atten_lim(state: number, attenuationLimitDb: number): void;
    denoiser_process(state: number, input: number, output: number): number;
}

/** The only sample rate the model runs at. */
export const DENOISER_SAMPLE_RATE = 48000;

/**
 * A frame counts as speech when the model hears speech this far above the noise, in dB. Fans, typing and claps
 * on their own stay below it, while the quietest syllables of speech reach it.
 */
const SPEECH_SNR_DB = -3;
/** Speech must last this many frames in a row (10 ms each), so a single loud frame cannot open the gate. */
const SPEECH_ONSET_FRAMES = 2;
/** Room for the incoming and outgoing samples. A frame plus the largest render block fits many times over. */
const QUEUE_LENGTH = 4096;

/** Maps the 0 to 100 strength setting onto how far the model may lower the noise: 100 means without limit. */
export function attenuationLimitDb(strength: number): number {
    if (strength >= 100) return 100;
    return 6 + (Math.max(0, strength) / 100) * 44;
}

/**
 * DeepFilterNet3 noise suppression for blocks of any length. The model works on 480-sample frames, so the output
 * is delayed by up to one frame on top of the model's own 30 ms. It also reports whether the latest frames were
 * speech, which leads the output and so already covers the start of each word.
 */
export class Denoiser {
    private readonly state: number;
    private readonly frameLength: number;
    private readonly inputPointer: number;
    private readonly outputPointer: number;
    private memory?: ArrayBuffer;
    private inputFrame!: Float32Array;
    private outputFrame!: Float32Array;

    private readonly pending = new Float32Array(QUEUE_LENGTH);
    private pendingLength = 0;
    private readonly ready = new Float32Array(QUEUE_LENGTH);
    private readyStart = 0;
    private readyLength: number;
    private speechFrames = 0;
    private _speechSnrDb = -15;

    public constructor(
        private readonly wasm: DenoiserExports,
        attenuationLimit: number,
    ) {
        this.state = wasm.denoiser_create(attenuationLimit);
        this.frameLength = wasm.denoiser_frame_length(this.state);
        this.inputPointer = wasm.denoiser_alloc(this.frameLength);
        this.outputPointer = wasm.denoiser_alloc(this.frameLength);
        // Silence in front makes every block's output available as soon as it is asked for.
        this.readyLength = this.frameLength;
    }

    /** How far the latest frame's speech stands above its noise, in dB, from -15 to 35. */
    public get speechSnrDb(): number {
        return this._speechSnrDb;
    }

    /** Whether the model has heard speech in the latest frames. */
    public get speechDetected(): boolean {
        return this.speechFrames >= SPEECH_ONSET_FRAMES;
    }

    public setAttenuationLimit(attenuationLimit: number): void {
        this.wasm.denoiser_set_atten_lim(this.state, attenuationLimit);
    }

    /** Denoises one block. `output` must have the same length as `input` and may be the same array. */
    public process(input: Float32Array, output: Float32Array): void {
        this.pending.set(input, this.pendingLength);
        this.pendingLength += input.length;
        while (this.pendingLength >= this.frameLength) this.processFrame();
        for (let i = 0; i < output.length; i++) {
            output[i] = this.ready[(this.readyStart + i) % QUEUE_LENGTH];
        }
        this.readyStart = (this.readyStart + output.length) % QUEUE_LENGTH;
        this.readyLength -= output.length;
    }

    private processFrame(): void {
        // Growing the module's memory replaces its buffer, which detaches older views.
        if (this.memory !== this.wasm.memory.buffer) {
            this.memory = this.wasm.memory.buffer;
            this.inputFrame = new Float32Array(this.memory, this.inputPointer, this.frameLength);
            this.outputFrame = new Float32Array(this.memory, this.outputPointer, this.frameLength);
        }
        this.inputFrame.set(this.pending.subarray(0, this.frameLength));
        this.pending.copyWithin(0, this.frameLength, this.pendingLength);
        this.pendingLength -= this.frameLength;

        this._speechSnrDb = this.wasm.denoiser_process(this.state, this.inputPointer, this.outputPointer);
        this.speechFrames = this._speechSnrDb >= SPEECH_SNR_DB ? this.speechFrames + 1 : 0;

        const end = this.readyStart + this.readyLength;
        for (let i = 0; i < this.frameLength; i++) this.ready[(end + i) % QUEUE_LENGTH] = this.outputFrame[i];
        this.readyLength += this.frameLength;
    }
}
