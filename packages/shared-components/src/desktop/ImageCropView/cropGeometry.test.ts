/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";

import { clampCropCentre, cropSize, turnedImageSize, type ImageCropFrame } from "./cropGeometry";

const landscape: ImageCropFrame = { imageWidth: 1200, imageHeight: 800, rotation: 0, aspectRatio: 1, zoom: 1 };

describe("cropGeometry", () => {
    it("swaps the sides of a quarter-turned image", () => {
        expect(turnedImageSize({ ...landscape, rotation: 1 })).toEqual({ width: 800, height: 1200 });
        expect(turnedImageSize({ ...landscape, rotation: 2 })).toEqual({ width: 1200, height: 800 });
    });

    it("covers the shorter side at zoom 1", () => {
        expect(cropSize(landscape)).toEqual({ width: 800 / 1200, height: 1 });
        expect(cropSize({ ...landscape, rotation: 1 })).toEqual({ width: 1, height: 800 / 1200 });
        // A 3:1 banner from a 3:2 picture keeps the whole width and half the height.
        expect(cropSize({ ...landscape, aspectRatio: 3 })).toEqual({ width: 1, height: 0.5 });
    });

    it("shrinks the kept area as the zoom grows", () => {
        expect(cropSize({ ...landscape, zoom: 2 })).toEqual({ width: 1 / 3, height: 0.5 });
    });

    it("keeps the kept area inside the image", () => {
        expect(clampCropCentre(landscape, 0, 0.9)).toEqual({ x: 1 / 3, y: 0.5 });
        expect(clampCropCentre({ ...landscape, zoom: 2 }, 0.9, 0.9)).toEqual({ x: 1 - 1 / 6, y: 0.75 });
        expect(clampCropCentre({ ...landscape, zoom: 2 }, 0.4, 0.6)).toEqual({ x: 0.4, y: 0.6 });
    });
});
