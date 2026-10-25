/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { app, ipcMain, type BrowserWindow } from "electron";
import { authorizeShareAudioVideo, resetShareAudio, setupShareAudio } from "./setupShareAudio.js";
import type { ShareAudioCallbacks } from "./types.js";

const { handlers, start, stop, capabilities, applications } = vi.hoisted(() => ({
    handlers: new Map<string, (...args: unknown[]) => unknown>(),
    start: vi.fn(),
    stop: vi.fn(async () => undefined),
    capabilities: vi.fn(async () => ({ system: true, application: true, window: false })),
    applications: vi.fn(async () => [{ id: "application-token", name: "Player" }]),
}));

vi.mock("electron", async () => {
    const { EventEmitter } = await import("node:events");
    return {
        app: Object.assign(new EventEmitter(), {
            getAppMetrics: () => [{ pid: 202 }, { pid: 203 }],
            getAppPath: () => "/aether",
            isPackaged: false,
        }),
        desktopCapturer: { getSources: vi.fn(async () => []) },
        ipcMain: Object.assign(new EventEmitter(), {
            handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
            removeHandler: (name: string) => handlers.delete(name),
        }),
    };
});
vi.mock("./LinuxShareAudioProvider.js", () => ({
    createLinuxShareAudioProvider: () => ({
        capabilities,
        listApplications: applications,
        start,
        resolveWindow: vi.fn(),
    }),
}));
vi.mock("./WindowsShareAudioProvider.js", () => ({
    createWindowsShareAudioProvider: () => ({
        capabilities,
        listApplications: applications,
        start,
        resolveWindow: vi.fn(),
    }),
}));

describe("setupShareAudio", () => {
    let window: BrowserWindow;
    let contents: EventEmitter & { mainFrame: object; send: ReturnType<typeof vi.fn>; isDestroyed: () => boolean };
    let dispose: () => void;
    let callbacks: ShareAudioCallbacks;
    const request = { id: "share", videoSourceId: "screen:1:0", target: { kind: "system" } };
    const event = (): object => ({ sender: contents, senderFrame: contents.mainFrame });
    const invoke = (name: string, ...args: unknown[]): unknown =>
        handlers.get(`aether:share-audio-${name}`)!(event(), ...args);

    beforeEach(() => {
        vi.clearAllMocks();
        contents = Object.assign(new EventEmitter(), { mainFrame: {}, send: vi.fn(), isDestroyed: () => false });
        window = Object.assign(new EventEmitter(), { webContents: contents }) as unknown as BrowserWindow;
        start.mockImplementation(async (_target, _excluded, handlers: ShareAudioCallbacks) => {
            callbacks = handlers;
            return { stop };
        });
        dispose = setupShareAudio(window, {
            capabilities,
            listApplications: applications,
            start,
            resolveWindow: vi.fn(async () => null),
        });
    });
    afterEach(() => dispose());

    it("limits capability, enumeration, and capture calls to the owning main frame", async () => {
        await expect(invoke("capabilities")).resolves.toMatchObject({ system: true });
        await expect(invoke("applications")).resolves.toEqual([{ id: "application-token", name: "Player" }]);
        for (const handler of handlers.values()) {
            expect(() => handler({ sender: {}, senderFrame: contents.mainFrame })).toThrow("main application frame");
            expect(() => handler({ sender: contents, senderFrame: {} })).toThrow("main application frame");
        }
        expect(start).not.toHaveBeenCalled();
    });

    it("passes the Aether root first, forwards PCM, and consumes acknowledgements only from the owner", async () => {
        authorizeShareAudioVideo(request.videoSourceId);
        await invoke("start", request);
        expect(start).toHaveBeenCalledWith(
            request.target,
            [process.pid, 202, 203],
            expect.any(Object),
            expect.any(AbortSignal),
        );
        callbacks.onData(Buffer.alloc(7680 * 8));
        expect(contents.send).toHaveBeenCalledTimes(8);
        ipcMain.emit("aether:share-audio-ack", { sender: {}, senderFrame: {} }, request.id, 1);
        callbacks.onData(Buffer.alloc(8));
        expect(contents.send).toHaveBeenCalledTimes(8);
        ipcMain.emit("aether:share-audio-ack", event(), request.id, 1);
        callbacks.onData(Buffer.alloc(8));
        expect(contents.send).toHaveBeenCalledTimes(9);
    });

    it.each(["navigation", "renderer-crash", "quit", "closed", "hangup"])("stops capture on %s", async (reason) => {
        authorizeShareAudioVideo(request.videoSourceId);
        await invoke("start", request);
        if (reason === "navigation")
            contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
        if (reason === "renderer-crash") contents.emit("render-process-gone");
        if (reason === "quit") app.emit("before-quit", {} as Electron.Event);
        if (reason === "closed") window.emit("closed");
        if (reason === "hangup") resetShareAudio();
        expect(stop).toHaveBeenCalled();
        callbacks.onData(Buffer.alloc(8));
        expect(contents.send).toHaveBeenCalledExactlyOnceWith("aether:share-audio-event", {
            type: "stopped",
            id: request.id,
        });
    });

    it("keeps capture across SPA navigation and removes exact listeners on disposal", async () => {
        authorizeShareAudioVideo(request.videoSourceId);
        await invoke("start", request);
        contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
        contents.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
        expect(stop).not.toHaveBeenCalled();
        dispose();
        expect(handlers.size).toBe(0);
        expect(contents.listenerCount("did-start-navigation")).toBe(0);
        expect(contents.listenerCount("render-process-gone")).toBe(0);
        expect(ipcMain.listenerCount("aether:share-audio-ack")).toBe(0);
        expect(app.listenerCount("before-quit")).toBe(0);
    });
});
