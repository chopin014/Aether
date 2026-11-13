/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";

import { representativeColour } from "./profilePalette";

/** RGBA bytes for a list of pixels. */
function pixels(...colours: [number, number, number, number][]): number[] {
    return colours.flat();
}

describe("representativeColour", () => {
    it("picks the most common vivid colour over the greys around it", () => {
        const repeat = (count: number, colour: [number, number, number, number]): [number, number, number, number][] =>
            Array.from({ length: count }, () => colour);
        const data = pixels(...repeat(30, [90, 90, 90, 255]), ...repeat(6, [250, 200, 60, 255]), [30, 60, 220, 255]);
        expect(representativeColour(data)).toBe("#fac83c");
    });

    it("gives the average of an image with almost no colour in it", () => {
        expect(representativeColour(pixels([100, 100, 100, 255], [140, 140, 140, 255]))).toBe("#787878");
    });

    it("ignores transparent pixels and has nothing to say about an empty image", () => {
        expect(representativeColour(pixels([255, 0, 0, 0]))).toBeUndefined();
        expect(representativeColour(pixels([255, 0, 0, 0], [20, 120, 220, 255]))).toBe("#1478dc");
    });
});
