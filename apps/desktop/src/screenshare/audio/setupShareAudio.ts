/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import path from "node:path";
import {
    app,
    desktopCapturer,
    ipcMain,
    type BrowserWindow,
    type IpcMainEvent,
    type IpcMainInvokeEvent,
    type Event,
    type WebContentsDidStartNavigationEventParams,
} from "electron";
import { ShareAudioController } from "./ShareAudioController.js";
import { createLinuxShareAudioProvider } from "./LinuxShareAudioProvider.js";
import { createWindowsShareAudioProvider } from "./WindowsShareAudioProvider.js";
import type { ShareAudioProvider } from "./types.js";

let controller: ShareAudioController | undefined;

/** Grant audio startup only after a main-process desktop video selection succeeds. */
export function authorizeShareAudioVideo(sourceId: string): void {
    controller?.authorizeVideo(sourceId);
}

/** Revoke pending approval when video selection is cancelled or replaced. */
export function resetShareAudio(): void {
    void controller?.reset();
}

/** Set up the capture API for the main window; no audio starts until explicitly requested. */
export function setupShareAudio(window: BrowserWindow, providerOverride?: ShareAudioProvider): () => void {
    const unsupported: ShareAudioProvider = {
        capabilities: async () => ({
            system: false,
            application: false,
            window: false,
            reason: "unsupported-platform",
        }),
        listApplications: async () => [],
        resolveWindow: async () => null,
        start: async () => {
            throw new Error("Native screen audio is unavailable on this platform");
        },
    };
    const provider =
        providerOverride ??
        (process.platform === "win32"
            ? createWindowsShareAudioProvider({
                  helperPath: app.isPackaged
                      ? path.join(process.resourcesPath, "share-audio", "aether-share-audio.exe")
                      : path.join(
                            app.getAppPath(),
                            "native",
                            "share-audio",
                            "windows",
                            "build",
                            "Release",
                            "aether-share-audio.exe",
                        ),
                  listWindows: async () =>
                      desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 0, height: 0 } }),
              })
            : process.platform === "linux"
              ? createLinuxShareAudioProvider()
              : unsupported);
    const owned = new ShareAudioController(
        provider,
        (event) => {
            if (!window.webContents.isDestroyed()) window.webContents.send("aether:share-audio-event", event);
        },
        () => [process.pid, ...app.getAppMetrics().map(({ pid }) => pid)],
    );
    controller = owned;
    let disposed = false;
    const allowed = (event: IpcMainInvokeEvent): void => {
        if (disposed || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
            throw new Error("Screen audio is available only to the main application frame");
        }
    };
    const handlers = {
        "aether:share-audio-capabilities": (event: IpcMainInvokeEvent) => {
            allowed(event);
            return provider.capabilities();
        },
        "aether:share-audio-applications": (event: IpcMainInvokeEvent) => {
            allowed(event);
            return provider.listApplications();
        },
        "aether:share-audio-start": (event: IpcMainInvokeEvent, request: unknown) => {
            allowed(event);
            return owned.start(request);
        },
        "aether:share-audio-stop": (event: IpcMainInvokeEvent, id: unknown) => {
            allowed(event);
            return owned.stop(id);
        },
    };
    for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, handler);
    const acknowledge = (event: IpcMainEvent, id: unknown, sequence: unknown): void => {
        if (event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame) {
            owned.acknowledge(id, sequence);
        }
    };
    ipcMain.on("aether:share-audio-ack", acknowledge);
    const reset = (): void => {
        void owned.reset();
    };
    const navigate = (details: Event<WebContentsDidStartNavigationEventParams>): void => {
        if (details.isMainFrame && !details.isSameDocument) reset();
    };
    window.webContents.on("did-start-navigation", navigate);
    window.webContents.on("render-process-gone", reset);
    app.on("before-quit", reset);
    const dispose = (): void => {
        if (disposed) return;
        disposed = true;
        reset();
        if (controller === owned) controller = undefined;
        for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel);
        ipcMain.removeListener("aether:share-audio-ack", acknowledge);
        window.webContents.removeListener("did-start-navigation", navigate);
        window.webContents.removeListener("render-process-gone", reset);
        app.removeListener("before-quit", reset);
        window.removeListener("closed", dispose);
    };
    window.once("closed", dispose);
    return dispose;
}
