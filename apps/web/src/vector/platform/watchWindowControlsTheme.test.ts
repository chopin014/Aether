/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import { watchWindowControlsTheme } from "./watchWindowControlsTheme";

const light = { backgroundColor: "rgb(255, 255, 255)", color: "rgb(76, 80, 112)" };
const dark = { backgroundColor: "rgb(18, 20, 42)", color: "rgb(154, 156, 192)" };

afterEach(() => vi.restoreAllMocks());

describe("watchWindowControlsTheme", () => {
    it("updates from resolved colours on body and completed stylesheet changes, skipping duplicates", async () => {
        let colors = light;
        vi.spyOn(window, "getComputedStyle").mockImplementation(() => colors as CSSStyleDeclaration);
        const update = vi.fn();
        const stop = watchWindowControlsTheme(update);
        const meta = document.createElement("meta");
        meta.name = "theme-color";
        document.head.appendChild(meta);
        try {
            expect(update).toHaveBeenLastCalledWith(light.backgroundColor, light.color);
            colors = dark;
            document.body.classList.add("cpd-theme-dark");
            await vi.waitFor(() => expect(update).toHaveBeenLastCalledWith(dark.backgroundColor, dark.color));
            document.body.classList.add("mx_DesktopShell");
            await new Promise<void>((resolve) => queueMicrotask(resolve));
            expect(update).toHaveBeenCalledTimes(2);
            colors = light;
            meta.content = light.backgroundColor;
            await vi.waitFor(() => expect(update).toHaveBeenLastCalledWith(light.backgroundColor, light.color));
            expect(document.body.children).toHaveLength(0);
        } finally {
            stop();
            meta.remove();
            document.body.className = "";
        }
    });
    it("stops watching when the renderer page is unloaded", async () => {
        vi.spyOn(window, "getComputedStyle").mockReturnValue(light as CSSStyleDeclaration);
        const update = vi.fn();
        const stop = watchWindowControlsTheme(update);
        window.dispatchEvent(new Event("pagehide"));
        document.body.classList.add("mx_DesktopShell");
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        expect(update).toHaveBeenCalledOnce();
        document.body.className = "";
        stop();
    });
});
