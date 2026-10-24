/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";

import { DESKTOP_SHELL_CONTROLS_HEIGHT_PX, getDesktopShellTitleBarOptions } from "./desktop-shell-titlebar.js";

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
