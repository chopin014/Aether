/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/*
 * Profile effects: animation drawn over a whole profile card. Like the nameplates they are pure functions of time, so
 * a still frame for reduced motion and the running animation always agree. Each opens with an intro (stars ignite,
 * confetti bursts, snow begins to fall) and then settles into a loop composed around the card's edges and banner,
 * leaving the middle, where people read, mostly clear.
 */

import { type ArtFrame, type ArtScene } from "./ArtCanvas";
import {
    clamp01,
    cycle,
    fbm,
    glow,
    makeLayer,
    mix,
    noise2,
    paintField,
    pulse,
    rgba,
    seeded,
    smoothstep,
    sparkle,
    star,
} from "./artKit";

const TAU = Math.PI * 2;

/** How far a point is into the card's edge band, from 1 at the edge to 0 in the middle. */
function edgeWeight(u: number, v: number): number {
    const side = Math.max(smoothstep(0.32, 0.02, u), smoothstep(0.68, 0.98, u));
    const top = smoothstep(0.3, 0.02, v);
    return Math.max(side, top);
}

/** Pick a position biased towards the edges and the banner, by trying a few and keeping the most edge-like. */
function edgePoint(random: () => number): [number, number] {
    let best: [number, number] = [random(), random()];
    let bestWeight = edgeWeight(...best);
    for (let i = 0; i < 3; i++) {
        const candidate: [number, number] = [random(), random()];
        const weight = edgeWeight(...candidate);
        if (weight > bestWeight) {
            best = candidate;
            bestWeight = weight;
        }
    }
    return best;
}

/**
 * Where a looping particle is in its life: progress in [0, 1), or null before it is first born. Births are spread over
 * the first period, so an effect fills in gradually as its intro rather than appearing all at once.
 */
function life(t: number, birth: number, period: number): number | null {
    if (t < birth) return null;
    return ((t - birth) / period) % 1;
}

// ---------------------------------------------------------------------------------------------------------------------

function starlight(seed: string): ArtScene {
    return {
        id: `stars:${seed}`,
        rest: 6,
        draw({ ctx, width: w, height: h, t }: ArtFrame) {
            const random = seeded(`stars${seed}`);
            ctx.save();
            ctx.globalCompositeOperation = "lighter";
            for (let i = 0; i < 60; i++) {
                const [u, v] = edgePoint(random);
                const x = u * w;
                const y = v * h - ((t * (2 + random() * 4)) % (h + 20)) * 0.05;
                // Stars ignite in a wave spreading out from the avatar, then twinkle on their own clocks.
                const ignite = smoothstep(0, 0.5, t - Math.hypot(u - 0.2, v - 0.18) * 1.6);
                const twinkle = 0.35 + 0.65 * pulse(t, 2 + random() * 3, random() * 9);
                const size = 0.5 + random() * random() * 1.6;
                const alpha = ignite * twinkle * (0.5 + random() * 0.5);
                if (random() > 0.72) sparkle(ctx, x, y, size * 3.2, random() > 0.5 ? "#cfe2ff" : "#ffe9c4", alpha, 0);
                else star(ctx, x, y, size, alpha, "#dfe8ff");
            }
            // A shooting star across the banner every few seconds.
            const p = cycle(t, 5.5, 2);
            if (t > 1 && p < 0.16) {
                const k = p / 0.16;
                const x = mix(w * 0.95, w * 0.25, k);
                const y = mix(h * 0.03, h * 0.2, k);
                const tail = ctx.createLinearGradient(x + 60, y - 18, x, y);
                tail.addColorStop(0, "rgb(220 235 255 / 0)");
                tail.addColorStop(1, `rgb(240 248 255 / ${0.9 * Math.sin(k * Math.PI)})`);
                ctx.strokeStyle = tail;
                ctx.lineWidth = 1.4;
                ctx.lineCap = "round";
                ctx.beginPath();
                ctx.moveTo(x + 60, y - 18);
                ctx.lineTo(x, y);
                ctx.stroke();
                glow(ctx, x, y, 8, "#eef4ff", 0.8 * Math.sin(k * Math.PI));
            }
            ctx.restore();
        },
    };
}

