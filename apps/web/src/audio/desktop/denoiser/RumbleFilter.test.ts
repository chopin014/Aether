/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";

import { RumbleFilter } from "./RumbleFilter";

const RATE = 48000;

describe("RumbleFilter", () => {
    it("stays exactly silent for silence", () => {
        const filter = new RumbleFilter(RATE);
        for (let i = 0; i < RATE; i++) expect(filter.processSample(0)).toBe(0);
    });

    it("removes a constant offset without leaving an unstable tail", () => {
        const filter = new RumbleFilter(RATE);
        let largest = 0;
        for (let i = 0; i < RATE * 2; i++) {
            const output = filter.processSample(0.2);
            expect(Number.isFinite(output)).toBe(true);
            if (i >= RATE) largest = Math.max(largest, Math.abs(output));
        }
        expect(largest).toBeLessThan(1e-8);
    });

    it.each([
        [2, -40, 0.1],
        [20, -3.01, 0.05],
        [100, 0, 0.01],
        [1000, 0, 0.01],
    ])("attenuates a %s Hz tone by approximately %s dB", (frequency, expectedDb, tolerance) => {
        const filter = new RumbleFilter(RATE);
        let inputPower = 0;
        let outputPower = 0;
        for (let i = 0; i < RATE * 2; i++) {
            const input = 0.1 * Math.sin((2 * Math.PI * frequency * i) / RATE);
            const output = filter.processSample(input);
            if (i >= RATE) {
                inputPower += input * input;
                outputPower += output * output;
            }
        }
        expect(Math.abs(10 * Math.log10(outputPower / inputPower) - expectedDb)).toBeLessThan(tolerance);
    });
});
