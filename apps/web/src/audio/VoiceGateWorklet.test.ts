/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type VoiceGateSettings } from "./voice-gate-types";

describe("VoiceGateWorklet", () => {
    let processor: AudioWorkletProcessor;
    let port: {
        onmessage: ((event: MessageEvent<VoiceGateSettings | { destroy: true }>) => void) | null;
        postMessage: ReturnType<typeof vi.fn>;
    };

    beforeEach(async () => {
        vi.resetModules();
        port = { onmessage: null, postMessage: vi.fn() };
        vi.stubGlobal(
            "AudioWorkletProcessor",
            class {
                public port = port;
            },
        );
        const register = vi.fn<typeof registerProcessor>();
        vi.stubGlobal("registerProcessor", register);
        vi.stubGlobal("sampleRate", 48000);
        await import("./VoiceGateWorklet");
        expect(register).toHaveBeenCalledWith("aether-voice-gate", expect.any(Function));
        const Worklet = register.mock.calls[0][1];
        processor = new Worklet({
            processorOptions: { inputVolume: 200, automaticSensitivity: false, sensitivity: -40 },
        });
    });

    afterEach(() => vi.unstubAllGlobals());

    it("should gate on the audio clock and send pre-gate levels no more than 20 times per audio second", () => {
        const output = new Float32Array(128);
        const input = new Float32Array(128).fill(0.001);
        for (let i = 0; i < 375; i++) expect(processor.process([[input]], [[output]], {})).toBe(true);
        expect(output.every((sample) => sample === 0)).toBe(true);
        expect(port.postMessage).toHaveBeenCalledTimes(19);
        expect(port.postMessage).toHaveBeenLastCalledWith({
            levelDb: expect.closeTo(20 * Math.log10(0.002)),
            voiceDetected: false,
            thresholdDb: -40,
        });
    });

    it("should apply live settings and terminate on destruction", () => {
        const input = new Float32Array(128).fill(0.1);
        const output = new Float32Array(128);
        for (let i = 0; i < 100; i++) processor.process([[input]], [[output]], {});
        expect(output[127]).toBeCloseTo(0.2);
        port.onmessage!({ data: { inputVolume: 0, automaticSensitivity: false, sensitivity: -40 } } as MessageEvent);
        for (let i = 0; i < 200; i++) processor.process([[input]], [[output]], {});
        expect(output.every((sample) => sample === 0)).toBe(true);
        port.onmessage!({ data: { destroy: true } } as MessageEvent);
        expect(processor.process([[input]], [[output]], {})).toBe(false);
    });

    it("should tolerate disconnected input and missing output", () => {
        expect(processor.process([], [], {})).toBe(true);
        const output = new Float32Array(128).fill(1);
        expect(processor.process([], [[output]], {})).toBe(true);
        expect(output.every((sample) => sample === 0)).toBe(true);
    });
});