// ---------------------------------------------------------------------------------------------------------------------

function snow(seed: string): ArtScene {
    return {
        id: `snow:${seed}`,
        rest: 14,
        draw({ ctx, width: w, height: h, t }: ArtFrame) {
            const random = seeded(`snow${seed}`);
            // Three depths: far flakes are small and slow, near ones large, soft and quick.
            for (const [count, minSize, maxSize, speed, blur, alpha] of [
                [34, 0.6, 1.3, 22, 0, 0.75],
                [18, 1.4, 2.4, 38, 0, 0.85],
                [7, 3.5, 6, 70, 1, 0.45],
            ] as const) {
                for (let i = 0; i < count; i++) {
                    const period = (h + 40) / (speed * (0.8 + random() * 0.4));
                    const p = life(t, random() * period, period);
                    const x0 = random() * w;
                    const size = mix(minSize, maxSize, random());
                    const sway = Math.sin(t * (0.6 + random()) + i) * (6 + size * 2);
                    if (p === null) continue;
                    const x = x0 + sway + p * 20;
                    const y = -20 + p * (h + 40);
                    const a = alpha * smoothstep(0, 0.05, p) * smoothstep(1, 0.9, p);
                    if (blur) {
                        glow(ctx, x, y, size * 1.6, "#ffffff", a);
                    } else {
                        glow(ctx, x, y, size * 2.2, "#dbe9ff", a * 0.35);
                        ctx.fillStyle = rgba("#ffffff", a);
                        ctx.beginPath();
                        ctx.arc(x, y, size * 0.6, 0, TAU);
                        ctx.fill();
                    }
                }
            }
        },
    };
}

// ---------------------------------------------------------------------------------------------------------------------

function sakura(seed: string): ArtScene {
    return {
        id: `sakura:${seed}`,
        rest: 12,
        draw({ ctx, width: w, height: h, t }: ArtFrame) {
            const random = seeded(`sakura${seed}`);
            // One breeze moves every petal, gusting now and then.
            const gust = 0.6 + 0.4 * Math.sin(t * 0.4) + 0.5 * Math.max(0, Math.sin(t * 0.17 + 1)) ** 6;
            for (let i = 0; i < 30; i++) {
                const near = i < 6;
                const period = (near ? 4.5 : 7) + random() * 4;
                const p = life(t, random() * period, period);
                const startU = mix(0.2, 1.25, random());
                const flutterSpeed = 2 + random() * 3;
                const size = near ? 5 + random() * 3 : 2.4 + random() * 2.2;
                const spin = random() * TAU;
                if (p === null) continue;
                const x = startU * w - p * (w * 0.5) * gust + Math.sin(p * TAU * 2 + i) * 10;
                const y = -16 + p * (h + 32);
                const flip = Math.cos(t * flutterSpeed + i);
                const alpha = smoothstep(0, 0.06, p) * smoothstep(1, 0.88, p) * (near ? 0.55 : 0.9);
                ctx.save();
                ctx.translate(x, y);
                ctx.rotate(spin + t * 0.9);
                ctx.scale(Math.max(0.12, Math.abs(flip)), 1);
                if (near) ctx.filter = "blur(1.2px)";
                const fill = ctx.createLinearGradient(0, -size, 0, size);
                fill.addColorStop(0, rgba(flip > 0 ? "#ffd6e6" : "#ff9cc0", alpha));
                fill.addColorStop(1, rgba(flip > 0 ? "#ff9cc0" : "#e86d9b", alpha));
                ctx.fillStyle = fill;
                ctx.beginPath();
                // A petal with the small notch at its tip that marks a cherry blossom.
                ctx.moveTo(0, size);
                ctx.bezierCurveTo(size * 0.9, size * 0.4, size * 0.7, -size * 0.8, size * 0.15, -size);
                ctx.lineTo(0, -size * 0.8);
                ctx.lineTo(-size * 0.15, -size);
                ctx.bezierCurveTo(-size * 0.7, -size * 0.8, -size * 0.9, size * 0.4, 0, size);
                ctx.fill();
                ctx.restore();
            }
        },
    };
}

