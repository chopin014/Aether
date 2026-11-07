/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/** Quarter turns clockwise. */
export type ImageCropRotation = 0 | 1 | 2 | 3;

/** What decides which part of an image is kept. */
export interface ImageCropFrame {
    /** Width of the image as stored, before turning. */
    imageWidth: number;
    /** Height of the image as stored, before turning. */
    imageHeight: number;
    rotation: ImageCropRotation;
    /** Width over height of the kept area. */
    aspectRatio: number;
    /** 1 shows as much of the image as fits the kept area; larger values show less. */
    zoom: number;
}

/** A width and height. */
export interface ImageCropSize {
    width: number;
    height: number;
}

/** Size of the image once turned. */
export function turnedImageSize(frame: ImageCropFrame): ImageCropSize {
    return frame.rotation % 2
        ? { width: frame.imageHeight, height: frame.imageWidth }
        : { width: frame.imageWidth, height: frame.imageHeight };
}

/**
 * Size of the kept area as fractions of the turned image. At zoom 1 the kept area covers the whole image along one
 * side, like a picture set to cover its box.
 */
export function cropSize(frame: ImageCropFrame): ImageCropSize {
    const turned = turnedImageSize(frame);
    const imageAspect = turned.width / turned.height;
    return {
        width: Math.min(1, frame.aspectRatio / imageAspect) / frame.zoom,
        height: Math.min(1, imageAspect / frame.aspectRatio) / frame.zoom,
    };
}

/** Move a centre, given as fractions of the turned image, so the kept area stays inside the image. */
export function clampCropCentre(frame: ImageCropFrame, centreX: number, centreY: number): { x: number; y: number } {
    const size = cropSize(frame);
    const clamp = (value: number, half: number): number => Math.min(1 - half, Math.max(half, value));
    return { x: clamp(centreX, size.width / 2), y: clamp(centreY, size.height / 2) };
}

/** A part of an image as fractions of its width and height, from its top-left corner. */
export interface ImageCropRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * The kept area as a rectangle of the image. Only meaningful for an unturned image: it describes framing that is
 * applied when the image is shown, which keeps an animated image moving.
 */
export function cropRect(frame: ImageCropFrame, centreX: number, centreY: number): ImageCropRect {
    const size = cropSize(frame);
    return { x: centreX - size.width / 2, y: centreY - size.height / 2, width: size.width, height: size.height };
}
