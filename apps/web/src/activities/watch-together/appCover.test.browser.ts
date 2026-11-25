/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { appPaintsOver, floatingUiOver, samplePoints } from "./appCover";

/** A call stage like the real one: a tile with a background, the rounded player layer above it, a see-through header. */
function buildStage(): { stage: HTMLDivElement; site: HTMLDivElement } {
    const stage = document.createElement("div");
    stage.style.cssText =
        "position:fixed;left:300px;top:50px;width:800px;height:500px;background:#223;isolation:isolate";
    stage.innerHTML = `
        <div class="tile" style="position:absolute;left:20px;top:20px;width:760px;height:420px;background:#334;border-radius:8px"></div>
        <div class="layer" style="position:absolute;left:20px;top:20px;width:760px;height:420px;z-index:2;border-radius:8px;overflow:hidden;background:#000">
            <div class="screen" style="position:relative;width:100%;height:100%">
                <div class="host" style="position:absolute;inset:0"></div>
            </div>
        </div>
        <header style="position:absolute;inset:0 0 auto;z-index:3;pointer-events:none;padding:12px">
            <span style="background:#a60">Reconnecting</span>
        </header>`;
    const site = document.createElement("div");
    site.style.cssText = "position:absolute;inset:0;background:#000";
    stage.querySelector(".host")!.appendChild(site);
    document.body.appendChild(stage);
    return { stage, site };
}

function addFloating(css: string, attributes: Record<string, string> = {}, text = ""): HTMLDivElement {
    const element = document.createElement("div");
    element.style.cssText = `position:fixed;z-index:10;${css}`;
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
    element.textContent = text;
    document.body.appendChild(element);
    return element;
}

describe("app UI over the embedded browser", () => {
    let stage: HTMLDivElement;
    let site: HTMLDivElement;
    const covered = (): boolean =>
        appPaintsOver(site, site.getBoundingClientRect()) || floatingUiOver(site, site.getBoundingClientRect());

    beforeEach(() => {
        ({ stage, site } = buildStage());
    });

    afterEach(() => {
        document.body.replaceChildren();
    });

    it("leaves the player shown when nothing is drawn over it", () => {
        // The tile under it, the layer's rounded corners and the header that takes no clicks do not count.
        expect(covered()).toBe(false);
    });

    it("notices a sound board pop-up opened from the sidebar, which no menu role marks", () => {
        // Like the voice panel's pop-up: a dialog portalled to the body, reaching over the player's left edge.
        const popover = addFloating("left:200px;top:300px;width:400px;height:250px;background:#2b2d31", {
            role: "dialog",
        });
        expect(floatingUiOver(site, site.getBoundingClientRect())).toBe(true);
        // The same pop-up with no role at all is still found by what it draws.
        popover.removeAttribute("role");
        expect(appPaintsOver(site, site.getBoundingClientRect())).toBe(true);
        popover.style.left = "0px";
        popover.style.width = "200px";
        expect(covered()).toBe(false);
    });

    it("notices a small toast that opens wholly inside the player", () => {
        addFloating("left:700px;top:300px;width:300px;height:60px;background:#111", {}, "Someone joined");
        expect(appPaintsOver(site, site.getBoundingClientRect())).toBe(true);
    });

    it("notices a dialog's backdrop over the whole window", () => {
        addFloating("inset:0;background:rgb(0 0 0 / 60%)", { class: "mx_Dialog_background" });
        expect(appPaintsOver(site, site.getBoundingClientRect())).toBe(true);
    });

    it("finds a tooltip by its role, as it takes no clicks", () => {
        const tooltip = addFloating(
            "left:500px;top:420px;width:120px;height:30px;background:#000;pointer-events:none",
            { role: "tooltip" },
            "Mute",
        );
        expect(appPaintsOver(site, site.getBoundingClientRect())).toBe(false);
        expect(floatingUiOver(site, site.getBoundingClientRect())).toBe(true);
        tooltip.remove();
        expect(covered()).toBe(false);
    });

    it("ignores see-through and faded layers", () => {
        // The layer that closes a menu when clicking outside it covers the window but draws nothing.
        addFloating("inset:0;background:transparent");
        addFloating("left:400px;top:100px;width:300px;height:300px;background:#fff;opacity:0");
        expect(covered()).toBe(false);
    });

    it("ignores dialogs the player itself sits in", () => {
        stage.setAttribute("role", "dialog");
        expect(covered()).toBe(false);
    });

    it("samples a large player quickly enough to run a few times a second", () => {
        site.style.position = "fixed";
        stage.style.cssText = "position:fixed;inset:0";
        const box = new DOMRect(0, 0, 1920, 1080);
        expect(samplePoints(box, 1920, 1080).length).toBeLessThan(700);
        const start = performance.now();
        for (let i = 0; i < 10; i++) appPaintsOver(site, site.getBoundingClientRect());
        // Well under a frame per check, run once every few frames.
        expect((performance.now() - start) / 10).toBeLessThan(8);
    });
});

describe("samplePoints", () => {
    it("covers the edges closely and the inside more loosely, within the window", () => {
        const points = samplePoints(new DOMRect(-100, 10, 400, 200), 250, 800);
        expect(points.every(([x, y]) => x >= 1 && x <= 249 && y >= 11 && y <= 209)).toBe(true);
        // No two points along the top edge are further apart than the edge step.
        const top = points
            .filter(([, y]) => y === 11)
            .map(([x]) => x)
            .sort((a, b) => a - b);
        expect(Math.max(...top.slice(1).map((x, i) => x - top[i]))).toBeLessThanOrEqual(32);
        expect(samplePoints(new DOMRect(400, 10, 100, 100), 250, 800)).toEqual([]);
    });
});
