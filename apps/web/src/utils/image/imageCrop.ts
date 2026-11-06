/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { cropSize, turnedImageSize, type ImageCropFrame } from "@element-hq/web-shared-components";

/** The part of an image to keep, and how large to make the result. */
export interface ImageCrop extends ImageCropFrame {
    /** Centre of the kept area, as a fraction of the turned image's width. */
    centreX: number;
    /** Centre of the kept area, as a fraction of the turned image's height. */
    centreY: number;
    /** The widest the result may be. A smaller kept area is not enlarged to reach it. */
    maxOutputWidth: number;
}

/** How many bytes to read when looking for animation. Animation markers come before the image data. */
const HEADER_BYTES = 64 * 1024;

/** Whether an image file may move. GIFs always count; PNG and WebP files are checked for animation markers. */
export async function isAnimatedImage(file: File): Promise<boolean> {
    if (file.type === "image/gif" || file.type === "image/apng") return true;
    if (file.type !== "image/png" && file.type !== "image/webp") return false;
    const bytes = new Uint8Array(await file.slice(0, HEADER_BYTES).arrayBuffer());
    // Single-byte decoding keeps every byte at its own index, which is all the ASCII markers need.
    const header = new TextDecoder("latin1").decode(bytes);
    const text = (start: number, length: number): string => header.slice(start, start + length);
    if (file.type === "image/webp") {
        // An extended WebP marks animation in the flags byte of its first chunk.
        return text(0, 4) === "RIFF" && text(8, 4) === "WEBP" && text(12, 4) === "VP8X" && (bytes[20] & 0x02) !== 0;
    }
    // An animated PNG has an animation control chunk before its image data.
    const control = header.indexOf("acTL");
    const data = header.indexOf("IDAT");
    return control >= 0 && (data < 0 || control < data);
}

/** The pixel size of the edited image. */
export function croppedSize(crop: ImageCrop): { width: number; height: number } {
    const turned = turnedImageSize(crop);
    const kept = cropSize(crop);
    const width = Math.max(1, Math.round(Math.min(crop.maxOutputWidth, kept.width * turned.width)));
    return { width, height: Math.max(1, Math.round(width / crop.aspectRatio)) };
}

/**
 * Draw the kept part of an image, turned as asked. JPEG photos stay JPEG; anything else becomes PNG so
 * transparency survives.
 */
export async function renderImageCrop(image: CanvasImageSource, crop: ImageCrop, sourceType: string): Promise<Blob> {
    const turned = turnedImageSize(crop);
    const kept = cropSize(crop);
    const output = croppedSize(crop);
    const canvas = document.createElement("canvas");
    canvas.width = output.width;
    canvas.height = output.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is unavailable");
    context.imageSmoothingQuality = "high";

    // Work in the turned image's pixels, with the kept area's top-left corner at the canvas origin.
    const keptWidth = kept.width * turned.width;
    const keptHeight = kept.height * turned.height;
    context.scale(output.width / keptWidth, output.height / keptHeight);
    context.translate(-(crop.centreX * turned.width - keptWidth / 2), -(crop.centreY * turned.height - keptHeight / 2));
    // Then turn the stored image about the turned image's centre.
    context.translate(turned.width / 2, turned.height / 2);
    context.rotate((crop.rotation * Math.PI) / 2);
    context.drawImage(image, -crop.imageWidth / 2, -crop.imageHeight / 2, crop.imageWidth, crop.imageHeight);

    const type = sourceType === "image/jpeg" ? "image/jpeg" : "image/png";
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not encode image"))), type, 0.92);
    });
}

/** Name an edited file after the picked one, with the extension of its new format. */
export function croppedFileName(original: string, type: string): string {
    const base = original.replace(/\.[^.]+$/, "") || "image";
    return `${base}.${type === "image/jpeg" ? "jpg" : "png"}`;
}
