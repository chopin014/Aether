/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/*
 * Aether's nameplates: small illustrated scenes drawn behind a name in the member list. Each is composed towards the
 * right edge, where the name never reaches, and painted procedurally: skies, nebulae and mist come from fractal noise
 * baked once, and only light and motion are drawn per frame.
 */

import { type ArtFrame, type ArtScene } from "./ArtCanvas";
import {
    clamp01,
    cycle,
    fbm,
    glow,
    grain,
    makeLayer,
    mix,
    paintField,
    pulse,
    rgba,
    seeded,
    sky,
    smoothstep,
    sparkle,
    star,
    type Ctx,
} from "./artKit";

const TAU = Math.PI * 2;

/** Seeded stars spread over the right part of a scene, each with its own twinkle. */
function starfield(
    { ctx, width, height, t }: ArtFrame,
    seed: number,
    count: number,
    { from = 0.25, top = 0, bottom = 1, tint = "#e8eeff", sizeBoost = 1 } = {},
): void {
    const random = seeded(seed);
    for (let i = 0; i < count; i++) {
        const x = mix(from, 1, random()) * width;
        const y = mix(top, bottom, random()) * height;
        const size = (0.35 + random() * random() * 1.1) * sizeBoost;
        const period = 1.6 + random() * 3;
        const offset = random() * 10;
        const base = 0.25 + random() * 0.6;
        const twinkle = base * (0.45 + 0.55 * pulse(t, period, offset));
        star(ctx, x, y, size, twinkle, tint);
    }
}

/** A comet on a straight path with its tail trailing the motion, as on the Aether landing page. */
function comet(
    ctx: Ctx,
    t: number,
    {
        period,
        from,
        to,
        length,
        colour,
        offset = 0,
    }: {
        period: number;
        from: [number, number];
        to: [number, number];
        length: number;
        colour: string;
        offset?: number;
    },
): void {
    const p = cycle(t, period, offset);
    // Visible for the first fifth of each period, quick in and quick out.
    const travel = p / 0.2;
    if (travel >= 1) return;
    const fade = Math.sin(travel * Math.PI);
    const x = mix(from[0], to[0], travel);
    const y = mix(from[1], to[1], travel);
    const angle = Math.atan2(to[1] - from[1], to[0] - from[0]);
    const tailX = x - Math.cos(angle) * length;
    const tailY = y - Math.sin(angle) * length;
    const gradient = ctx.createLinearGradient(tailX, tailY, x, y);
    gradient.addColorStop(0, rgba(colour, 0));
    gradient.addColorStop(1, rgba(colour, 0.85 * fade));
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.strokeStyle = gradient;
    ctx.lineCap = "round";
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.moveTo(tailX, tailY);
    ctx.lineTo(x, y);
    ctx.stroke();
    glow(ctx, x, y, 5, colour, 0.8 * fade);
    ctx.restore();
}

/** A lit sphere: light from the upper left, a soft terminator and a darkened limb. */
function sphere(ctx: Ctx, x: number, y: number, r: number, light: string, mid: string, dark: string): void {
    const gradient = ctx.createRadialGradient(x - r * 0.45, y - r * 0.5, r * 0.1, x, y, r * 1.05);
    gradient.addColorStop(0, light);
    gradient.addColorStop(0.55, mid);
    gradient.addColorStop(1, dark);
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
}

/** Fill a layer with noise-shaped mist or cloud in one colour. */
function mistLayer(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    colour: [number, number, number],
    {
        seed,
        scale,
        low,
        high,
        alpha,
        band,
    }: {
        seed: number;
        scale: number;
        low: number;
        high: number;
        alpha: number;
        /** Vertical weighting from a position in [0, 1]. */
        band: (v: number, u: number) => number;
    },
): void {
    const field = paintField(
        width,
        height,
        (u, v, n) => {
            const a = smoothstep(low, high, n) * band(v, u) * alpha;
            return a > 0.004 ? [colour[0], colour[1], colour[2], a * 255] : null;
        },
        { seed, scale, octaves: 4, softness: 1.4 },
    );
    if (field) ctx.drawImage(field, 0, 0, width, height);
}

// ---------------------------------------------------------------------------------------------------------------------

const moonlit: ArtScene = {
    id: "moonlit",
    rest: 2.2,
    draw(frame) {
        const { ctx, width: w, height: h, t, bake } = frame;
        const mx = w - 44;
        const my = h * 0.44;
        const r = h * 0.34;
        const base = bake("sky", (c, cw, ch) => {
            sky(c, cw, ch, [
                [0, "#060a24"],
                [0.6, "#121a4a"],
                [1, "#1d2a66"],
            ]);
            glow(c, cw - 40, ch * 0.42, ch * 2.1, "#7f93e6", 0.32);
            mistLayer(c, cw, ch, [120, 132, 214], {
                seed: 3,
                scale: 2.2,
                low: 0.45,
                high: 0.85,
                alpha: 0.18,
                band: (v) => 0.4 + v * 0.6,
            });
            grain(c, cw, ch, 0.06);
        });
        if (base) ctx.drawImage(base, 0, 0, w, h);
        starfield(frame, 11, 26, { from: 0.15, bottom: 0.75 });
        comet(ctx, t, { period: 7, offset: 3, from: [w - 10, 2], to: [w - 120, 26], length: 26, colour: "#dfe6ff" });

        const moon = bake("moon", (c) => {
            // A wide soft halo and a tighter bright one, as moonlight scatters in thin cloud.
            glow(c, mx, my, r * 5, "#8ea4f4", 0.3);
            glow(c, mx, my, r * 2.1, "#e4eaff", 0.55);
            sphere(c, mx, my, r, "#fdfdff", "#dfe4f7", "#9aa3d3");
            c.save();
            c.beginPath();
            c.arc(mx, my, r, 0, TAU);
            c.clip();
            // The dark seas, as soft noise-shaped patches rather than drawn circles.
            const seas = paintField(
                r * 2,
                r * 2,
                (u, v, n) => {
                    const a = smoothstep(0.5, 0.66, n);
                    return a > 0.01 ? [128, 136, 186, a * 150] : null;
                },
                { seed: 15, scale: 1.6, softness: 0.5 },
            );
            if (seas) c.drawImage(seas, mx - r, my - r, r * 2, r * 2);
            const random = seeded(5);
            for (let i = 0; i < 6; i++) {
                const a = random() * TAU;
                const d = Math.sqrt(random()) * r * 0.75;
                const cr = r * (0.05 + random() * 0.07);
                const cx = mx + Math.cos(a) * d;
                const cy = my + Math.sin(a) * d;
                c.strokeStyle = "rgb(255 255 255 / 0.5)";
                c.lineWidth = 0.4;
                c.beginPath();
                c.arc(cx, cy, cr, 0.2, Math.PI * 1.2);
                c.stroke();
                c.strokeStyle = "rgb(100 108 160 / 0.5)";
                c.beginPath();
                c.arc(cx, cy, cr, Math.PI * 1.2, Math.PI * 2.2);
                c.stroke();
            }
            // Earthshine on the shadowed limb.
            const shade = c.createLinearGradient(mx - r, my - r, mx + r, my + r);
            shade.addColorStop(0, "rgb(255 255 255 / 0)");
            shade.addColorStop(1, "rgb(40 48 110 / 0.45)");
            c.fillStyle = shade;
            c.fillRect(mx - r, my - r, r * 2, r * 2);
            c.restore();
        });
        if (moon) ctx.drawImage(moon, 0, 0, w, h);

        // Two banks of cloud drift past the moon at different speeds.
        for (const [key, seed, speed, top, colour, lit] of [
            ["far", 21, 0.35, 0.55, [52, 64, 138], "#8ea0f0"],
            ["near", 34, 0.6, 0.68, [28, 34, 86], "#6c7ad0"],
        ] as const) {
            const cloud = bake(`cloud-${key}`, (c, cw, ch) => {
                mistLayer(c, cw, ch, [...colour] as [number, number, number], {
                    seed,
                    scale: 3.4,
                    low: 0.42,
                    high: 0.62,
                    alpha: 0.95,
                    band: (v) => smoothstep(top - 0.12, top + 0.2, v),
                });
                // Rim light on the cloud tops, facing the moon.
                c.globalCompositeOperation = "source-atop";
                const rim = c.createLinearGradient(0, ch * (top - 0.1), 0, ch * (top + 0.15));
                rim.addColorStop(0, rgba(lit, 0.75));
                rim.addColorStop(1, rgba(lit, 0));
                c.fillStyle = rim;
                c.fillRect(0, 0, cw, ch);
                c.globalCompositeOperation = "source-over";
            });
            // Drawn a little wider than the row, so drifting never shows the layer's edge.
            if (cloud) ctx.drawImage(cloud, -w * 0.06 + Math.sin(t * speed * 0.35) * 8, 0, w * 1.12, h);
        }
    },
};

