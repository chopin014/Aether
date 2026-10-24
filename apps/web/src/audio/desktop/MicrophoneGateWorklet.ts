/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { MicrophoneGate } from "./MicrophoneGate";
import { type MicrophoneGateWorkletOptions, type MicrophoneProcessorState } from "./MicrophoneProcessorState";
import { attenuationLimitDb, Denoiser, type DenoiserExports } from "./denoiser/Denoiser";
import { type DenoiserStatus } from "./denoiser/DenoiserStatus";

declare const sampleRate: number;

type Message = MicrophoneProcessorState | { stop: true } | { denoiserModule: WebAssembly.Module };

/** Noise suppression is given up when it takes more than this share of real time for {@link OVERLOAD_SECONDS}. */
const OVERLOAD_LOAD = 0.7;
const OVERLOAD_SECONDS = 3;

class MicrophoneGateWorklet extends AudioWorkletProcessor {
    private readonly gate = new MicrophoneGate(sampleRate);
    private stopped = false;
    private framesSinceReport = 0;
    private noiseSuppression: number | null = null;
    private denoiser?: Denoiser;
    private denoised = new Float32Array(128);
    private denoiseMs = 0;
    private framesSinceLoadCheck = 0;
    private overloadedSeconds = 0;

    public constructor(options: AudioWorkletNodeOptions = {}) {
        super();
        const { denoiserModule, ...state } = options.processorOptions as MicrophoneGateWorkletOptions;
        this.applyState(state);
        if (denoiserModule) this.startDenoiser(denoiserModule);
        this.port.onmessage = (event: MessageEvent<Message>): void => {
            if ("stop" in event.data) this.stopped = true;
            else if ("denoiserModule" in event.data) this.startDenoiser(event.data.denoiserModule);
            else this.applyState(event.data);
        };
    }

    private applyState(state: MicrophoneProcessorState): void {
        this.gate.configure(state.config);
        this.gate.setPushToTalkActive(state.pushToTalkActive);
        this.gate.setShortcutMuted(state.shortcutMuted);
        this.noiseSuppression = state.config.noiseSuppression ?? null;
        if (this.noiseSuppression !== null)
            this.denoiser?.setAttenuationLimit(attenuationLimitDb(this.noiseSuppression));
    }

    private report(status: DenoiserStatus): void {
        this.port.postMessage({ denoiser: status });
    }

    private startDenoiser(module: WebAssembly.Module): void {
        if (this.denoiser) return;
        try {
            // This loads the model on the audio thread. The context only carries this microphone, so nothing
            // else waits for it.
            const instance = new WebAssembly.Instance(module, {});
            const exports = instance.exports as unknown as DenoiserExports;
            this.denoiser = new Denoiser(exports, attenuationLimitDb(this.noiseSuppression ?? 100));
            this.report("active");
        } catch {
            this.report("failed");
        }
    }

    /** Stops noise suppression for the rest of this microphone, leaving the gate and volume in place. */
    private stopDenoiser(status: DenoiserStatus): void {
        this.denoiser = undefined;
        this.report(status);
    }

    /** Returns the block to gate: denoised when noise suppression runs, otherwise the input itself. */
    private denoise(input: Float32Array): Float32Array {
        if (this.noiseSuppression === null || !this.denoiser) return input;
        if (this.denoised.length !== input.length) this.denoised = new Float32Array(input.length);
        const started = Date.now();
        try {
            this.denoiser.process(input, this.denoised);
        } catch {
            this.stopDenoiser("failed");
            return input;
        }
        this.denoiseMs += Date.now() - started;
        this.framesSinceLoadCheck += input.length;
        if (this.framesSinceLoadCheck >= sampleRate) {
            const load = this.denoiseMs / ((this.framesSinceLoadCheck / sampleRate) * 1000);
            this.overloadedSeconds = load > OVERLOAD_LOAD ? this.overloadedSeconds + 1 : 0;
            this.denoiseMs = this.framesSinceLoadCheck = 0;
            // A processor that cannot keep up makes the whole microphone stutter, which is worse than noise.
            if (this.overloadedSeconds >= OVERLOAD_SECONDS) this.stopDenoiser("overloaded");
        }
        return this.denoised;
    }

    public process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
        const output = outputs[0]?.[0];
        if (!output) return !this.stopped;
        if (this.stopped) {
            output.fill(0);
            return false;
        }
        const input = inputs[0]?.[0];
        if (input) {
            const block = this.denoise(input);
            const speech = block === input ? undefined : this.denoiser?.speechDetected;
            this.gate.processBlock(block, output, speech);
        } else {
            output.fill(0);
        }
        this.framesSinceReport += output.length;
        if (this.framesSinceReport >= sampleRate / 20) {
            this.framesSinceReport = 0;
            this.port.postMessage({ level: this.gate.level, open: this.gate.open, threshold: this.gate.threshold });
        }
        return true;
    }
}

registerProcessor("aether-microphone-gate", MicrophoneGateWorklet);

/** Webpack's worklet loader replaces this export with the emitted module URL. */
export const microphoneGateWorkletUrl = "";
