/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

interface TestWorklet {
    port: {
        onmessage:
            | ((event: MessageEvent<{ type: "pcm"; sequence: number; pcm: ArrayBuffer } | { type: "stop" }>) => void)
            | null;
        postMessage: ReturnType<typeof vi.fn>;
    };
    process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean;
}

let Processor: new () => TestWorklet;

function makePcm(frames: ReadonlyArray<readonly [number, number]>): ArrayBuffer {
    const buffer = new ArrayBuffer(frames.length * 8);
    const view = new DataView(buffer);
    frames.forEach(([left, right], frame) => {
        view.setFloat32(frame * 8, left, true);
        view.setFloat32(frame * 8 + 4, right, true);
    });
    return buffer;
}

function render(processor: TestWorklet, frameCount: number): [Float32Array, Float32Array, boolean] {
    const left = new Float32Array(frameCount).fill(1);
    const right = new Float32Array(frameCount).fill(1);
    const alive = processor.process([], [[left, right]]);
    return [left, right, alive];
}

beforeAll(async () => {
    vi.stubGlobal(
        "AudioWorkletProcessor",
        class {
            public port = { onmessage: null, postMessage: vi.fn() };
        },
    );
    vi.stubGlobal("registerProcessor", (_name: string, constructor: typeof Processor) => {
        Processor = constructor;
    });
    await import("./ScreenShareAudioWorklet");
});

afterAll(() => vi.unstubAllGlobals());

describe("ScreenShareAudioWorklet", () => {
    it("renders little-endian stereo packets in order and silences underruns", () => {
        const processor = new Processor();
        processor.port.onmessage!({
            data: {
                type: "pcm",
                sequence: 7,
                pcm: makePcm([
                    [0.25, -0.25],
                    [0.5, -0.5],
                ]),
            },
        } as MessageEvent<{ type: "pcm"; sequence: number; pcm: ArrayBuffer } | { type: "stop" }>);

        const [left, right, alive] = render(processor, 3);

        expect([...left]).toEqual([0.25, 0.5, 0]);
        expect([...right]).toEqual([-0.25, -0.5, 0]);
        expect(alive).toBe(true);
        expect(processor.port.postMessage).toHaveBeenCalledWith({ type: "received", sequence: 7 });
    });

    it("clears pending samples and returns false after stop", () => {
        const processor = new Processor();
        processor.port.onmessage!({
            data: { type: "pcm", sequence: 1, pcm: makePcm([[0.75, 0.75]]) },
        } as MessageEvent<{ type: "pcm"; sequence: number; pcm: ArrayBuffer } | { type: "stop" }>);
        processor.port.onmessage!({
            data: { type: "stop" },
        } as MessageEvent<{ type: "pcm"; sequence: number; pcm: ArrayBuffer } | { type: "stop" }>);

        const [left, right, alive] = render(processor, 2);

        expect([...left]).toEqual([0, 0]);
        expect([...right]).toEqual([0, 0]);
        expect(alive).toBe(false);
    });
});