// ---------------------------------------------------------------------------------------------------------------------

/** A five-petalled blossom with notched petals and a golden centre. */
function blossom(ctx: Ctx, x: number, y: number, size: number, turn: number, tint: string): void {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(turn);
    for (let i = 0; i < 5; i++) {
        ctx.save();
        ctx.rotate((i / 5) * TAU);
        const petal = ctx.createLinearGradient(0, 0, 0, -size);
        petal.addColorStop(0, tint);
        petal.addColorStop(1, "#fff4f8");
        ctx.fillStyle = petal;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.bezierCurveTo(size * 0.55, -size * 0.3, size * 0.45, -size * 0.95, size * 0.12, -size);
        ctx.lineTo(0, -size * 0.86);
        ctx.lineTo(-size * 0.12, -size);
        ctx.bezierCurveTo(-size * 0.45, -size * 0.95, -size * 0.55, -size * 0.3, 0, 0);
        ctx.fill();
        ctx.restore();
    }
    glow(ctx, 0, 0, size * 0.55, "#ff6f9f", 0.5);
    ctx.fillStyle = "#ffd36e";
    for (let i = 0; i < 6; i++) {
        const a = (i / 6) * TAU + 0.3;
        ctx.beginPath();
        ctx.arc(Math.cos(a) * size * 0.28, Math.sin(a) * size * 0.28, size * 0.07, 0, TAU);
        ctx.fill();
    }
    ctx.restore();
}

/** A tapering branch that forks as it grows, returning where blossoms can sit. */
function growBranch(
    ctx: Ctx,
    random: () => number,
    x: number,
    y: number,
    angle: number,
    length: number,
    width: number,
    depth: number,
    tips: [number, number][],
): void {
    const bend = (random() - 0.5) * 0.6;
    const ex = x + Math.cos(angle) * length;
    const ey = y + Math.sin(angle) * length;
    const cx = x + Math.cos(angle + bend) * length * 0.5;
    const cy = y + Math.sin(angle + bend) * length * 0.5;
    ctx.strokeStyle = "#2a1219";
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(cx, cy, ex, ey);
    ctx.stroke();
    // A thin warm highlight along the upper edge of the bark.
    ctx.strokeStyle = "rgb(255 170 150 / 0.22)";
    ctx.lineWidth = Math.max(0.4, width * 0.25);
    ctx.beginPath();
    ctx.moveTo(x, y - width * 0.3);
    ctx.quadraticCurveTo(cx, cy - width * 0.3, ex, ey - width * 0.3);
    ctx.stroke();
    tips.push([ex, ey], [cx, cy]);
    if (depth <= 0) return;
    const forks = depth > 2 ? 2 : 1 + Math.round(random());
    for (let i = 0; i < forks; i++) {
        growBranch(
            ctx,
            random,
            ex,
            ey,
            angle + (random() - 0.5) * 1.1 + (i ? 0.45 : -0.2),
            length * (0.62 + random() * 0.15),
            width * 0.66,
            depth - 1,
            tips,
        );
    }
}

const blossomScene: ArtScene = {
    id: "blossom",
    rest: 1.4,
    draw(frame) {
        const { ctx, width: w, height: h, t, bake } = frame;
        const base = bake("sky", (c, cw, ch) => {
            sky(c, cw, ch, [
                [0, "#24102e"],
                [0.55, "#5c2350"],
                [1, "#c86a76"],
            ]);
            glow(c, cw - 70, ch * 1.05, ch * 1.8, "#ffb38a", 0.55);
            const random = seeded(8);
            // Out-of-focus lights in the distance.
            for (let i = 0; i < 16; i++) {
                const x = mix(0.35, 1, random()) * cw;
                const y = random() * ch;
                const size = 2 + random() * 6;
                c.fillStyle = rgba(random() > 0.5 ? "#ffc4dd" : "#ffd9a0", 0.08 + random() * 0.12);
                c.beginPath();
                c.arc(x, y, size, 0, TAU);
                c.fill();
            }
            grain(c, cw, ch, 0.05);
        });
        if (base) ctx.drawImage(base, 0, 0, w, h);

        const tree = bake("branch", (c, cw, ch) => {
            const random = seeded(19);
            const tips: [number, number][] = [];
            growBranch(c, random, cw + 4, -2, Math.PI * 0.86, ch * 0.75, 4.2, 3, tips);
            growBranch(c, random, cw + 6, ch * 0.55, Math.PI * 1.06, ch * 0.6, 3, 2, tips);
            for (const [x, y] of tips) {
                if (x < cw * 0.42) continue;
                const size = 2.6 + random() * 2.6;
                blossom(
                    c,
                    x + (random() - 0.5) * 4,
                    y + (random() - 0.5) * 4,
                    size,
                    random() * TAU,
                    random() > 0.4 ? "#ff8fb8" : "#ffb3cf",
                );
            }
        });
        if (tree) {
            // The branch sways from the corner it grows out of.
            ctx.save();
            ctx.translate(w, 0);
            ctx.rotate(Math.sin(t * 0.9) * 0.025);
            ctx.translate(-w, 0);
            ctx.drawImage(tree, 0, 0, w, h);
            ctx.restore();
        }

        // Petals fall on the breeze, turning over as they go.
        const random = seeded(31);
        for (let i = 0; i < 14; i++) {
            const period = 4 + random() * 3;
            const p = cycle(t, period, random() * period);
            const startX = mix(0.45, 1.05, random()) * w;
            const x = startX - p * (40 + random() * 30) + Math.sin(p * TAU * 1.5 + i) * 5;
            const y = -4 + p * (h + 8);
            const flip = Math.cos(t * (2 + random() * 2) + i);
            ctx.save();
            ctx.translate(x, y);
            ctx.rotate(t * 0.8 + i);
            ctx.scale(Math.max(0.15, Math.abs(flip)), 1);
            ctx.fillStyle = rgba(flip > 0 ? "#ffc1d8" : "#ff92b9", 0.9 * Math.sin(p * Math.PI));
            ctx.beginPath();
            ctx.ellipse(0, 0, 2.2, 1.4, 0, 0, TAU);
            ctx.fill();
            ctx.restore();
        }
    },
};

