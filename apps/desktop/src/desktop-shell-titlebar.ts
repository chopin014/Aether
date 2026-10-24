/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import type { BrowserWindow, BrowserWindowConstructorOptions } from "electron";

import type { ConfigOptions } from "./config.js";

/**
 * Height of the window controls, matching the desktop shell's header row (`--mx-desktop-shell-header-height`
 * less its 1px border) so the controls sit inside it.
 */
export const DESKTOP_SHELL_CONTROLS_HEIGHT_PX = 48;

/**
 * Window options for the desktop shell on Linux and Windows. It replaces the system title bar with Electron's
 * window controls drawn over the top right of the app, as in Discord; the renderer keeps that corner clear and
 * makes its header row the drag handle. macOS keeps Element's own title bar handling.
 */
export function getDesktopShellTitleBarOptions(
    config: Pick<ConfigOptions, "features">,
    platform: NodeJS.Platform,
): Pick<BrowserWindowConstructorOptions, "titleBarStyle" | "titleBarOverlay"> {
    if (!config.features?.feature_desktop_shell || (platform !== "linux" && platform !== "win32")) return {};
    return {
        titleBarStyle: "hidden",
        // Aether's dark header surface and muted text (Órbita and Lunar), the shell's default theme.
        titleBarOverlay: { color: "#12142a", symbolColor: "#9a9cc0", height: DESKTOP_SHELL_CONTROLS_HEIGHT_PX },
    };
}

/** Updates only native overlay colours; renderer requests cannot resize or replace window chrome. */
export function setDesktopShellTitleBarColors(
    window: Pick<BrowserWindow, "setTitleBarOverlay">,
    config: Pick<ConfigOptions, "features">,
    platform: NodeJS.Platform,
    color: unknown,
    symbolColor: unknown,
): void {
    if (!config.features?.feature_desktop_shell || (platform !== "linux" && platform !== "win32")) return;
    // These are the opaque RGB values returned by getComputedStyle for the Compound colour tokens.
    const isColor = (value: unknown): value is string => {
        if (typeof value !== "string") return false;
        if (/^#[\da-f]{6}$/i.test(value)) return true;
        const rgb = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/.exec(value);
        return !!rgb && rgb.slice(1).every((channel) => Number(channel) <= 255);
    };
    if (!isColor(color) || !isColor(symbolColor)) return;
    window.setTitleBarOverlay({ color, symbolColor });
}