// ---------------------------------------------------------------------------------------------------------------------

function embers(seed: string): ArtScene {
    return {
        id: `embers:${seed}`,
        rest: 8,
        draw({ ctx, width: w, height: h, t }: ArtFrame) {
            const random = seeded(`embers${seed}`);
            ctx.save();
            ctx.globalCompositeOperation = "lighter";
            // Heat rising off the bottom edge.
            const heat = ctx.createLinearGradient(0, h, 0, h * 0.7);
            heat.addColorStop(0, `rgb(255 90 30 / ${(0.22 + 0.08 * pulse(t, 2.2)) * smoothstep(0, 1.2, t)})`);
            heat.addColorStop(1, "rgb(255 90 30 / 0)");
            ctx.fillStyle = heat;
            ctx.fillRect(0, h * 0.7, w, h * 0.3);
            for (let i = 0; i < 44; i++) {
                const period = 3 + random() * 3.5;
                // The intro is a burst: the first dozen sparks are all born at once.
                const birth = i < 12 ? 0 : random() * period;
                const p = life(t, birth, period);
                const x0 = random() * w;
                const wobble = 6 + random() * 14;
                const speed = 0.55 + random() * 0.5;
                const size = 0.6 + random() * 1.2;
                if (p === null) continue;
                const x = x0 + Math.sin(p * TAU * (1 + random()) + i) * wobble;
                const y = h + 6 - p * h * speed;
                const cooling = 1 - p;
                glow(ctx, x, y, size * 7, p < 0.3 ? "#ffd27a" : "#ff6a1f", 0.5 * cooling);
                ctx.fillStyle = rgba("#fff3d0", cooling * (0.5 + 0.5 * pulse(t, 0.3 + random() * 0.4, i)));
                ctx.beginPath();
                ctx.arc(x, y, size * 0.6, 0, TAU);
                ctx.fill();
            }
            ctx.restore();
        },
    };
}

// ---------------------------------------------------------------------------------------------------------------------

function fireflies(seed: string): ArtScene {
    return {
        id: `fireflies:${seed}`,
        rest: 5,
        draw({ ctx, width: w, height: h, t }: ArtFrame) {
            const random = seeded(`fireflies${seed}`);
            ctx.save();
            ctx.globalCompositeOperation = "lighter";
            for (let i = 0; i < 22; i++) {
                const [u, v] = edgePoint(random);
                const offset = random() * 100;
                const x = u * w + (fbm(t * 0.12, offset, 3, 2) - 0.5) * 90;
                const y = (0.35 + v * 0.65) * h + (fbm(offset, t * 0.12, 5, 2) - 0.5) * 70;
                const appear = smoothstep(0, 1.2, t - random() * 2);
                const light = appear * pulse(t, 2 + random() * 2.5, random() * 5);
                glow(ctx, x, y, 14, "#c8ff5a", 0.45 * light);
                glow(ctx, x, y, 4, "#f2ffb8", 0.9 * light);
            }
            ctx.restore();
        },
    };
}

// ---------------------------------------------------------------------------------------------------------------------

function rain(seed: string): ArtScene {
    return {
        id: `rain:${seed}`,
        rest: 2,
        draw({ ctx, width: w, height: h, t }: ArtFrame) {
            const random = seeded(`rain${seed}`);
            const slant = 0.18;
            ctx.lineCap = "round";
            for (let i = 0; i < 70; i++) {
                const depth = random();
                const period = (0.5 + (1 - depth) * 0.6) * (0.9 + random() * 0.2);
                const p = life(t, random() * period, period);
                const x0 = random() * (w + h * slant);
                const length = 8 + depth * 18;
                if (p === null) continue;
                const y = -length + p * (h + length * 2);
                const x = x0 - y * slant;
                const streak = ctx.createLinearGradient(x, y - length, x - length * slant, y);
                streak.addColorStop(0, "rgb(190 220 255 / 0)");
                streak.addColorStop(1, `rgb(210 230 255 / ${0.18 + depth * 0.35})`);
                ctx.strokeStyle = streak;
                ctx.lineWidth = 0.6 + depth * 0.8;
                ctx.beginPath();
                ctx.moveTo(x + length * slant, y - length);
                ctx.lineTo(x, y);
                ctx.stroke();
            }
            // Now and then lightning lights the whole card for a moment.
            const flash = cycle(t, 9, 6);
            if (flash < 0.03 || (flash > 0.045 && flash < 0.06)) {
                ctx.fillStyle = "rgb(200 220 255 / 0.12)";
                ctx.fillRect(0, 0, w, h);
            }
        },
    };
}

