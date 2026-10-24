/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { type MicrophoneProcessorState } from "./MicrophoneProcessorState";

interface TestProcessor {
    port: {
        onmessage: (event: { data: MicrophoneProcessorState | { stop: true } }) => void;
        postMessage: ReturnType<typeof vi.fn>;
    };
    process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean;
}

let Processor: new (options: AudioWorkletNodeOptions) => TestProcessor;

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
