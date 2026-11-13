/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";

import { type ArtScene } from "./ArtCanvas";
import { effectScene, type EffectSceneId } from "./effectScenes";
import { NAMEPLATE_SCENES } from "./nameplateScenes";
import { makeLayer } from "./artKit";

/** Draw a scene the way ArtCanvas does and report how much of the surface it painted. */
function paintedShare(scene: ArtScene, width: number, height: number, t: number): number {
    const layer = makeLayer(width, height)!;
    const cache = new Map<string, HTMLCanvasElement>();
    scene.draw({
        ctx: layer.ctx,
        width,
        height,
        t,
        bake: (key, paint) => {
            if (!cache.has(key)) {
                const baked = makeLayer(width, height)!;
                paint(baked.ctx, width, height);
                cache.set(key, baked.canvas);
            }
            return cache.get(key);
        },
    });
    const data = layer.ctx.getImageData(0, 0, width, height).data;
    let painted = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) painted++;
    return painted / (width * height);
}

describe("nameplate scenes", () => {
    it.each(Object.entries(NAMEPLATE_SCENES))("%s fills the row at rest and while moving", (_id, scene) => {
        expect(paintedShare(scene, 230, 44, scene.rest)).toBeGreaterThan(0.95);
        expect(paintedShare(scene, 230, 44, scene.rest + 1.7)).toBeGreaterThan(0.95);
    });
});

describe("profile effects", () => {
    const ids: EffectSceneId[] = [
        "stars",
        "snow",
        "sakura",
        "embers",
        "fireflies",
        "rain",
        "aurora",
        "confetti",
        "comets",
        "nebula",
    ];

    it.each(ids)("%s draws something at rest, but leaves most of the card clear", (id) => {
        const share = paintedShare(effectScene(id, "@robin:example.org"), 170, 280, effectScene(id, "x").rest);
        expect(share).toBeGreaterThan(0);
        // The rain card and the nebula frame reach further, but nothing may cover the card outright.
        expect(share).toBeLessThan(0.9);
    });

    it.each(ids)("%s waits for the card to land before it starts", (id) => {
        expect(paintedShare(effectScene(id, "@robin:example.org"), 170, 280, -0.5)).toBeLessThan(0.02);
    });

    it("keeps each person's layout stable and varies it between people", () => {
        expect(effectScene("stars", "@a:example.org")).toBe(effectScene("stars", "@a:example.org"));
        expect(effectScene("stars", "@a:example.org")).not.toBe(effectScene("stars", "@b:example.org"));
    });
});