// ---------------------------------------------------------------------------------------------------------------------

let ray: HTMLCanvasElement | null | undefined;

function auroraRay(): HTMLCanvasElement | null {
    if (ray !== undefined) return ray;
    const layer = makeLayer(2, 128);
    if (layer) {
        const gradient = layer.ctx.createLinearGradient(0, 0, 0, 128);
        gradient.addColorStop(0, "rgb(170 110 255 / 0)");
        gradient.addColorStop(0.45, "rgb(170 110 255 / 0.35)");
        gradient.addColorStop(0.85, "rgb(70 255 185 / 0.9)");
        gradient.addColorStop(1, "rgb(210 255 235 / 0)");
        layer.ctx.fillStyle = gradient;
        layer.ctx.fillRect(0, 0, 2, 128);
    }
    ray = layer?.canvas ?? null;
    return ray;
}

function aurora(seed: string): ArtScene {
    return {
        id: `aurora:${seed}`,
        rest: 4,
        draw({ ctx, width: w, height: h, t }: ArtFrame) {
            const sprite = auroraRay();
            if (!sprite) return;
            const rise = smoothstep(0, 2.5, t);
            ctx.save();
            ctx.globalCompositeOperation = "lighter";
            for (const [phase, speed, foot, strength] of [
                [0, 0.5, 0.17, 0.85],
                [2.4, -0.35, 0.12, 0.5],
            ]) {
                for (let x = 0; x < w; x += 2) {
                    const u = x / w;
                    const wave =
                        Math.sin(u * 5 + t * speed + phase) * 0.05 + Math.sin(u * 13 - t * speed * 1.6) * 0.015;
                    const bottom = h * (foot + wave);
                    // Single-octave noise: rays are thin enough that finer detail would never show.
                    const tall = h * (0.12 + 0.12 * noise2(u * 4 + t * 0.08 * speed, phase, 2)) * rise;
                    const flicker = 0.5 + 0.5 * noise2(u * 14 + t * 0.5, phase + t * 0.15, 7);
                    ctx.globalAlpha = strength * flicker * 0.32;
                    ctx.drawImage(sprite, x, bottom - tall, 2.2, tall);
                }
            }
            ctx.restore();
        },
    };
}

// ---------------------------------------------------------------------------------------------------------------------

const CONFETTI = ["#ff5c8a", "#ffd45c", "#5cf2c8", "#7a8cff", "#ff9b5c", "#c77dff", "#8ed8ea"];

