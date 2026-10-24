/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { watchWindowControlsTheme } from "./watchWindowControlsTheme";

describe("window control colours under modal backdrops", () => {
    let root: HTMLDivElement;
    let stop: (() => void) | undefined;
    const update = vi.fn<(color: string, symbolColor: string) => void>();

    beforeEach(() => {
        update.mockClear();
        document.body.style.setProperty("--cpd-color-bg-canvas-default", "rgb(18, 20, 42)");
        document.body.style.setProperty("--cpd-color-icon-secondary", "rgb(154, 156, 192)");
        root = document.createElement("div");
        root.id = "mx_Dialog_Container";
    });

    afterEach(() => {
        stop?.();
        root.remove();
        document.body.style.removeProperty("--cpd-color-bg-canvas-default");
        document.body.style.removeProperty("--cpd-color-icon-secondary");
    });

    const addBackdrop = (opacity = "0.85"): HTMLDivElement => {
        const backdrop = document.createElement("div");
        backdrop.className = "mx_Dialog_background";
        backdrop.style.cssText = `position:fixed;inset:0;background:rgb(0,0,0);opacity:${opacity}`;
        root.appendChild(backdrop);
        return backdrop;
    };

    const expectColours = (background: number[], symbols: number[]): void => {
        const colours = update.mock.lastCall;
        expect(colours).toBeDefined();
        for (const [index, expected] of [background, symbols].entries()) {
            const actual = colours![index].match(/\d+/g)!.map(Number);
            // Browser compositing rounds alpha and colour channels to eight bits.
            expected.forEach((channel, i) => expect(Math.abs(actual[i] - channel)).toBeLessThanOrEqual(1));
        }
    };

    it("dims the window background and symbols when a viewer opens, then restores them on close", async () => {
        stop = watchWindowControlsTheme(update);
        expect(update).toHaveBeenLastCalledWith("rgb(18, 20, 42)", "rgb(154, 156, 192)");
        document.body.appendChild(root);
        const backdrop = addBackdrop();
        await vi.waitFor(() => expectColours([3, 3, 6], [23, 23, 29]));
        backdrop.remove();
        await vi.waitFor(() => expect(update).toHaveBeenLastCalledWith("rgb(18, 20, 42)", "rgb(154, 156, 192)"));
    });

    it("composes translucent backdrops, follows theme changes underneath, and restores nested dialogs", async () => {
        document.body.appendChild(root);
        const first = addBackdrop("0.5");
        stop = watchWindowControlsTheme(update);
        expect(update).toHaveBeenLastCalledWith("rgb(9, 10, 21)", "rgb(77, 78, 96)");
        const second = addBackdrop("0.5");
        await vi.waitFor(() => expect(update).toHaveBeenLastCalledWith("rgb(4, 5, 10)", "rgb(38, 39, 48)"));
        document.body.style.setProperty("--cpd-color-bg-canvas-default", "rgb(255, 255, 255)");
        await vi.waitFor(() => expectColours([64, 64, 64], [38, 39, 48]));
        second.remove();
        first.style.display = "none";
        await vi.waitFor(() => expect(update).toHaveBeenLastCalledWith("rgb(255, 255, 255)", "rgb(154, 156, 192)"));
    });

    it("follows a backdrop animation through its final frame and stops on page disposal", async () => {
        document.body.appendChild(root);
        const backdrop = addBackdrop("0");
        stop = watchWindowControlsTheme(update);
        const animation = backdrop.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, fill: "forwards" });
        backdrop.classList.add("animating");
        await animation.finished;
        await vi.waitFor(() => expect(update).toHaveBeenLastCalledWith("rgb(0, 0, 0)", "rgb(0, 0, 0)"));
        stop();
        const count = update.mock.calls.length;
        backdrop.remove();
        await new Promise((resolve) => requestAnimationFrame(resolve));
        expect(update).toHaveBeenCalledTimes(count);
    });

    it("uses backdrop colours, alpha and stacking order, including the static modal portal", async () => {
        document.body.appendChild(root);
        const red = addBackdrop("0.5");
        red.style.backgroundColor = "rgba(200, 0, 0, 0.5)";
        red.style.zIndex = "100";
        const staticRoot = document.createElement("div");
        staticRoot.id = "mx_Dialog_StaticContainer";
        document.body.appendChild(staticRoot);
        try {
            const blue = addBackdrop("0.5");
            blue.style.backgroundColor = "rgb(0, 0, 200)";
            blue.style.zIndex = "50";
            staticRoot.appendChild(blue);
            stop = watchWindowControlsTheme(update);
            expect(update).toHaveBeenCalledOnce();
            expectColours([57, 8, 91], [108, 59, 147]);
            blue.style.zIndex = "150";
            await vi.waitFor(() => expectColours([32, 8, 116], [83, 59, 172]));
            blue.style.left = "100vw";
            await vi.waitFor(() => expectColours([64, 15, 32], [166, 117, 144]));
        } finally {
            staticRoot.remove();
        }
    });

    it("cancels animation updates when the page unloads", async () => {
        document.body.appendChild(root);
        const backdrop = addBackdrop("0");
        const animation = backdrop.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 500, fill: "forwards" });
        stop = watchWindowControlsTheme(update);
        window.dispatchEvent(new Event("pagehide"));
        const count = update.mock.calls.length;
        await animation.finished;
        expect(update).toHaveBeenCalledTimes(count);
    });
});
