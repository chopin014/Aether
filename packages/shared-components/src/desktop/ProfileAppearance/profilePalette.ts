/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { useEffect, useState } from "react";

/** Side of the square an image is reduced to before its colours are counted. */
const SAMPLE_SIZE = 24;
/** Hue buckets: enough to tell a teal from a blue, few enough that small details do not win. */
const HUE_BUCKETS = 18;
/** Below this share of vivid pixels the image is treated as grey, and its average colour is used. */
const MIN_VIVID_SHARE = 0.06;

/** One sampled pixel as red, green and blue from 0 to 255. */
type Rgb = [number, number, number];

function toHsl([r, g, b]: Rgb): { h: number; s: number; l: number } {
    const [rn, gn, bn] = [r / 255, g / 255, b / 255];
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l };
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h: number;
    if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    return { h: h * 60, s, l };
}

function toHex(rgb: Rgb): string {
    return `#${rgb.map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The colour that best represents an image, as `#rrggbb`: the most common vivid hue, weighted towards saturated
 * mid-tones, rather than the muddy average of every pixel. A mostly grey image gives its average colour.
 *
 * @param pixels RGBA bytes, as `ImageData.data` holds them.
 * @returns undefined when no pixel is visible.
 */
export function representativeColour(pixels: ArrayLike<number>): string | undefined {
    const buckets = Array.from({ length: HUE_BUCKETS }, () => ({ weight: 0, sum: [0, 0, 0] as Rgb }));
    const average: Rgb = [0, 0, 0];
    let visible = 0;
    let vivid = 0;
    for (let i = 0; i + 3 < pixels.length; i += 4) {
        if (pixels[i + 3] < 128) continue;
        const rgb: Rgb = [pixels[i], pixels[i + 1], pixels[i + 2]];
        visible++;
        average[0] += rgb[0];
        average[1] += rgb[1];
        average[2] += rgb[2];
        const { h, s, l } = toHsl(rgb);
        // Near black, near white and grey pixels say little about an image's character.
        if (s < 0.25 || l < 0.12 || l > 0.9) continue;
        vivid++;
        const weight = s * (1 - Math.abs(l - 0.5) * 1.2);
        const bucket = buckets[Math.floor(h / (360 / HUE_BUCKETS)) % HUE_BUCKETS];
        bucket.weight += weight;
        bucket.sum[0] += rgb[0] * weight;
        bucket.sum[1] += rgb[1] * weight;
        bucket.sum[2] += rgb[2] * weight;
    }
    if (!visible) return undefined;
    if (vivid / visible < MIN_VIVID_SHARE) return toHex(average.map((channel) => channel / visible) as Rgb);
    const best = buckets.reduce((a, b) => (b.weight > a.weight ? b : a));
    return toHex(best.sum.map((channel) => channel / best.weight) as Rgb);
}

/**
 * The representative colour of an image at `url`, from {@link representativeColour}. Images a canvas may not read (a
 * media server without CORS headers) leave this undefined so the caller's fallback takes over.
 */
export function useImageColour(url: string | undefined, enabled = true): string | undefined {
    const [colour, setColour] = useState<{ url: string; value: string }>();
    useEffect(() => {
        if (!url || !enabled) return;
        let cancelled = false;
        const image = new Image();
        image.crossOrigin = "anonymous";
        image.onload = () => {
            if (cancelled) return;
            try {
                const canvas = document.createElement("canvas");
                canvas.width = canvas.height = SAMPLE_SIZE;
                const context = canvas.getContext("2d", { willReadFrequently: true });
                if (!context) return;
                context.drawImage(image, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
                const value = representativeColour(context.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data);
                if (value) setColour({ url, value });
            } catch {
                // A tainted canvas: the caller's fallback colour stays.
            }
        };
        image.src = url;
        return () => {
            cancelled = true;
        };
    }, [url, enabled]);
    // A colour found for an earlier image is never shown for the next one.
    return enabled && colour && colour.url === url ? colour.value : undefined;
}
