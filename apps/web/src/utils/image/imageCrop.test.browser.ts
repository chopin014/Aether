/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/*
 * Drawing tests for the image editor's output. They need a real 2D canvas to check which pixels end up where.
 */

import { describe, expect, it, vi } from "vitest";

import { renderImageCrop, type ImageCrop } from "./imageCrop";

// The built package expects Node globals; the geometry it lends the renderer is plain maths, so use its source.
/* oxlint-disable no-restricted-imports */
vi.mock(
    "@element-hq/web-shared-components",
    () => import("../../../../../packages/shared-components/src/desktop/ImageCropView/cropGeometry"),
);
/* oxlint-enable no-restricted-imports */

/** A 4×2 picture: red, green, blue and white columns along the top, black along the bottom. */
function picture(): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.width = 4;
    canvas.height = 2;
    const context = canvas.getContext("2d")!;
    ["#ff0000", "#00ff00", "#0000ff", "#ffffff"].forEach((colour, x) => {
        context.fillStyle = colour;
        context.fillRect(x, 0, 1, 1);
    });
    context.fillStyle = "#000000";
    context.fillRect(0, 1, 4, 1);
    return canvas;
}

async function pixels(blob: Blob): Promise<{ width: number; height: number; at: (x: number, y: number) => number[] }> {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    return {
        width: bitmap.width,
        height: bitmap.height,
        at: (x, y) => Array.from(data.slice((y * bitmap.width + x) * 4, (y * bitmap.width + x) * 4 + 3)),
    };
}

const base: ImageCrop = {
    imageWidth: 4,
    imageHeight: 2,
    rotation: 0,
    aspectRatio: 1,
    zoom: 1,
    centreX: 0.5,
    centreY: 0.5,
    maxOutputWidth: 512,
};

describe("renderImageCrop", () => {
    it("keeps the chosen square of the picture", async () => {
        // The leftmost 2×2 square: red and green over black.
        const blob = await renderImageCrop(picture(), { ...base, centreX: 0.25 }, "image/png");
        expect(blob.type).toBe("image/png");
        const result = await pixels(blob);
        expect([result.width, result.height]).toEqual([2, 2]);
        expect(result.at(0, 0)).toEqual([255, 0, 0]);
        expect(result.at(1, 0)).toEqual([0, 255, 0]);
        expect(result.at(0, 1)).toEqual([0, 0, 0]);
    });

    it("turns the picture before keeping part of it", async () => {
        // Turned a quarter clockwise the picture is 2×4: black and red on top, black and white at the bottom.
        const blob = await renderImageCrop(
            picture(),
            { ...base, rotation: 1, aspectRatio: 0.5, centreX: 0.5, centreY: 0.5 },
            "image/png",
        );
        const result = await pixels(blob);
        expect([result.width, result.height]).toEqual([2, 4]);
        expect(result.at(0, 0)).toEqual([0, 0, 0]);
        expect(result.at(1, 0)).toEqual([255, 0, 0]);
        expect(result.at(1, 3)).toEqual([255, 255, 255]);
    });

    it("keeps JPEG photos as JPEG", async () => {
        const blob = await renderImageCrop(picture(), base, "image/jpeg");
        expect(blob.type).toBe("image/jpeg");
    });
});
