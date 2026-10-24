/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { type MicrophoneGateWorkletOptions, type MicrophoneProcessorState } from "./MicrophoneProcessorState";

interface TestProcessor {
    port: {
        onmessage: (event: {
            data: MicrophoneProcessorState | { stop: true } | { denoiserModule: WebAssembly.Module };
        }) => void;
        postMessage: ReturnType<typeof vi.fn>;
    };
    process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean;
}

let Processor: new (
    options: AudioWorkletNodeOptions & { processorOptions?: MicrophoneGateWorkletOptions },
) => TestProcessor;
let denoiserModule: WebAssembly.Module;

const state: MicrophoneProcessorState = {
    config: { volume: 1, threshold: null, pushToTalk: true },
    pushToTalkActive: false,
    shortcutMuted: false,
};

beforeAll(async () => {
    vi.stubGlobal("sampleRate", 48000);
    vi.stubGlobal(
        "AudioWorkletProcessor",
        class {
            public port = { onmessage: null, postMessage: vi.fn() };
        },
    );
    vi.stubGlobal("registerProcessor", (_name: string, constructor: typeof Processor) => {
        Processor = constructor;
    });
    await import("./MicrophoneGateWorklet");
    denoiserModule = await WebAssembly.compile(
        readFileSync(new URL("./denoiser/aether-denoiser.wasm", import.meta.url)),
    );
});

afterAll(() => vi.unstubAllGlobals());

describe("MicrophoneGateWorklet", () => {
    it("starts closed and applies hold state atomically before the next audio block", () => {
        const processor = new Processor({ processorOptions: state });
        const input = new Float32Array(128).fill(0.5);
        const output = new Float32Array(128).fill(1);
        processor.process([[input]], [[output]]);
        expect(output.every((sample) => sample === 0)).toBe(true);

        processor.port.onmessage({ data: { ...state, pushToTalkActive: true } });
        for (let i = 0; i < 20; i++) processor.process([[input]], [[output]]);
        expect(output[127]).toBeGreaterThan(0.4);

        processor.port.onmessage({ data: { ...state, pushToTalkActive: true, shortcutMuted: true } });
        processor.process([[input]], [[output]]);
        expect(output.every((sample) => sample === 0)).toBe(true);
    });

    it("outputs silence when input disappears and stops without a final audible block", () => {
        const processor = new Processor({ processorOptions: { ...state, pushToTalkActive: true } });
        const input = new Float32Array(128).fill(0.5);
        const output = new Float32Array(128).fill(1);
        expect(processor.process([], [[output]])).toBe(true);
        expect(output.every((sample) => sample === 0)).toBe(true);
        processor.port.onmessage({ data: { stop: true } });
        expect(processor.process([[input]], [[output]])).toBe(false);
        expect(output.every((sample) => sample === 0)).toBe(true);
        expect(processor.process([], [])).toBe(false);
    });

    it("limits meter updates to twenty per second while processing every block", () => {
        const processor = new Processor({ processorOptions: { ...state, pushToTalkActive: true } });
        const input = new Float32Array(128).fill(0.5);
        const output = new Float32Array(128);
        for (let i = 0; i < 18; i++) processor.process([[input]], [[output]]);
        expect(processor.port.postMessage).not.toHaveBeenCalled();
        processor.process([[input]], [[output]]);
        expect(processor.port.postMessage).toHaveBeenCalledWith({ level: expect.closeTo(-6.02, 1), open: true });
        expect(processor.port.postMessage).toHaveBeenCalledTimes(1);
    });
});

// These run the real model, which takes most of a second to load.
describe("MicrophoneGateWorklet with noise suppression", { timeout: 30000 }, () => {
    const suppressed: MicrophoneProcessorState = {
        config: { volume: 1, threshold: "auto", pushToTalk: false, noiseSuppression: 100, voiceDetection: true },
        pushToTalkActive: false,
        shortcutMuted: false,
    };

    /** Repeatable white noise blocks at about -30 dB relative to full scale. */
    function noiseBlock(seed: { value: number }): Float32Array {
        return Float32Array.from({ length: 128 }, () => {
            seed.value = (seed.value * 1103515245 + 12345) & 0x7fffffff;
            return ((seed.value / 0x7fffffff) * 2 - 1) * 0.055;
        });
    }

    /** Processes `seconds` of noise and returns the loudest sample of the last half second. */
    function runNoise(processor: TestProcessor, seconds: number): number {
        const seed = { value: 1 };
        let loudest = 0;
        const blocks = (48000 * seconds) / 128;
        for (let i = 0; i < blocks; i++) {
            const output = new Float32Array(128);
            processor.process([[noiseBlock(seed)]], [[output]]);
            if (i > blocks - 48000 / 2 / 128) loudest = Math.max(loudest, ...output.map(Math.abs));
        }
        return loudest;
    }

    afterEach(() => vi.restoreAllMocks());

    it("removes noise before the gate, so noise alone never opens the microphone", () => {
        const processor = new Processor({ processorOptions: { ...suppressed, denoiserModule } });
        expect(processor.port.postMessage).toHaveBeenCalledWith({ denoiser: "active" });
        expect(runNoise(processor, 1.5)).toBe(0);
    });

    it("sends the microphone as it is when noise suppression is off", () => {
        const processor = new Processor({
            processorOptions: {
                ...suppressed,
                config: { ...suppressed.config, threshold: null, noiseSuppression: null },
                denoiserModule,
            },
        });
        expect(runNoise(processor, 0.6)).toBeGreaterThan(0.05);
    });

    it("starts noise suppression that arrives after the microphone", () => {
        const processor = new Processor({ processorOptions: suppressed });
        processor.port.onmessage({ data: { denoiserModule } });
        expect(processor.port.postMessage).toHaveBeenCalledWith({ denoiser: "active" });
        expect(runNoise(processor, 1.5)).toBe(0);
    });

    it("keeps gating the microphone when noise suppression cannot start", async () => {
        const empty = await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
        const processor = new Processor({
            processorOptions: {
                ...suppressed,
                config: { ...suppressed.config, pushToTalk: true },
                denoiserModule: empty,
            },
        });
        expect(processor.port.postMessage).toHaveBeenCalledWith({ denoiser: "failed" });
        // Push to talk is not pressed, so nothing may get through even without the model.
        expect(runNoise(processor, 0.3)).toBe(0);
    });

    it("turns noise suppression off when the computer cannot keep up, and keeps the microphone", () => {
        const processor = new Processor({
            processorOptions: { ...suppressed, config: { ...suppressed.config, threshold: null }, denoiserModule },
        });
        // Every block appears to take 5 ms, far longer than the 2.7 ms of audio it holds.
        let now = 0;
        vi.spyOn(Date, "now").mockImplementation(() => (now += 5));
        runNoise(processor, 3.2);
        expect(processor.port.postMessage).toHaveBeenCalledWith({ denoiser: "overloaded" });
        expect(runNoise(processor, 0.6)).toBeGreaterThan(0.05);
    });
});
