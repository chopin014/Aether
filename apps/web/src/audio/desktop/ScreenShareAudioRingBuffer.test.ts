/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";

import { ScreenShareAudioRingBuffer } from "./ScreenShareAudioRingBuffer";

function pcm(frames: ReadonlyArray<readonly [number, number]>): Uint8Array {
    const buffer = new ArrayBuffer(frames.length * 8);
    const view = new DataView(buffer);
    frames.forEach(([left, right], frame) => {
        view.setFloat32(frame * 8, left, true);
        view.setFloat32(frame * 8 + 4, right, true);
    });
    return new Uint8Array(buffer);
}

function rounded(samples: Float32Array): number[] {
    return Array.from(samples, (sample) => Number(sample.toFixed(4)));
}

describe("ScreenShareAudioRingBuffer", () => {
    it("keeps left/right tone frames in order and outputs silence after an underrun", () => {
        const ring = new ScreenShareAudioRingBuffer(4);
        ring.push(
            pcm([
                [0.1, -0.1],
                [0.2, -0.2],
                [0.3, -0.3],
            ]),
        );
        const left = new Float32Array(4).fill(1);
        const right = new Float32Array(4).fill(1);

        ring.readStereo(left, right);

        expect(rounded(left)).toEqual([0.1, 0.2, 0.3, 0]);
        expect(rounded(right)).toEqual([-0.1, -0.2, -0.3, 0]);
        expect(ring.queuedFrames).toBe(0);
    });

    it("drops the oldest queued audio when its frame limit is exceeded", () => {
        const ring = new ScreenShareAudioRingBuffer(4);
        ring.push(
            pcm([
                [0.1, 0],
                [0.2, 0],
                [0.3, 0],
            ]),
        );
        ring.push(
            pcm([
                [0.4, 0],
                [0.5, 0],
                [0.6, 0],
            ]),
        );
        const left = new Float32Array(4);
        const right = new Float32Array(4);

        ring.readStereo(left, right);

        expect(ring.queuedFrames).toBe(0);
        expect(rounded(left)).toEqual([0.3, 0.4, 0.5, 0.6]);
        expect(rounded(right)).toEqual([0, 0, 0, 0]);
    });

    it("keeps only the newest frames when one packet exceeds the whole buffer", () => {
        const ring = new ScreenShareAudioRingBuffer(3);
        ring.push(
            pcm([
                [0.1, 0],
                [0.2, 0],
                [0.3, 0],
                [0.4, 0],
                [0.5, 0],
            ]),
        );
        const left = new Float32Array(3);
        const right = new Float32Array(3);

        ring.readStereo(left, right);

        expect(rounded(left)).toEqual([0.3, 0.4, 0.5]);
        expect(ring.queuedFrames).toBe(0);
    });

    it("replaces non-finite samples and clamps values to the audio range", () => {
        const ring = new ScreenShareAudioRingBuffer(4);
        ring.push(
            pcm([
                [Number.NaN, 2],
                [Number.POSITIVE_INFINITY, -2],
                [0.25, -0.5],
            ]),
        );
        const left = new Float32Array(3);
        const right = new Float32Array(3);

        ring.readStereo(left, right);

        expect(rounded(left)).toEqual([0, 0, 0.25]);
        expect(rounded(right)).toEqual([1, -1, -0.5]);
        expect(() => ring.push(new Uint8Array(7))).toThrow("complete stereo frames");
    });

    it("clears buffered data when capture ends", () => {
        const ring = new ScreenShareAudioRingBuffer(4);
        ring.push(pcm([[0.5, -0.5]]));
        ring.clear();
        const left = new Float32Array(1).fill(1);
        const right = new Float32Array(1).fill(1);

        ring.readStereo(left, right);

        expect(ring.queuedFrames).toBe(0);
        expect([...left, ...right]).toEqual([0, 0]);
    });
});