function confetti(seed: string): ArtScene {
    return {
        id: `confetti:${seed}`,
        rest: 1.4,
        draw({ ctx, width: w, height: h, t }: ArtFrame) {
            const random = seeded(`confetti${seed}`);
            const pieces: {
                x: number;
                y: number;
                turn: number;
                flip: number;
                colour: string;
                ribbon: boolean;
                alpha: number;
            }[] = [];
            // The intro: two cannons fire from the top corners, then pieces flutter down under drag.
            const drag = 2.2;
            const gravity = 160;
            for (let i = 0; i < 70; i++) {
                const left = i % 2 === 0;
                const angle = (left ? -0.35 : Math.PI + 0.35) + (random() - 0.5) * 0.9;
                const speed = 260 + random() * 260;
                const vx = Math.cos(angle) * speed;
                const vy = Math.sin(angle) * speed * 0.6 - 60;
                const decay = (1 - Math.exp(-drag * t)) / drag;
                const fall = (gravity / drag) * (t - decay);
                const x = (left ? -6 : w + 6) + vx * decay + Math.sin(t * 3 + i) * 8;
                const y = h * 0.04 + vy * decay + fall * 0.55;
                if (y > h + 20) continue;
                pieces.push({
                    x,
                    y,
                    turn: t * (3 + random() * 5) + i,
                    flip: Math.cos(t * (5 + random() * 6) + i),
                    colour: CONFETTI[i % CONFETTI.length],
                    ribbon: random() > 0.6,
                    alpha: smoothstep(0, 0.05, t),
                });
            }
            // Afterwards a light, steady trickle keeps the card festive.
            for (let i = 0; i < 18; i++) {
                const period = 5 + random() * 4;
                const p = life(t, 2 + random() * period, period);
                const x0 = random() * w;
                if (p === null) continue;
                pieces.push({
                    x: x0 + Math.sin(p * TAU + i) * 14,
                    y: -10 + p * (h + 20),
                    turn: t * 2 + i,
                    flip: Math.cos(t * 4 + i),
                    colour: CONFETTI[(i + 3) % CONFETTI.length],
                    ribbon: i % 3 === 0,
                    alpha: 0.75 * smoothstep(1, 0.9, p),
                });
            }
            for (const piece of pieces) {
                ctx.save();
                ctx.translate(piece.x, piece.y);
                ctx.rotate(piece.turn);
                ctx.scale(1, Math.max(0.15, Math.abs(piece.flip)));
                // The back of a piece is a shade darker, so the flip reads.
                ctx.fillStyle = rgba(piece.colour, piece.alpha * (piece.flip > 0 ? 1 : 0.7));
                if (piece.ribbon) ctx.fillRect(-1.2, -5, 2.4, 10);
                else ctx.fillRect(-2.8, -2.2, 5.6, 4.4);
                ctx.restore();
            }
        },
    };
}

// ---------------------------------------------------------------------------------------------------------------------

/** Comets on straight paths with tails trailing the motion, as they cross the sky on the Aether landing page. */
function comets(seed: string): ArtScene {
    return {
        id: `comets:${seed}`,
        rest: 2.4,
        draw(frame: ArtFrame) {
            const { ctx, width: w, height: h, t } = frame;
            const random = seeded(`comets${seed}`);
            ctx.save();
            ctx.globalCompositeOperation = "lighter";
            for (let i = 0; i < 26; i++) {
                const [u, v] = edgePoint(random);
                star(
                    ctx,
                    u * w,
                    v * h,
                    0.5 + random() * 0.8,
                    smoothstep(0, 1, t - random()) * (0.3 + 0.5 * pulse(t, 3 + random() * 3, i)),
                );
            }
            for (let i = 0; i < 3; i++) {
                const period = 4.2 + i * 1.3;
                const p = cycle(t, period, i * 1.7 - 0.6);
                if (p > 0.45) continue;
                const k = p / 0.45;
                const fromX = w * (1.1 + random() * 0.2);
                const fromY = h * (random() * 0.35 - 0.1);
                const toX = -w * 0.2;
                const toY = fromY + h * (0.35 + random() * 0.3);
                const x = mix(fromX, toX, k);
                const y = mix(fromY, toY, k);
                const angle = Math.atan2(toY - fromY, toX - fromX);
                const length = 90 + i * 30;
                const tx = x - Math.cos(angle) * length;
                const ty = y - Math.sin(angle) * length;
                const fade = Math.sin(k * Math.PI);
                const colour = ["#8ed8ea", "#f2c6a0", "#eceaf6"][i];
                // The tail widens and fades away from the head.
                ctx.fillStyle = (() => {
                    const g = ctx.createLinearGradient(tx, ty, x, y);
                    g.addColorStop(0, rgba(colour, 0));
                    g.addColorStop(1, rgba(colour, 0.55 * fade));
                    return g;
                })();
                const nx = -Math.sin(angle);
                const ny = Math.cos(angle);
                ctx.beginPath();
                ctx.moveTo(x + nx * 1.6, y + ny * 1.6);
                ctx.lineTo(tx + nx * 6, ty + ny * 6);
                ctx.lineTo(tx - nx * 6, ty - ny * 6);
                ctx.lineTo(x - nx * 1.6, y - ny * 1.6);
                ctx.fill();
                glow(ctx, x, y, 14, colour, 0.75 * fade);
                glow(ctx, x, y, 4, "#ffffff", fade);
            }
            ctx.restore();
        },
    };
}

