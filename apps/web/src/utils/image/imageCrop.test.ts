/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";

import { croppedFileName, croppedSize, isAnimatedImage, type ImageCrop } from "./imageCrop";

const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));

function webp(flags: number): File {
    const bytes = [...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBPVP8X"), 10, 0, 0, 0, flags, 0, 0, 0];
    return new File([new Uint8Array(bytes)], "a.webp", { type: "image/webp" });
}

function png(...chunks: string[]): File {
    const bytes = [0x89, ...ascii("PNG"), ...chunks.flatMap((chunk) => [0, 0, 0, 0, ...ascii(chunk)])];
    return new File([new Uint8Array(bytes)], "a.png", { type: "image/png" });
}

describe("isAnimatedImage", () => {
    it("counts every GIF and APNG", async () => {
        expect(await isAnimatedImage(new File([""], "a.gif", { type: "image/gif" }))).toBe(true);
        expect(await isAnimatedImage(new File([""], "a.png", { type: "image/apng" }))).toBe(true);
        expect(await isAnimatedImage(new File([""], "a.jpg", { type: "image/jpeg" }))).toBe(false);
    });

    it("reads the WebP animation flag", async () => {
        expect(await isAnimatedImage(webp(0x02))).toBe(true);
        expect(await isAnimatedImage(webp(0x10))).toBe(false);
    });

    it("finds an animation chunk before a PNG's image data", async () => {
        expect(await isAnimatedImage(png("IHDR", "acTL", "IDAT"))).toBe(true);
        expect(await isAnimatedImage(png("IHDR", "IDAT"))).toBe(false);
        expect(await isAnimatedImage(png("IHDR", "IDAT", "acTL"))).toBe(false);
    });
});

describe("croppedSize", () => {
    const crop: ImageCrop = {
        imageWidth: 3000,
        imageHeight: 2000,
        rotation: 0,
        aspectRatio: 1,
        zoom: 1,
        centreX: 0.5,
        centreY: 0.5,
        maxOutputWidth: 512,
    };

    it("shrinks large images to the largest size allowed", () => {
        expect(croppedSize(crop)).toEqual({ width: 512, height: 512 });
        expect(croppedSize({ ...crop, aspectRatio: 3, maxOutputWidth: 1500 })).toEqual({ width: 1500, height: 500 });
    });

    it("does not enlarge a small kept area", () => {
        expect(croppedSize({ ...crop, imageWidth: 300, imageHeight: 200, zoom: 2 })).toEqual({
            width: 100,
            height: 100,
        });
    });
});

describe("croppedFileName", () => {
    it("swaps the extension for the new format", () => {
        expect(croppedFileName("me.jpeg", "image/jpeg")).toBe("me.jpg");
        expect(croppedFileName("party.v2.gif", "image/png")).toBe("party.v2.png");
        expect(croppedFileName(".png", "image/png")).toBe("image.png");
    });
});