// ---------------------------------------------------------------------------------------------------------------------

/**
 * A rose seen from above: cupped petals laid on the golden angle, each darker at its base and lit on its curled rim,
 * closing into a tight bud at the centre.
 */
function rose(ctx: Ctx, x: number, y: number, r: number, turn: number): void {
    glow(ctx, x, y, r * 2.6, "#ff2f7a", 0.32);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(turn);
    // A soft shadow under the bloom lifts it off the background.
    ctx.fillStyle = "rgb(20 0 8 / 0.55)";
    ctx.beginPath();
    ctx.arc(r * 0.12, r * 0.16, r * 1.02, 0, TAU);
    ctx.fill();
    const petals = 22;
    for (let k = 0; k < petals; k++) {
        const progress = k / petals;
        const a = k * 2.39996;
        const reach = r * Math.pow(1 - progress, 0.75);
        const size = reach * (0.62 - progress * 0.18);
        const px = Math.cos(a) * (reach - size);
        const py = Math.sin(a) * (reach - size);
        const inner = progress > 0.55;
        const fill = ctx.createRadialGradient(
            px - Math.cos(a) * size * 0.6,
            py - Math.sin(a) * size * 0.6,
            0,
            px,
            py,
            size * 1.15,
        );
        fill.addColorStop(0, inner ? "#5c0623" : "#6d0a2c");
        fill.addColorStop(0.55, inner ? "#c2185b" : "#b3164f");
        fill.addColorStop(1, inner ? "#ff6fa3" : "#ea3f7c");
        ctx.fillStyle = fill;
        ctx.beginPath();
        ctx.ellipse(px, py, size, size * 0.86, a, 0, TAU);
        ctx.fill();
        // The rim curls back and catches the light from the upper left.
        const lit = 0.25 + 0.45 * Math.max(0, -Math.cos(a - 0.8));
        ctx.strokeStyle = `rgb(255 190 215 / ${lit})`;
        ctx.lineWidth = 0.55;
        ctx.beginPath();
        ctx.ellipse(px, py, size, size * 0.86, a, -1.1, 1.1);
        ctx.stroke();
    }
    ctx.fillStyle = "#3a0414";
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.08, 0, TAU);
    ctx.fill();
    ctx.restore();
}

function leaf(ctx: Ctx, x: number, y: number, size: number, angle: number): void {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    const fill = ctx.createLinearGradient(0, -size * 0.4, 0, size * 0.4);
    fill.addColorStop(0, "#3f8a55");
    fill.addColorStop(1, "#163d24");
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(size * 0.5, -size * 0.45, size, 0);
    ctx.quadraticCurveTo(size * 0.5, size * 0.45, 0, 0);
    ctx.fill();
    ctx.strokeStyle = "rgb(150 220 160 / 0.4)";
    ctx.lineWidth = 0.4;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(size * 0.9, 0);
    ctx.stroke();
    ctx.restore();
}

const roses: ArtScene = {
    id: "roses",
    rest: 0.9,
    draw(frame) {
        const { ctx, width: w, height: h, t, bake } = frame;
        const base = bake("velvet", (c, cw, ch) => {
            sky(c, cw, ch, [
                [0, "#14040c"],
                [1, "#2c0718"],
            ]);
            glow(c, cw - 46, ch * 0.5, ch * 1.9, "#a3124a", 0.45);
            mistLayer(c, cw, ch, [120, 18, 60], {
                seed: 12,
                scale: 4,
                low: 0.4,
                high: 0.8,
                alpha: 0.35,
                band: () => 1,
            });
            grain(c, cw, ch, 0.07);
        });
        if (base) ctx.drawImage(base, 0, 0, w, h);
        const bouquet = bake("roses", (c, cw, ch) => {
            c.strokeStyle = "#1d4a2b";
            c.lineWidth = 1.4;
            c.beginPath();
            c.moveTo(cw * 0.5, ch + 2);
            c.bezierCurveTo(cw * 0.66, ch * 0.4, cw * 0.82, ch * 1.05, cw + 4, ch * 0.2);
            c.stroke();
            for (const [u, v, s, a] of [
                [0.62, 0.62, 8, -0.6],
                [0.74, 0.86, 9, 0.5],
                [0.86, 0.3, 8, -2.4],
                [0.95, 0.85, 7, 0.9],
                [0.55, 0.92, 6, -0.3],
            ]) {
                leaf(c, cw * u, ch * v, s, a);
            }
            rose(c, cw - 40, ch * 0.52, ch * 0.33, 0.2);
            rose(c, cw - 82, ch * 0.7, ch * 0.22, 1.4);
            rose(c, cw - 10, ch * 0.2, ch * 0.2, 2.2);
        });
        if (bouquet) {
            const breathe = 1 + Math.sin(t * 1.4) * 0.008;
            ctx.save();
            ctx.translate(w - 40, h / 2);
            ctx.scale(breathe, breathe);
            ctx.translate(-(w - 40), -h / 2);
            ctx.drawImage(bouquet, 0, 0, w, h);
            ctx.restore();
        }
        // Gold dust drifting up through the light.
        const random = seeded(77);
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        for (let i = 0; i < 18; i++) {
            const period = 3 + random() * 3;
            const p = cycle(t, period, random() * period);
            const x = mix(0.4, 1, random()) * w + Math.sin(t + i) * 3;
            const y = h - p * h * 1.1;
            const alpha = Math.sin(p * Math.PI) * (0.4 + random() * 0.5);
            sparkle(ctx, x, y, 1 + random() * 1.6, "#ffd98a", alpha, t + i);
        }
        ctx.restore();
    },
};

// ---------------------------------------------------------------------------------------------------------------------

