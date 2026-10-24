/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it, vi } from "vitest";

import {
    DESKTOP_SHELL_CONTROLS_HEIGHT_PX,
    getDesktopShellTitleBarOptions,
    setDesktopShellTitleBarColors,
} from "./desktop-shell-titlebar.js";

describe("getDesktopShellTitleBarOptions", () => {
    const shell = { features: { feature_desktop_shell: true } };

    it.each(["linux", "win32"] as const)("draws the window controls over the shell on %s", (platform) => {
        expect(getDesktopShellTitleBarOptions(shell, platform)).toEqual({
            titleBarStyle: "hidden",
            titleBarOverlay: expect.objectContaining({ height: DESKTOP_SHELL_CONTROLS_HEIGHT_PX }),
        });
    });

    it("leaves macOS to Element's own title bar", () => {
        expect(getDesktopShellTitleBarOptions(shell, "darwin")).toEqual({});
    });

    it.each<Parameters<typeof getDesktopShellTitleBarOptions>[0]>([
        {},
        { features: {} },
        { features: { feature_desktop_shell: false } },
    ])("keeps the system title bar without the desktop shell (%o)", (config) => {
        expect(getDesktopShellTitleBarOptions(config, "linux")).toEqual({});
    });
});

describe("setDesktopShellTitleBarColors", () => {
    const shell = { features: { feature_desktop_shell: true } };
    it.each(["linux", "win32"] as const)("updates colours without altering overlay geometry on %s", (platform) => {
        const window = { setTitleBarOverlay: vi.fn() };
        setDesktopShellTitleBarColors(window, shell, platform, "rgb(255, 255, 255)", "rgb(76, 80, 112)");
        expect(window.setTitleBarOverlay).toHaveBeenCalledWith({
            color: "rgb(255, 255, 255)",
            symbolColor: "rgb(76, 80, 112)",
        });
    });
    it.each([
        [{}, "linux"],
        [shell, "darwin"],
    ] as const)("leaves other window configurations alone", (config, platform) => {
        const window = { setTitleBarOverlay: vi.fn() };
        setDesktopShellTitleBarColors(window, config, platform, "#ffffff", "#4c5070");
        expect(window.setTitleBarOverlay).not.toHaveBeenCalled();
    });
    it.each([null, {}, "transparent", "url(file:///tmp/no)", "rgb(999, 0, 0)"])(
        "rejects invalid colour %o",
        (color) => {
            const window = { setTitleBarOverlay: vi.fn() };
            setDesktopShellTitleBarColors(window, shell, "linux", color, "#4c5070");
            expect(window.setTitleBarOverlay).not.toHaveBeenCalled();
        },
    );
});
