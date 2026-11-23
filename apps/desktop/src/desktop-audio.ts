/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { createRequire } from "node:module";
import { ipcMain, type WebContents } from "electron";
import type { DesktopAudioPacket } from "shared-types";

interface NativeCapture {
    isAvailable: () => boolean;
    getPidFromWindowHandle: (handle: number) => number;
    startCapture: (
        pid: number,
        include: boolean,
        callback: (data: Buffer, format: Omit<DesktopAudioPacket, "data" | "sessionId">) => void,
    ) => boolean;
    stopCapture: () => void;
}

// The Wayland portal never says which screen or window was picked, so its source id cannot name an application.
const PORTAL_SOURCE = "portal";

/**
 * Captures only a confirmed source; window capture never falls back to the system mix. A Wayland portal source
 * captures the system mix without Aether, as for an entire screen, because the chosen application is unknown.
 */
export class DesktopAudioCapture {
    private selectedSource: string | null = null;
    private sessionId: string | null = null;
    private native?: NativeCapture;

    public constructor(
        private readonly owner: WebContents,
        native?: NativeCapture,
    ) {
        this.native = native;
        owner.on("destroyed", this.reset);
        owner.on("render-process-gone", this.reset);
        owner.on("did-start-loading", this.reset);
    }

    /** Authorize audio once, only after the source picker confirms the user's selection. */
    public select = (sourceId: string, audio: boolean): void => {
        this.selectedSource = audio && /^(screen|window):[0-9]+(?::[0-9]+)?$/.test(sourceId) ? sourceId : null;
    };

    /** Authorize audio once for the source the Wayland portal returned, whatever form its id takes. */
    public selectPortal = (audio: boolean): void => {
        this.selectedSource = audio ? PORTAL_SOURCE : null;
    };

    /** Start native process-tree audio using the source chosen in the pending picker. */
    public start = (sessionId: string): boolean => {
        const source = this.selectedSource;
        this.selectedSource = null;
        if (!source) return false;
        if (!sessionId || this.sessionId) throw new Error("Desktop audio capture is already active");
        const require = createRequire(import.meta.url);
        this.native ??= require("electron-native-screenshare") as NativeCapture;
        if (!this.native.isAvailable()) throw new Error("Native screen audio capture is unavailable");
        const window = source.startsWith("window:");
        const pid = window ? this.native.getPidFromWindowHandle(Number(source.split(":")[1])) : process.pid;
        if (!pid) throw new Error("Cannot resolve the selected application's audio process");
        // Include the selected application's descendants; exclude Aether's process tree for entire screens.
        this.sessionId = sessionId;
        try {
            if (
                !this.native.startCapture(pid, window, (data, format) => {
                    if (this.sessionId === sessionId && !this.owner.isDestroyed()) {
                        this.owner.send("aether:desktop-audio-data", { ...format, data, sessionId });
                    }
                })
            )
                throw new Error("Native screen audio capture failed to start");
            return true;
        } catch (error) {
            this.stop(sessionId);
            throw error;
        }
    };

    /** Stop only the matching capture, so late cleanup cannot stop a newer stream. */
    public stop = (sessionId: string): void => {
        if (this.sessionId !== sessionId) return;
        this.sessionId = null;
        this.native?.stopCapture();
    };

    private reset = (): void => {
        this.selectedSource = null;
        if (this.sessionId) this.stop(this.sessionId);
    };
}

let capture: DesktopAudioCapture | undefined;
let portalAudioRequested = false;

/** Install audio IPC restricted to the app's top-level renderer. `native` replaces the native module in tests. */
export function setupDesktopAudio(owner: WebContents, native?: NativeCapture): void {
    capture = new DesktopAudioCapture(owner, native);
    const assertOwner = (event: Electron.IpcMainInvokeEvent): void => {
        if (event.sender !== owner || event.senderFrame !== owner.mainFrame) throw new Error("Invalid audio sender");
    };
    ipcMain.removeHandler("aether:desktop-audio-prepare");
    ipcMain.handle("aether:desktop-audio-prepare", (event, audio: boolean) => {
        assertOwner(event);
        portalAudioRequested = audio === true;
    });
    ipcMain.removeHandler("aether:desktop-audio-start");
    ipcMain.removeHandler("aether:desktop-audio-stop");
    ipcMain.handle("aether:desktop-audio-start", (event, sessionId: string) => {
        assertOwner(event);
        return capture!.start(sessionId);
    });
    ipcMain.handle("aether:desktop-audio-stop", (event, sessionId: string) => {
        assertOwner(event);
        capture!.stop(sessionId);
    });
}

/** Record the selected source only when the pending display-media callback is consumed. */
export function selectDesktopAudio(sourceId: string, audio: boolean): void {
    capture?.select(sourceId, audio);
}

/** Portal selection has no renderer picker; use the preference from before getDisplayMedia. */
export function selectPortalDesktopAudio(sourceId: string): void {
    capture?.selectPortal(sourceId !== "" && portalAudioRequested);
    portalAudioRequested = false;
}
