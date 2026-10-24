/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    app,
    globalShortcut,
    ipcMain,
    powerMonitor,
    type BrowserWindow,
    type IpcMainInvokeEvent,
    type Event,
    type WebContentsDidStartNavigationEventParams,
} from "electron";
import { getBuildConfig } from "../build-config.js";
import type { ConfigOptions } from "../config.js";
import { revealMainWindow } from "../window-close.js";
import { GlobalShortcutController } from "./GlobalShortcutController.js";
import { NativeShortcutBackend } from "./NativeShortcutBackend.js";
import { PortalShortcutBackend } from "./PortalShortcutBackend.js";
import type { BackendFactory } from "./types.js";

/** Select a release-aware backend without falling back to XWayland key observation. */
export const createShortcutBackend: BackendFactory = async (emit, failed) => {
    if (process.platform === "linux" && (process.env.XDG_SESSION_TYPE === "wayland" || process.env.WAYLAND_DISPLAY)) {
        return new PortalShortcutBackend(
            emit,
            failed,
            undefined,
            getBuildConfig().desktopName.replace(/\.desktop$/, ""),
        );
    }
    if (process.platform !== "win32" && !(process.platform === "linux" && process.env.DISPLAY)) return;
    const { uIOhook, UiohookKey } = await import("uiohook-napi");
    return new NativeShortcutBackend(uIOhook, UiohookKey, globalShortcut, emit, failed);
};

/** Main-frame boundary and lifetime ownership for the Aether shortcuts IPC API. */
export function setupGlobalShortcuts(window: BrowserWindow, config: Pick<ConfigOptions, "features">): () => void {
    const controller = new GlobalShortcutController(
        createShortcutBackend,
        (event) => {
            if (!window.webContents.isDestroyed()) window.webContents.send("aether:global-shortcut", event);
        },
        () => {
            if (window.isVisible() && window.isFocused() && !window.isMinimized()) window.hide();
            else revealMainWindow(window);
        },
    );
    const configure = (event: IpcMainInvokeEvent, value: unknown): ReturnType<typeof controller.configure> => {
        if (
            event.sender !== window.webContents ||
            event.senderFrame !== window.webContents.mainFrame ||
            !config.features?.feature_desktop_shell
        )
            throw new Error("Shortcut configuration is unavailable");
        return controller.configure(value);
    };
    ipcMain.handle("aether:configure-global-shortcuts", configure);
    const navigation = (details: Event<WebContentsDidStartNavigationEventParams>): void => {
        if (details.isMainFrame && !details.isSameDocument) controller.reset();
    };
    window.webContents.on("did-start-navigation", navigation);
    window.webContents.on("render-process-gone", controller.reset);
    powerMonitor.on("lock-screen", controller.reset);
    powerMonitor.on("suspend", controller.reset);
    app.on("before-quit", controller.reset);
    const dispose = (): void => {
        controller.reset();
        ipcMain.removeHandler("aether:configure-global-shortcuts");
        window.webContents.removeListener("did-start-navigation", navigation);
        window.webContents.removeListener("render-process-gone", controller.reset);
        powerMonitor.removeListener("lock-screen", controller.reset);
        powerMonitor.removeListener("suspend", controller.reset);
        app.removeListener("before-quit", controller.reset);
        window.removeListener("closed", dispose);
    };
    window.once("closed", dispose);
    return dispose;
}