/** Emission nebula in the Aether palette, with warped clouds and dark dust lanes, after the landing page's sky. */
function paintNebula(c: CanvasRenderingContext2D, cw: number, ch: number, seed: number, strength: number): void {
    const teal = [24, 150, 175];
    const blue = [32, 64, 190];
    const violet = [128, 52, 196];
    const ice = [196, 236, 255];
    const field = paintField(
        cw,
        ch,
        (u, v, n) => {
            const warp = fbm(u * 5 + n * 2.2, v * 3 + n * 1.6, seed + 5, 4);
            const dens = smoothstep(0.42, 0.8, n * 0.7 + warp * 0.5);
            const region = smoothstep(0.1, 0.85, u);
            const emission = dens * dens * dens * region * strength;
            if (emission < 0.01) return null;
            const tealness = smoothstep(0.35, 0.7, warp);
            const violetness = smoothstep(0.45, 0.75, n);
            const colour = [0, 1, 2].map((i) => {
                let value = mix(blue[i], teal[i], tealness);
                value = mix(value, violet[i], violetness * 0.7);
                return mix(value, ice[i], Math.pow(dens, 4) * 0.55);
            });
            const dust = smoothstep(0.55, 0.8, fbm(u * 9, v * 6, seed + 9, 3)) * 0.7;
            return [colour[0], colour[1], colour[2], 255 * clamp01(emission * 1.25) * (1 - dust)];
        },
        { seed, scale: 2.2, softness: 1.2 },
    );
    if (field) {
        c.save();
        c.globalCompositeOperation = "lighter";
        c.drawImage(field, 0, 0, cw, ch);
        c.restore();
    }
}

const nebula: ArtScene = {
    id: "nebula",
    rest: 1.2,
    draw(frame) {
        const { ctx, width: w, height: h, t, bake } = frame;
        const far = bake("far", (c, cw, ch) => {
            sky(c, cw, ch, [
                [0, "#04050d"],
                [1, "#0a0c1e"],
            ]);
            paintNebula(c, cw, ch, 4, 1);
            grain(c, cw, ch, 0.05);
        });
        if (far) ctx.drawImage(far, 0, 0, w, h);
        const near = bake("near", (c, cw, ch) => paintNebula(c, cw * 1.2, ch, 9, 0.4));
        if (near) {
            ctx.save();
            ctx.globalCompositeOperation = "screen";
            ctx.globalAlpha = 0.6;
            ctx.drawImage(near, -w * 0.1 + Math.sin(t * 0.25) * 10, Math.cos(t * 0.2) * 2, w, h);
            ctx.restore();
        }
        starfield(frame, 41, 34, { from: 0.1 });
        star(ctx, w - 58, h * 0.36, 1.4, 0.75 + 0.25 * pulse(t, 2.6), "#cfe8ff");
        star(ctx, w - 18, h * 0.7, 1.2, 0.6 + 0.4 * pulse(t, 3.4, 1), "#ffd9f0");
        comet(ctx, t, {
            period: 6,
            offset: 1.5,
            from: [w * 0.95, h * 0.9],
            to: [w * 0.55, h * 0.05],
            length: 22,
            colour: "#8ed8ea",
        });
    },
};

// ---------------------------------------------------------------------------------------------------------------------

/** Mountain ridge from layered noise, filled to the bottom. */
function ridge(
    c: CanvasRenderingContext2D,
    cw: number,
    ch: number,
    {
        seed,
        base,
        height,
        roughness,
        colour,
        snow,
    }: {
        seed: number;
        base: number;
        height: number;
        roughness: number;
        colour: string;
        snow?: string;
    },
): void {
    const points: [number, number][] = [];
    for (let x = -2; x <= cw + 2; x += 2) {
        const n = fbm(x / (cw * roughness), seed * 0.37, seed, 4);
        points.push([x, ch * (base - n * height)]);
    }
    c.fillStyle = colour;
    c.beginPath();
    c.moveTo(-2, ch + 2);
    for (const [x, y] of points) c.lineTo(x, y);
    c.lineTo(cw + 2, ch + 2);
    c.fill();
    if (snow) {
        c.strokeStyle = snow;
        c.lineWidth = 0.8;
        c.beginPath();
        for (const [x, y] of points) c.lineTo(x, y + 0.4);
        c.stroke();
    }
}

let ray: HTMLCanvasElement | null | undefined;

/** One ray of an aurora: violet at its top, vivid green at its foot, where the light is brightest. */
function auroraRay(): HTMLCanvasElement | null {
    if (ray !== undefined) return ray;
    const layer = makeLayer(2, 64);
    if (layer) {
        const gradient = layer.ctx.createLinearGradient(0, 0, 0, 64);
        gradient.addColorStop(0, "rgb(160 100 255 / 0)");
        gradient.addColorStop(0.4, "rgb(160 100 255 / 0.4)");
        gradient.addColorStop(0.82, "rgb(70 255 185 / 1)");
        gradient.addColorStop(0.92, "rgb(210 255 235 / 0.9)");
        gradient.addColorStop(1, "rgb(210 255 235 / 0)");
        layer.ctx.fillStyle = gradient;
        layer.ctx.fillRect(0, 0, 2, 64);
    }
    ray = layer?.canvas ?? null;
    return ray;
}

const aurora: ArtScene = {
    id: "aurora",
    rest: 3.1,
    draw(frame) {
        const { ctx, width: w, height: h, t, bake } = frame;
        const base = bake("sky", (c, cw, ch) => {
            sky(c, cw, ch, [
                [0, "#020611"],
                [0.7, "#04192a"],
                [1, "#082c36"],
            ]);
            grain(c, cw, ch, 0.05);
        });
        if (base) ctx.drawImage(base, 0, 0, w, h);
        starfield(frame, 5, 24, { from: 0.1, bottom: 0.6 });

        // A curtain is hundreds of thin vertical rays whose foot follows a slow wave.
        const ray = auroraRay();
        if (ray) {
            ctx.save();
            ctx.globalCompositeOperation = "lighter";
            for (const [phase, speed, lift, strength] of [
                [0, 0.7, 0.2, 0.9],
                [2.1, -0.5, 0.05, 0.55],
            ]) {
                for (let x = w * 0.25; x < w + 2; x += 1.5) {
                    const u = x / w;
                    const wave = Math.sin(u * 7 + t * speed + phase) * 0.12 + Math.sin(u * 17 - t * speed * 1.7) * 0.04;
                    const foot = h * (0.55 + lift + wave);
                    const tall = h * (0.55 + 0.35 * fbm(u * 6 + t * 0.12 * speed, phase, 3, 3));
                    const flicker = 0.55 + 0.45 * fbm(u * 18 + t * 0.6, phase + t * 0.2, 9, 2);
                    ctx.globalAlpha = strength * flicker * smoothstep(0.2, 0.55, u) * 0.42;
                    ctx.drawImage(ray, x, foot - tall, 1.6, tall);
                }
            }
            ctx.restore();
        }
        const hills = bake("hills", (c, cw, ch) => {
            ridge(c, cw, ch, {
                seed: 3,
                base: 0.95,
                height: 0.5,
                roughness: 0.35,
                colour: "#0b2532",
                snow: "rgb(170 220 230 / 0.35)",
            });
            ridge(c, cw, ch, { seed: 8, base: 1.08, height: 0.42, roughness: 0.22, colour: "#040e15" });
        });
        if (hills) ctx.drawImage(hills, 0, 0, w, h);
    },
};

