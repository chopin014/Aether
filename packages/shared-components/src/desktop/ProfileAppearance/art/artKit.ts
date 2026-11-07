/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/*
 * Small drawing kit for Aether's procedural artwork: seeded randomness, smooth noise, and the light primitives
 * (glows, round stars, sparkles) every scene is built from. Everything draws with the 2D canvas API, so artwork works
 * wherever the app does and never needs a download.
 */

/** A drawing surface. Offscreen canvases are used to bake layers once and reuse them. */
export type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** A small repeatable random sequence in [0, 1), so artwork looks the same every time it is drawn. */
export function seeded(seed: number | string): () => number {
    let state = 0;
    if (typeof seed === "number") state = seed | 0;
    else for (const char of seed) state = (Math.imul(state, 31) + (char.codePointAt(0) ?? 0)) | 0;
    return () => {
        state = (state + 0x6d2b79f5) | 0;
        let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
        mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
        return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
    };
}

function hash2(x: number, y: number, seed: number): number {
    let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 2147483647);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const smooth = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

/** The slope of the gradient noise at a lattice point, dotted with the offset from it. */
function slope(xi: number, yi: number, seed: number, dx: number, dy: number): number {
    const angle = hash2(xi, yi, seed) * Math.PI * 2;
    return Math.cos(angle) * dx + Math.sin(angle) * dy;
}

/**
 * Smooth gradient noise in [0, 1]. Gradient rather than value noise, because value noise shows its square lattice
 * once mist or cloud is cut from it with a threshold.
 */
export function noise2(x: number, y: number, seed = 0): number {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fx = x - xi;
    const fy = y - yi;
    const u = smooth(fx);
    const v = smooth(fy);
    const a = slope(xi, yi, seed, fx, fy);
    const b = slope(xi + 1, yi, seed, fx - 1, fy);
    const c = slope(xi, yi + 1, seed, fx, fy - 1);
    const d = slope(xi + 1, yi + 1, seed, fx - 1, fy - 1);
    const value = a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
    // Two-dimensional gradient noise stays within ±0.71; this maps it onto [0, 1].
    return Math.min(1, Math.max(0, value * 0.7 + 0.5));
}

/** Fractal noise in roughly [0, 1]: several octaves of {@link noise2}, each finer and fainter. */
export function fbm(x: number, y: number, seed = 0, octaves = 5): number {
    let sum = 0;
    let amplitude = 0.5;
    let total = 0;
    for (let octave = 0; octave < octaves; octave++) {
        sum += amplitude * noise2(x, y, seed + octave * 17);
        total += amplitude;
        x = x * 2.03 + 1.7;
        y = y * 2.03 + 9.2;
        amplitude *= 0.5;
    }
    return sum / total;
}

/** Linear interpolation. */
export const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
/** Clamp to [0, 1]. */
export const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
/** Hermite step between two edges, as in GLSL. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
    const t = clamp01((x - edge0) / (edge1 - edge0));
    return t * t * (3 - 2 * t);
}

/** `rgb(r g b / a)` from a `#rrggbb` colour. */
export function rgba(hex: string, alpha: number): string {
    const value = Number.parseInt(hex.slice(1), 16);
    return `rgb(${(value >> 16) & 255} ${(value >> 8) & 255} ${value & 255} / ${alpha})`;
}

/** A soft round light that fades to nothing at `radius`. */
export function glow(ctx: Ctx, x: number, y: number, radius: number, colour: string, alpha = 1): void {
    if (radius <= 0 || alpha <= 0) return;
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, rgba(colour, alpha));
    gradient.addColorStop(0.25, rgba(colour, alpha * 0.45));
    gradient.addColorStop(0.6, rgba(colour, alpha * 0.1));
    gradient.addColorStop(1, rgba(colour, 0));
    ctx.fillStyle = gradient;
    ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
}

/**
 * A round star as a real lens sees it: a bright core and a halo. Bright ones also get faint diffraction spikes.
 * @param brightness 0 to 1.
 */
export function star(ctx: Ctx, x: number, y: number, size: number, brightness: number, tint = "#eef2ff"): void {
    if (brightness <= 0) return;
    glow(ctx, x, y, size * 4.5, tint, 0.35 * brightness);
    // The core stays bright as a star dims, until it is nearly out, when it fades with it.
    ctx.fillStyle = rgba("#ffffff", Math.min(1, 0.55 + brightness * 0.45) * Math.min(1, brightness * 4));
    ctx.beginPath();
    ctx.arc(x, y, size * 0.55, 0, Math.PI * 2);
    ctx.fill();
    if (brightness > 0.75 && size > 0.9) spikes(ctx, x, y, size * 7 * brightness, tint, 0.5 * brightness);
}

