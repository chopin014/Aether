/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";

import { RealFft } from "./RealFft";

describe("RealFft", () => {
    it("puts a sine's energy in its own bin", () => {
        const fft = new RealFft(64);
        const input = new Float32Array(64).map((_, i) => Math.cos((2 * Math.PI * 5 * i) / 64));
        const re = new Float32Array(fft.bins);
        const im = new Float32Array(fft.bins);
        fft.forward(input, re, im);
        for (let k = 0; k < fft.bins; k++) {
            expect(Math.hypot(re[k], im[k])).toBeCloseTo(k === 5 ? 32 : 0, 3);
        }
    });

    it("gets the signal back from its spectrum", () => {
        const fft = new RealFft(256);
        const input = new Float32Array(256).map((_, i) => Math.sin(i * 0.37) + 0.5 * Math.cos(i * 1.9) - 0.2);
        const re = new Float32Array(fft.bins);
        const im = new Float32Array(fft.bins);
        const output = new Float32Array(256);
        fft.forward(input, re, im);
        fft.inverse(re, im, output);
        for (let i = 0; i < 256; i++) expect(output[i]).toBeCloseTo(input[i], 5);
    });

    it("refuses sizes that are not powers of two", () => {
        expect(() => new RealFft(100)).toThrow();
        expect(() => new RealFft(1)).toThrow();
    });
});