// ---------------------------------------------------------------------------------------------------------------------

const embers: ArtScene = {
    id: "embers",
    rest: 1.8,
    draw(frame) {
        const { ctx, width: w, height: h, t, bake } = frame;
        const base = bake("smoke", (c, cw, ch) => {
            sky(c, cw, ch, [
                [0, "#0e0505"],
                [1, "#2a0b06"],
            ]);
            mistLayer(c, cw, ch, [90, 40, 30], {
                seed: 6,
                scale: 3,
                low: 0.45,
                high: 0.8,
                alpha: 0.4,
                band: (v) => 1 - v * 0.4,
            });
            grain(c, cw, ch, 0.07);
        });
        if (base) ctx.drawImage(base, 0, 0, w, h);
        const heat = 0.75 + 0.25 * pulse(t, 2.4);
        glow(ctx, w - 50, h * 1.1, h * 1.6, "#ff5a1a", 0.55 * heat);
        const rock = bake("rock", (c, cw, ch) => {
            // A volcanic ridge whose crest is molten, lit from inside.
            const crest: [number, number][] = [];
            for (let x = -2; x <= cw + 2; x += 2) {
                const u = x / cw;
                const n = fbm(x / (cw * 0.22), 1.3, 4, 4);
                crest.push([x, ch * (1.02 - smoothstep(0.25, 1, u) * (0.32 + n * 0.38))]);
            }
            const body = c.createLinearGradient(0, ch * 0.4, 0, ch);
            body.addColorStop(0, "#2a0c06");
            body.addColorStop(1, "#0a0302");
            c.fillStyle = body;
            c.beginPath();
            c.moveTo(-2, ch + 2);
            for (const [x, y] of crest) c.lineTo(x, y);
            c.lineTo(cw + 2, ch + 2);
            c.fill();
            c.save();
            c.shadowColor = "#ff5a1a";
            c.shadowBlur = 8;
            const rim = c.createLinearGradient(cw * 0.3, 0, cw, 0);
            rim.addColorStop(0, "rgb(255 106 31 / 0)");
            rim.addColorStop(0.6, "rgb(255 120 40 / 0.9)");
            rim.addColorStop(1, "rgb(255 200 110 / 1)");
            c.strokeStyle = rim;
            c.lineWidth = 1.2;
            c.beginPath();
            for (const [x, y] of crest) c.lineTo(x, y + 0.6);
            c.stroke();
            c.restore();
            // Seams of lava running down the slope, glowing and thin.
            const random = seeded(14);
            c.save();
            c.beginPath();
            c.moveTo(-2, ch + 2);
            for (const [x, y] of crest) c.lineTo(x, y);
            c.lineTo(cw + 2, ch + 2);
            c.clip();
            for (let i = 0; i < 9; i++) {
                const index = Math.floor(mix(0.55, 1, random()) * (crest.length - 1));
                let [x, y] = crest[index];
                c.beginPath();
                c.moveTo(x, y);
                for (let s = 0; s < 5; s++) {
                    x += (random() - 0.5) * 4 - 1.5;
                    y += 2 + random() * 2.5;
                    c.lineTo(x, y);
                }
                c.shadowColor = "#ff6a1f";
                c.shadowBlur = 5;
                c.strokeStyle = "rgb(255 110 40 / 0.85)";
                c.lineWidth = 0.9;
                c.stroke();
                c.shadowBlur = 0;
                c.strokeStyle = "rgb(255 225 170 / 0.8)";
                c.lineWidth = 0.3;
                c.stroke();
            }
            c.restore();
        });
        if (rock) ctx.drawImage(rock, 0, 0, w, h);
        // Sparks rise and weave, white-hot when born and dull red as they cool.
        const random = seeded(23);
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        for (let i = 0; i < 30; i++) {
            const period = 2 + random() * 2.5;
            const p = cycle(t, period, random() * period);
            const x0 = mix(0.45, 1, random()) * w;
            const x = x0 + Math.sin(p * TAU * (1 + random()) + i) * (4 + random() * 6) - p * 10;
            const y = h + 2 - p * (h + 10) * (0.7 + random() * 0.4);
            const life = 1 - p;
            const size = 0.5 + random() * 0.9;
            glow(ctx, x, y, size * 6, p < 0.35 ? "#ffcf6a" : "#ff6a1f", 0.55 * life);
            ctx.fillStyle = rgba("#fff1c8", life);
            ctx.beginPath();
            ctx.arc(x, y, size * 0.6, 0, TAU);
            ctx.fill();
        }
        ctx.restore();
    },
};

// ---------------------------------------------------------------------------------------------------------------------

const tides: ArtScene = {
    id: "tides",
    rest: 0.6,
    draw(frame) {
        const { ctx, width: w, height: h, t, bake } = frame;
        const horizon = h * 0.46;
        const sunX = w - 52;
        const base = bake("sky", (c, cw, ch) => {
            sky(c, cw, ch * 0.46, [
                [0, "#0c1a3a"],
                [0.6, "#5a4a7a"],
                [1, "#f2c6a0"],
            ]);
            glow(c, cw - 52, ch * 0.46, ch * 1.4, "#ff9c8a", 0.55);
            const sun = c.createRadialGradient(cw - 52, ch * 0.46, 0, cw - 52, ch * 0.46, ch * 0.2);
            sun.addColorStop(0, "#fff6e0");
            sun.addColorStop(1, "#ffb38a");
            c.save();
            c.beginPath();
            c.rect(0, 0, cw, ch * 0.46);
            c.clip();
            c.fillStyle = sun;
            c.beginPath();
            c.arc(cw - 52, ch * 0.46, ch * 0.2, 0, TAU);
            c.fill();
            c.restore();
            const sea = c.createLinearGradient(0, ch * 0.46, 0, ch);
            sea.addColorStop(0, "#2c4a6e");
            sea.addColorStop(1, "#06172a");
            c.fillStyle = sea;
            c.fillRect(0, ch * 0.46, cw, ch);
            grain(c, cw, ch, 0.05);
        });
        if (base) ctx.drawImage(base, 0, 0, w, h);
        // The sun's path on the water: short glints that shimmer independently.
        const random = seeded(17);
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        for (let i = 0; i < 40; i++) {
            const v = random();
            const y = horizon + 1 + v * v * (h - horizon);
            const spread = 4 + v * 26;
            const x = sunX + (random() - 0.5) * spread * 2;
            const alpha = pulse(t, 0.8 + random() * 1.4, random() * 3) * (1 - v * 0.6);
            ctx.fillStyle = rgba("#ffe2c0", alpha * 0.85);
            ctx.fillRect(x, y, 1.5 + v * 5, 0.6 + v * 0.5);
        }
        ctx.restore();
        // Swells roll in towards the viewer, each nearer one darker and taller.
        for (let layer = 0; layer < 3; layer++) {
            const y0 = horizon + (h - horizon) * (0.35 + layer * 0.24);
            const amplitude = 1 + layer * 1.1;
            const speed = 0.6 + layer * 0.35;
            const colour = ["#1d3d63", "#123052", "#0a213c"][layer];
            ctx.fillStyle = colour;
            ctx.beginPath();
            ctx.moveTo(0, h);
            for (let x = 0; x <= w + 4; x += 4) {
                const y =
                    y0 +
                    Math.sin(x * 0.05 + t * speed + layer) * amplitude +
                    Math.sin(x * 0.11 - t * speed * 0.7) * amplitude * 0.4;
                ctx.lineTo(x, y);
            }
            ctx.lineTo(w, h);
            ctx.fill();
            // Foam where each swell crests.
            ctx.strokeStyle = rgba("#ffd9c0", 0.18 + layer * 0.06);
            ctx.lineWidth = 0.6;
            ctx.beginPath();
            for (let x = 0; x <= w + 4; x += 4) {
                const y =
                    y0 +
                    Math.sin(x * 0.05 + t * speed + layer) * amplitude +
                    Math.sin(x * 0.11 - t * speed * 0.7) * amplitude * 0.4;
                ctx.lineTo(x, y);
            }
            ctx.stroke();
        }
    },
};