// ---------------------------------------------------------------------------------------------------------------------

/** Nebula drifting around the card's frame, in the Aether palette. */
function nebula(seed: string): ArtScene {
    return {
        id: `nebula:${seed}`,
        rest: 3,
        draw({ ctx, width: w, height: h, t, bake }: ArtFrame) {
            const field = bake("field", (c, cw, ch) => {
                const layer = paintField(
                    cw,
                    ch,
                    (u, v, n) => {
                        const edge = edgeWeight(u, v);
                        const warp = fbm(u * 4 + n * 2, v * 4 + n, 31, 3);
                        const dens = smoothstep(0.42, 0.8, n * 0.6 + warp * 0.5) * edge;
                        if (dens < 0.02) return null;
                        const teal = smoothstep(0.4, 0.7, warp);
                        const r = mix(mix(40, 30, teal), 150, smoothstep(0.5, 0.8, n) * 0.6);
                        const g = mix(mix(70, 170, teal), 60, smoothstep(0.5, 0.8, n) * 0.6);
                        const b = mix(210, 200, teal);
                        return [r, g, b, 255 * clamp01(dens * 1.2)];
                    },
                    { seed: 12, scale: 2.4, resolution: 0.5, softness: 1.5 },
                );
                if (layer) c.drawImage(layer, 0, 0, cw, ch);
            });
            const fade = smoothstep(0, 2, t);
            if (field) {
                ctx.save();
                ctx.globalCompositeOperation = "screen";
                ctx.globalAlpha = 0.55 * fade;
                ctx.drawImage(field, Math.sin(t * 0.12) * 12, Math.cos(t * 0.1) * 8, w, h);
                ctx.globalAlpha = 0.3 * fade;
                ctx.drawImage(field, -w * 0.05 + Math.cos(t * 0.08) * 16, -h * 0.03, w * 1.1, h * 1.06);
                ctx.restore();
            }
            const random = seeded(`nebula${seed}`);
            ctx.save();
            ctx.globalCompositeOperation = "lighter";
            for (let i = 0; i < 30; i++) {
                const [u, v] = edgePoint(random);
                star(
                    ctx,
                    u * w,
                    v * h,
                    0.5 + random() * 1.1,
                    fade * (0.3 + 0.6 * pulse(t, 2 + random() * 4, i)),
                    "#d6e8ff",
                );
            }
            ctx.restore();
        },
    };
}

const FACTORIES = {
    stars: starlight,
    snow,
    sakura,
    embers,
    fireflies,
    rain,
    aurora,
    confetti,
    comets,
    nebula,
} satisfies Record<string, (seed: string) => ArtScene>;

/** Every profile effect, by its identifier. */
export type EffectSceneId = keyof typeof FACTORIES;

const scenes = new Map<string, ArtScene>();

/** The scene for a profile effect. The seed varies the layout from person to person but keeps each person's stable. */
export function effectScene(id: EffectSceneId, seed: string): ArtScene {
    const key = `${id}:${seed}`;
    let scene = scenes.get(key);
    if (!scene) {
        const inner = FACTORIES[id](seed);
        // Nothing shows before the effect starts, while the card is still landing.
        scene = {
            ...inner,
            draw: (frame) => {
                if (frame.t >= 0) inner.draw(frame);
            },
        };
        if (scenes.size > 64) scenes.clear();
        scenes.set(key, scene);
    }
    return scene;
}
