/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app, ipcMain, type BrowserWindow, type Event } from "electron";

import { setupGracefulQuit } from "./graceful-quit.js";

vi.mock("electron", () => ({ app: new EventEmitter(), ipcMain: new EventEmitter() }));

describe("graceful quit", () => {
    const contents = { send: vi.fn(), isDestroyed: vi.fn(() => false), isCrashed: vi.fn(() => false), mainFrame: {} };
    const window = { isDestroyed: vi.fn(() => false), webContents: contents } as unknown as BrowserWindow;
    const event = (): Event => ({ preventDefault: vi.fn() }) as unknown as Event;
    let quit: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        quit = vi.fn();
        Object.assign(app, { quit });
    });
    afterEach(() => {
        app.removeAllListeners();
        ipcMain.removeAllListeners();
        vi.useRealTimers();
    });

    it("keeps the renderer alive until it acknowledges call cleanup", () => {
        const handler = setupGracefulQuit(() => window);
        const quitting = event();
        app.emit("before-quit", quitting);
        expect(quitting.preventDefault).toHaveBeenCalledOnce();
        expect(handler.isWaiting()).toBe(true);
        expect(contents.send).toHaveBeenCalledWith("before-quit");
        expect(quit).not.toHaveBeenCalled();
        ipcMain.emit("quit-ready", { sender: contents, senderFrame: contents.mainFrame });
        expect(quit).toHaveBeenCalledOnce();
        expect(handler.isWaiting()).toBe(false);
        const resumed = event();
        app.emit("before-quit", resumed);
        expect(resumed.preventDefault).not.toHaveBeenCalled();
        expect(ipcMain.listenerCount("quit-ready")).toBe(0);
    });

    it("ignores acknowledgements from another window or frame", () => {
        setupGracefulQuit(() => window);
        app.emit("before-quit", event());
        ipcMain.emit("quit-ready", { sender: {}, senderFrame: contents.mainFrame });
        ipcMain.emit("quit-ready", { sender: contents, senderFrame: {} });
        expect(quit).not.toHaveBeenCalled();
    });

    it("quits after five seconds if cleanup cannot finish and coalesces repeated quits", () => {
        setupGracefulQuit(() => window);
        app.emit("before-quit", event());
        app.emit("before-quit", event());
        expect(contents.send).toHaveBeenCalledOnce();
        vi.advanceTimersByTime(5_000);
        expect(quit).toHaveBeenCalledOnce();
        expect(ipcMain.listenerCount("quit-ready")).toBe(0);
    });

    it("does not wait if the main window has already closed", () => {
        setupGracefulQuit(() => null);
        const quitting = event();
        app.emit("before-quit", quitting);
        expect(quitting.preventDefault).not.toHaveBeenCalled();
    });

    it("does not wait for a crashed renderer", () => {
        contents.isCrashed.mockReturnValueOnce(true);
        setupGracefulQuit(() => window);
        const quitting = event();
        app.emit("before-quit", quitting);
        expect(quitting.preventDefault).not.toHaveBeenCalled();
    });
});