// ---------------------------------------------------------------------------------------------------------------------

/** Right-angled traces from the right edge inwards, like a circuit board's routing. */
function traces(width: number, height: number): [number, number][][] {
    const random = seeded(29);
    const paths: [number, number][][] = [];
    for (let i = 0; i < 7; i++) {
        let x = width + 2;
        let y = Math.round((0.12 + random() * 0.76) * height);
        const path: [number, number][] = [[x, y]];
        while (x > width * 0.3) {
            x -= 12 + random() * 26;
            path.push([x, y]);
            if (random() > 0.45) {
                const dy = (random() > 0.5 ? 1 : -1) * (5 + random() * 9);
                const ny = Math.min(height - 4, Math.max(4, y + dy));
                x -= Math.abs(ny - y);
                y = ny;
                path.push([x, y]);
            }
        }
        paths.push(path);
    }
    return paths;
}

function pointAlong(path: [number, number][], p: number): [number, number] {
    const lengths = path.slice(1).map(([x, y], i) => Math.hypot(x - path[i][0], y - path[i][1]));
    let distance = p * lengths.reduce((a, b) => a + b, 0);
    for (let i = 0; i < lengths.length; i++) {
        if (distance <= lengths[i]) {
            const k = distance / lengths[i];
            return [mix(path[i][0], path[i + 1][0], k), mix(path[i][1], path[i + 1][1], k)];
        }
        distance -= lengths[i];
    }
    return path[path.length - 1];
}

const circuit: ArtScene = {
    id: "circuit",
    rest: 1.0,
    draw(frame) {
        const { ctx, width: w, height: h, t, bake } = frame;
        const paths = traces(w, h);
        const board = bake("board", (c, cw, ch) => {
            sky(c, cw, ch, [
                [0, "#03141a"],
                [1, "#062730"],
            ]);
            glow(c, cw - 30, ch * 0.5, ch * 1.6, "#1fbfa6", 0.22);
            c.fillStyle = "rgb(60 200 200 / 0.08)";
            for (let x = 0; x < cw; x += 6) for (let y = 3; y < ch; y += 6) c.fillRect(x, y, 0.8, 0.8);
            c.lineJoin = "round";
            for (const path of paths) {
                c.strokeStyle = "#0f4d58";
                c.lineWidth = 1.4;
                c.beginPath();
                path.forEach(([x, y]) => c.lineTo(x, y));
                c.stroke();
                const [ex, ey] = path[path.length - 1];
                c.fillStyle = "#06272e";
                c.strokeStyle = "#1a7c88";
                c.lineWidth = 0.9;
                c.beginPath();
                c.arc(ex, ey, 1.8, 0, TAU);
                c.fill();
                c.stroke();
            }
            // A chip with its pins, the heart of the board.
            const chipX = cw - 46;
            const chipY = ch * 0.5;
            c.fillStyle = "rgb(40 240 216 / 0.5)";
            for (let i = -3; i <= 3; i++) {
                c.fillRect(chipX - 9 + (i + 3) * 3, chipY - 11, 1, 3);
                c.fillRect(chipX - 9 + (i + 3) * 3, chipY + 8, 1, 3);
            }
            c.fillStyle = "#0a1e24";
            c.strokeStyle = "#28f0d8";
            c.lineWidth = 0.8;
            c.beginPath();
            c.roundRect(chipX - 11, chipY - 8, 22, 16, 2);
            c.fill();
            c.stroke();
            grain(c, cw, ch, 0.05);
        });
        if (board) ctx.drawImage(board, 0, 0, w, h);
        const core = 0.6 + 0.4 * pulse(t, 1.6);
        glow(ctx, w - 46, h * 0.5, 16, "#28f0d8", 0.45 * core);
        ctx.fillStyle = rgba("#9ffff0", 0.8 * core);
        ctx.fillRect(w - 50, h * 0.5 - 1, 8, 2);
        // Packets of light run along the traces, each leaving a short trail.
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        paths.forEach((path, i) => {
            const colour = i % 3 === 2 ? "#b45cff" : "#28f0d8";
            const p = cycle(t, 2.2 + i * 0.35, i * 0.7);
            for (let k = 0; k < 6; k++) {
                const q = p - k * 0.012;
                if (q < 0) break;
                const [x, y] = pointAlong(path, q);
                glow(ctx, x, y, k ? 3 : 6, colour, (1 - k / 6) * 0.9);
            }
        });
        ctx.restore();
    },
};

// ---------------------------------------------------------------------------------------------------------------------

