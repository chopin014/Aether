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
import { GlobalShortcutController, validateConfiguration } from "./GlobalShortcutController.js";
import { NativeShortcutBackend } from "./NativeShortcutBackend.js";
import { PortalShortcutBackend } from "./PortalShortcutBackend.js";
import type { BackendFactory, ShortcutConfiguration } from "./types.js";

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
    // BrowserWindow.webContents cannot be read once the native window has closed.
    const webContents = window.webContents;
    const controller = new GlobalShortcutController(
        createShortcutBackend,
        (event) => {
            if (!webContents.isDestroyed()) webContents.send("aether:global-shortcut", event);
        },
        () => {
            if (window.isVisible() && window.isFocused() && !window.isMinimized()) window.hide();
            else revealMainWindow(window);
        },
    );
    let lastConfiguration: ShortcutConfiguration | undefined;
    let disposed = false;
    const blocked = new Set<"lock" | "suspend">();
    const clear = (): void => {
        lastConfiguration = undefined;
        controller.reset();
    };
    const block = (reason: "lock" | "suspend"): void => {
        blocked.add(reason);
        controller.reset();
    };
    const unblock = (reason: "lock" | "suspend"): void => {
        if (!blocked.delete(reason) || blocked.size || disposed || !lastConfiguration) return;
        // Re-registration is asynchronous; a concurrent logout/navigation still resets its generation.
        void controller.configure(lastConfiguration).catch(() => controller.reset());
    };
    const lock = (): void => block("lock");
    const suspend = (): void => block("suspend");
    const unlock = (): void => unblock("lock");
    const resume = (): void => unblock("suspend");
    const configure = (event: IpcMainInvokeEvent, value: unknown): ReturnType<typeof controller.configure> => {
        if (
            disposed ||
            event.sender !== webContents ||
            event.senderFrame !== webContents.mainFrame ||
            !config.features?.feature_desktop_shell
        )
            throw new Error("Shortcut configuration is unavailable");
        validateConfiguration(value);
        const configuration: ShortcutConfiguration = {
            enabled: value.enabled,
            bindings: value.bindings.map(({ id, key, kind }) => ({ id, key, kind })),
        };
        lastConfiguration = configuration.enabled ? configuration : undefined;
        return controller.configure(blocked.size ? { ...configuration, enabled: false } : configuration);
    };
    ipcMain.handle("aether:configure-global-shortcuts", configure);
    const navigation = (details: Event<WebContentsDidStartNavigationEventParams>): void => {
        if (details.isMainFrame && !details.isSameDocument) clear();
    };
    webContents.on("did-start-navigation", navigation);
    webContents.on("render-process-gone", clear);
    powerMonitor.on("lock-screen", lock);
    powerMonitor.on("unlock-screen", unlock);
    powerMonitor.on("suspend", suspend);
    powerMonitor.on("resume", resume);
    app.on("before-quit", clear);
    const dispose = (): void => {
        disposed = true;
        clear();
        ipcMain.removeHandler("aether:configure-global-shortcuts");
        webContents.removeListener("did-start-navigation", navigation);
        webContents.removeListener("render-process-gone", clear);
        powerMonitor.removeListener("lock-screen", lock);
        powerMonitor.removeListener("unlock-screen", unlock);
        powerMonitor.removeListener("suspend", suspend);
        powerMonitor.removeListener("resume", resume);
        app.removeListener("before-quit", clear);
        window.removeListener("closed", dispose);
    };
    window.once("closed", dispose);
    return dispose;
}