/** Thin cross-shaped spikes, the mark of a very bright point of light. */
export function spikes(ctx: Ctx, x: number, y: number, length: number, colour: string, alpha: number): void {
    for (const [dx, dy] of [
        [1, 0],
        [0, 1],
    ]) {
        const gradient = ctx.createLinearGradient(x - dx * length, y - dy * length, x + dx * length, y + dy * length);
        gradient.addColorStop(0, rgba(colour, 0));
        gradient.addColorStop(0.5, rgba(colour, alpha));
        gradient.addColorStop(1, rgba(colour, 0));
        ctx.fillStyle = gradient;
        if (dx) ctx.fillRect(x - length, y - 0.35, length * 2, 0.7);
        else ctx.fillRect(x - 0.35, y - length, 0.7, length * 2);
    }
}

/** A four-pointed sparkle, sharper than a star, for glints and magic. */
export function sparkle(ctx: Ctx, x: number, y: number, size: number, colour: string, alpha: number, turn = 0): void {
    if (alpha <= 0 || size <= 0) return;
    glow(ctx, x, y, size * 2.2, colour, alpha * 0.4);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(turn);
    ctx.fillStyle = rgba("#ffffff", alpha);
    ctx.beginPath();
    const waist = size * 0.16;
    ctx.moveTo(0, -size);
    ctx.quadraticCurveTo(waist, -waist, size, 0);
    ctx.quadraticCurveTo(waist, waist, 0, size);
    ctx.quadraticCurveTo(-waist, waist, -size, 0);
    ctx.quadraticCurveTo(-waist, -waist, 0, -size);
    ctx.fill();
    ctx.restore();
}

/** A vertical gradient filling the whole surface. */
export function sky(ctx: Ctx, width: number, height: number, stops: [number, string][]): void {
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    for (const [offset, colour] of stops) gradient.addColorStop(offset, colour);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
}

/** Make a canvas to bake a layer into. */
export function makeLayer(
    width: number,
    height: number,
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    const ctx = canvas.getContext("2d");
    return ctx ? { canvas, ctx } : null;
}

/**
 * Paint a field of fractal noise into a layer, one colour per pixel. Used for nebulae, mist and clouds, which are then
 * moved and blended rather than recomputed every frame.
 *
 * @param shade Returns the colour and opacity for a pixel from its position in [0, 1] and the noise value there, or
 *     null to leave it clear.
 * @param resolution Pixels of noise per pixel of layer; lower is faster and softer.
 */
export function paintField(
    width: number,
    height: number,
    shade: (u: number, v: number, n: number) => [number, number, number, number] | null,
    { scale = 3, seed = 1, octaves = 5, resolution = 1, softness = 0.8 } = {},
): HTMLCanvasElement | null {
    const w = Math.max(1, Math.round(width * resolution));
    const h = Math.max(1, Math.round(height * resolution));
    const small = makeLayer(w, h);
    if (!small) return null;
    const image = small.ctx.createImageData(w, h);
    const aspect = width / height;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const u = x / w;
            const v = y / h;
            const colour = shade(u, v, fbm(u * scale * aspect, v * scale, seed, octaves));
            if (!colour) continue;
            const i = (y * w + x) * 4;
            image.data[i] = colour[0];
            image.data[i + 1] = colour[1];
            image.data[i + 2] = colour[2];
            image.data[i + 3] = colour[3];
        }
    }
    small.ctx.putImageData(image, 0, 0);
    const full = makeLayer(width, height);
    if (!full) return null;
    // A slight blur hides the noise's grid, so mist reads as vapour rather than pixels.
    full.ctx.filter = `blur(${softness / resolution}px)`;
    full.ctx.imageSmoothingQuality = "high";
    full.ctx.drawImage(small.canvas, 0, 0, full.canvas.width, full.canvas.height);
    return full.canvas;
}

/** Fine film grain, which keeps large gradients from banding and gives the art a printed feel. */
export function grain(ctx: Ctx, width: number, height: number, amount = 0.05, seed = 7): void {
    const layer = makeLayer(width, height);
    if (!layer) return;
    const random = seeded(seed);
    const image = layer.ctx.createImageData(layer.canvas.width, layer.canvas.height);
    for (let i = 0; i < image.data.length; i += 4) {
        const value = random() * 255;
        image.data[i] = image.data[i + 1] = image.data[i + 2] = value;
        image.data[i + 3] = 255 * amount;
    }
    layer.ctx.putImageData(image, 0, 0);
    ctx.save();
    ctx.globalCompositeOperation = "overlay";
    ctx.drawImage(layer.canvas, 0, 0, width, height);
    ctx.restore();
}

/** Repeat `period` seconds, returning progress in [0, 1). */
export const cycle = (t: number, period: number, offset = 0): number => ((((t + offset) / period) % 1) + 1) % 1;

/** 0 → 1 → 0 over a cycle, eased, for twinkles and pulses. */
export const pulse = (t: number, period: number, offset = 0): number =>
    0.5 - 0.5 * Math.cos(cycle(t, period, offset) * Math.PI * 2);