const synthwave: ArtScene = {
    id: "synthwave",
    rest: 0.4,
    draw(frame) {
        const { ctx, width: w, height: h, t, bake } = frame;
        const horizon = h * 0.6;
        const sunX = w - 50;
        const base = bake("sky", (c, cw, ch) => {
            sky(c, cw, ch * 0.6, [
                [0, "#0d0124"],
                [0.55, "#3a0a5a"],
                [1, "#ff3fa4"],
            ]);
            glow(c, cw - 50, ch * 0.5, ch * 1.4, "#ff3fa4", 0.45);
            const random = seeded(3);
            for (let i = 0; i < 22; i++)
                star(c, mix(0.2, 1, random()) * cw, random() * ch * 0.35, 0.5 + random() * 0.6, 0.4 + random() * 0.5);
            // The striped sun, its lower half cut by widening bands.
            const radius = ch * 0.36;
            const cy = ch * 0.56;
            const sun = c.createLinearGradient(0, cy - radius, 0, cy + radius);
            sun.addColorStop(0, "#fff27a");
            sun.addColorStop(0.5, "#ff9a3c");
            sun.addColorStop(1, "#ff2f8e");
            c.save();
            c.beginPath();
            c.arc(cw - 50, cy, radius, 0, TAU);
            c.clip();
            c.fillStyle = sun;
            c.fillRect(cw - 50 - radius, cy - radius, radius * 2, radius * 2);
            c.globalCompositeOperation = "destination-out";
            for (let i = 0; i < 5; i++) {
                const y = cy + i * radius * 0.2;
                c.fillRect(cw - 50 - radius, y, radius * 2, 0.6 + i * 0.55);
            }
            c.restore();
            // Distant mountains with a neon rim.
            ridge(c, cw, ch, {
                seed: 5,
                base: 0.62,
                height: 0.3,
                roughness: 0.2,
                colour: "#1a0434",
                snow: "rgb(255 80 190 / 0.7)",
            });
        });
        if (base) ctx.drawImage(base, 0, 0, w, h);
        // The grid floor scrolls towards the viewer.
        ctx.fillStyle = "#0b0019";
        ctx.fillRect(0, horizon, w, h - horizon);
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, horizon, w, h - horizon);
        ctx.clip();
        ctx.strokeStyle = "#ff3fa4";
        ctx.shadowColor = "#ff3fa4";
        ctx.shadowBlur = 4;
        ctx.lineWidth = 0.7;
        const shift = cycle(t, 1.2);
        for (let i = 0; i < 9; i++) {
            const d = (i + shift) / 9;
            const y = horizon + (h - horizon) * d * d;
            ctx.globalAlpha = 0.25 + d * 0.75;
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(w, y);
            ctx.stroke();
        }
        ctx.globalAlpha = 0.8;
        for (let i = -14; i <= 14; i++) {
            ctx.beginPath();
            ctx.moveTo(sunX + i * 3, horizon);
            ctx.lineTo(sunX + i * 26, h + 2);
            ctx.stroke();
        }
        ctx.restore();
        const fade = ctx.createLinearGradient(0, horizon, 0, horizon + 6);
        fade.addColorStop(0, "rgb(255 63 164 / 0.55)");
        fade.addColorStop(1, "rgb(255 63 164 / 0)");
        ctx.fillStyle = fade;
        ctx.fillRect(0, horizon, w, 6);
    },
};

// ---------------------------------------------------------------------------------------------------------------------

/** The ringed Aether planet from the landing page, with a moon in the ring plane. */
const orbit: ArtScene = {
    id: "orbit",
    rest: 2.6,
    draw(frame) {
        const { ctx, width: w, height: h, t, bake } = frame;
        const px = w - 46;
        const py = h * 0.52;
        const r = h * 0.3;
        const tilt = -0.22;
        const base = bake("space", (c, cw, ch) => {
            sky(c, cw, ch, [
                [0, "#04050c"],
                [1, "#0b0e22"],
            ]);
            paintNebula(c, cw, ch, 21, 0.7);
            grain(c, cw, ch, 0.05);
        });
        if (base) ctx.drawImage(base, 0, 0, w, h);
        starfield(frame, 61, 26, { from: 0.1 });
        comet(ctx, t, {
            period: 8,
            offset: 5,
            from: [w * 0.62, -2],
            to: [w * 0.38, h * 0.7],
            length: 20,
            colour: "#eceaf6",
        });

        const rings = (c: Ctx, half: "back" | "front"): void => {
            c.save();
            c.translate(px, py);
            c.rotate(tilt);
            for (const [rx, width, colour, alpha] of [
                [r * 2.15, 2.2, "#8ed8ea", 0.75],
                [r * 1.85, 1.2, "#cfe9f6", 0.6],
                [r * 1.6, 2.6, "#8faef0", 0.45],
                [r * 2.35, 0.6, "#eceaf6", 0.5],
            ] as const) {
                c.strokeStyle = rgba(colour, alpha);
                c.lineWidth = width;
                c.beginPath();
                if (half === "back") c.ellipse(0, 0, rx, rx * 0.26, 0, Math.PI, TAU);
                else c.ellipse(0, 0, rx, rx * 0.26, 0, 0, Math.PI);
                c.stroke();
            }
            c.restore();
        };
        const planet = bake("planet", (c) => {
            glow(c, px, py, r * 3.6, "#8ed8ea", 0.28);
            rings(c, "back");
            sphere(c, px, py, r, "#f6f6fd", "#c9d2ee", "#5d6aa0");
            // Pale cloud bands, following the tilt.
            c.save();
            c.beginPath();
            c.arc(px, py, r, 0, TAU);
            c.clip();
            c.translate(px, py);
            c.rotate(tilt);
            for (let i = -5; i <= 5; i++) {
                c.fillStyle = rgba(i % 2 ? "#a9b6de" : "#eef0fb", 0.28);
                c.fillRect(-r, (i / 5) * r - 1, r * 2, 1.4 + Math.abs(Math.sin(i * 2.3)) * 1.6);
            }
            c.rotate(-tilt);
            const night = c.createRadialGradient(r * 0.6, r * 0.7, r * 0.2, r * 0.6, r * 0.7, r * 1.6);
            night.addColorStop(0, "rgb(10 12 40 / 0.65)");
            night.addColorStop(1, "rgb(10 12 40 / 0)");
            c.fillStyle = night;
            c.fillRect(-r, -r, r * 2, r * 2);
            c.restore();
            // A thin atmosphere on the lit edge.
            c.strokeStyle = "rgb(190 230 255 / 0.55)";
            c.lineWidth = 0.8;
            c.beginPath();
            c.arc(px, py, r + 0.2, Math.PI * 0.9, Math.PI * 1.7);
            c.stroke();
        });
        // The moon orbits in the ring plane, passing behind the planet.
        const angle = t * 0.5;
        const ox = Math.cos(angle) * r * 2.7;
        const oy = Math.sin(angle) * r * 2.7 * 0.26;
        const mx = px + ox * Math.cos(tilt) - oy * Math.sin(tilt);
        const my = py + ox * Math.sin(tilt) + oy * Math.cos(tilt);
        const behind = Math.sin(angle) < 0;
        const moon = (): void => sphere(ctx, mx, my, r * 0.18, "#f0f0f6", "#b8bccc", "#5c6078");
        if (behind) moon();
        if (planet) ctx.drawImage(planet, 0, 0, w, h);
        rings(ctx, "front");
        if (!behind) moon();
    },
};

// ---------------------------------------------------------------------------------------------------------------------

/** A black hole with its accretion disk lensed over the top, in the landing page's ice and teal. */
const singularity: ArtScene = {
    id: "singularity",
    rest: 0,
    draw(frame) {
        const { ctx, width: w, height: h, t, bake } = frame;
        const cx = w - 52;
        const cy = h * 0.5;
        const shadow = h * 0.24;
        const base = bake("space", (c, cw, ch) => {
            sky(c, cw, ch, [
                [0, "#020308"],
                [1, "#060814"],
            ]);
            glow(c, cw - 52, ch * 0.5, ch * 2.2, "#4fb6d6", 0.3);
            grain(c, cw, ch, 0.05);
        });
        if (base) ctx.drawImage(base, 0, 0, w, h);
        starfield(frame, 88, 30, { from: 0.1 });
        // The disk is drawn as streaks orbiting at their own speeds; the near side is brighter, as Doppler beaming
        // makes it.
        const random = seeded(52);
        const streaks: {
            radius: number;
            start: number;
            length: number;
            speed: number;
            colour: string;
            width: number;
        }[] = [];
        for (let i = 0; i < 70; i++) {
            const radius = shadow * (1.5 + random() * 2.6);
            streaks.push({
                radius,
                start: random() * TAU,
                length: 0.3 + random() * 1.2,
                speed: 2.6 / Math.sqrt(radius / shadow),
                colour: random() > 0.55 ? "#eef8ff" : random() > 0.4 ? "#8ed8ea" : "#5b8fe0",
                width: 0.4 + random() * 0.9,
            });
        }
        const disk = (half: "back" | "front"): void => {
            ctx.save();
            ctx.translate(cx, cy);
            ctx.rotate(-0.08);
            ctx.globalCompositeOperation = "lighter";
            for (const s of streaks) {
                const a0 = s.start + t * s.speed;
                ctx.strokeStyle = s.colour;
                ctx.lineWidth = s.width;
                ctx.beginPath();
                for (let k = 0; k <= 10; k++) {
                    const a = a0 + (k / 10) * s.length;
                    const front = Math.sin(a) > 0;
                    if ((half === "front") !== front) {
                        ctx.stroke();
                        ctx.beginPath();
                        continue;
                    }
                    const beam = 0.45 + 0.55 * (0.5 - 0.5 * Math.cos(a));
                    ctx.globalAlpha = 0.5 * beam;
                    ctx.lineTo(Math.cos(a) * s.radius, Math.sin(a) * s.radius * 0.2);
                }
                ctx.stroke();
            }
            ctx.restore();
        };
        disk("back");
        // The far side of the disk, bent over the top by gravity.
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        const arc = ctx.createLinearGradient(cx - shadow * 2, 0, cx + shadow * 2, 0);
        arc.addColorStop(0, "rgb(142 216 234 / 0.25)");
        arc.addColorStop(0.5, "rgb(236 248 255 / 0.85)");
        arc.addColorStop(1, "rgb(142 216 234 / 0.35)");
        ctx.strokeStyle = arc;
        for (const [rr, width] of [
            [1.55, 2.2],
            [1.75, 0.8],
        ]) {
            ctx.lineWidth = width;
            ctx.beginPath();
            ctx.ellipse(cx, cy, shadow * rr, shadow * rr * 0.92, 0, Math.PI * 1.04, Math.PI * 1.96);
            ctx.stroke();
        }
        ctx.restore();
        ctx.fillStyle = "#000000";
        ctx.beginPath();
        ctx.arc(cx, cy, shadow, 0, TAU);
        ctx.fill();
        // The photon ring, the thinnest and brightest circle of light.
        ctx.strokeStyle = rgba("#eef8ff", 0.7 + 0.3 * pulse(t, 3));
        ctx.lineWidth = 0.6;
        ctx.beginPath();
        ctx.arc(cx, cy, shadow * 1.04, 0, TAU);
        ctx.stroke();
        disk("front");
    },
};

// ---------------------------------------------------------------------------------------------------------------------

function pine(c: CanvasRenderingContext2D, x: number, base: number, height: number, colour: string): void {
    c.fillStyle = colour;
    const tiers = 4;
    for (let i = 0; i < tiers; i++) {
        const top = base - height + (i * height) / (tiers + 0.6);
        const bottom = top + height * 0.42;
        const spread = height * (0.16 + i * 0.07);
        c.beginPath();
        c.moveTo(x, top);
        c.lineTo(x + spread, bottom);
        c.lineTo(x - spread, bottom);
        c.fill();
    }
    c.fillRect(x - 0.6, base - height * 0.2, 1.2, height * 0.2);
}

const grove: ArtScene = {
    id: "grove",
    rest: 2.0,
    draw(frame) {
        const { ctx, width: w, height: h, t, bake } = frame;
        const forest = bake("forest", (c, cw, ch) => {
            sky(c, cw, ch, [
                [0, "#030d0a"],
                [1, "#0c2a20"],
            ]);
            glow(c, cw - 60, ch * 0.2, ch * 1.5, "#a7f0c9", 0.18);
            const random = seeded(9);
            for (const [count, colour, minH, maxH, baseY, mist] of [
                [16, "#12352a", 0.45, 0.7, 0.9, 0.5],
                [12, "#0a2219", 0.55, 0.9, 1.0, 0.35],
                [8, "#030c08", 0.75, 1.15, 1.08, 0],
            ] as const) {
                for (let i = 0; i < count; i++) {
                    pine(c, mix(0.2, 1.02, random()) * cw, ch * baseY, ch * mix(minH, maxH, random()), colour);
                }
                if (mist) {
                    mistLayer(c, cw, ch, [120, 170, 150], {
                        seed: count,
                        scale: 3,
                        low: 0.4,
                        high: 0.75,
                        alpha: mist * 0.5,
                        band: (v) => smoothstep(0.35, 0.95, v),
                    });
                }
            }
            grain(c, cw, ch, 0.06);
        });
        if (forest) ctx.drawImage(forest, 0, 0, w, h);
        // Fireflies wander on slow noise paths and pulse out of step with each other.
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        const random = seeded(64);
        for (let i = 0; i < 16; i++) {
            const seed = random() * 100;
            const x = mix(0.3, 1, random()) * w + (fbm(t * 0.15, seed, 3, 2) - 0.5) * 40;
            const y = mix(0.25, 0.95, random()) * h + (fbm(seed, t * 0.15, 4, 2) - 0.5) * 18;
            const light = pulse(t, 1.8 + random() * 2.2, random() * 4);
            glow(ctx, x, y, 7, "#c8ff5a", 0.55 * light);
            ctx.fillStyle = rgba("#f4ffd0", 0.3 + 0.7 * light);
            ctx.beginPath();
            ctx.arc(x, y, 0.7, 0, TAU);
            ctx.fill();
        }
        ctx.restore();
    },
};

/** Every built-in nameplate's scene. */
export const NAMEPLATE_SCENES = {
    moonlit,
    blossom: blossomScene,
    roses,
    nebula,
    aurora,
    embers,
    tides,
    circuit,
    synthwave,
    orbit,
    singularity,
    grove,
} satisfies Record<string, ArtScene>;
