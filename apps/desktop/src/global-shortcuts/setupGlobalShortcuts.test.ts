/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { app, ipcMain, powerMonitor, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { setupGlobalShortcuts } from "./setupGlobalShortcuts.js";

const mocks = vi.hoisted(() => ({
    configure: vi.fn(),
    reset: vi.fn(),
    send: undefined as ((event: unknown) => void) | undefined,
    showHide: undefined as (() => void) | undefined,
}));
vi.mock("electron", async () => {
    const { EventEmitter } = await import("node:events");
    return {
        app: new EventEmitter(),
        powerMonitor: new EventEmitter(),
        ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
        globalShortcut: {},
    };
});
vi.mock("./GlobalShortcutController.js", () => ({
    GlobalShortcutController: class {
        public configure = mocks.configure;
        public reset = mocks.reset;
        public constructor(_factory: unknown, send: (event: unknown) => void, showHide: () => void) {
            mocks.send = send;
            mocks.showHide = showHide;
        }
    },
}));
vi.mock("../window-close.js", () => ({ revealMainWindow: vi.fn() }));

describe("setupGlobalShortcuts", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });
    function fixture(enabled = true) {
        const mainFrame = {};
        const contents = Object.assign(new EventEmitter(), { mainFrame, isDestroyed: () => false, send: vi.fn() });
        const window = Object.assign(new EventEmitter(), {
            webContents: contents,
            hide: vi.fn(),
            isVisible: () => true,
            isFocused: () => true,
            isMinimized: () => false,
        });
        const dispose = setupGlobalShortcuts(window as unknown as BrowserWindow, {
            features: { feature_desktop_shell: enabled },
        });
        const handler = vi.mocked(ipcMain.handle).mock.calls.at(-1)![1];
        return {
            window,
            contents,
            dispose,
            handler,
            event: { sender: contents, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent,
        };
    }
    it("should accept only the owning window main frame with the feature enabled", () => {
        const f = fixture();
        f.handler(f.event, { enabled: false, bindings: [] });
        expect(mocks.configure).toHaveBeenCalledOnce();
        expect(() => f.handler({ ...f.event, senderFrame: {} } as IpcMainInvokeEvent, {})).toThrow();
        expect(() => f.handler({ ...f.event, sender: {} } as IpcMainInvokeEvent, {})).toThrow();
        f.dispose();
        const disabled = fixture(false);
        expect(() => disabled.handler(disabled.event, {})).toThrow();
        disabled.dispose();
    });
    it("should reset on navigation, crash, lock, suspend and quit and detach every listener on close", () => {
        const f = fixture();
        f.contents.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
        f.contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
        expect(mocks.reset).not.toHaveBeenCalled();
        f.contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
        f.contents.emit("render-process-gone");
        powerMonitor.emit("lock-screen");
        powerMonitor.emit("suspend");
        app.emit("before-quit", {});
        expect(mocks.reset).toHaveBeenCalledTimes(5);
        mocks.showHide!();
        expect(f.window.hide).toHaveBeenCalledOnce();
        mocks.send!({ id: "push_to_talk", pressed: false });
        expect(f.contents.send).toHaveBeenCalledWith("aether:global-shortcut", { id: "push_to_talk", pressed: false });
        f.window.emit("closed");
        expect(ipcMain.removeHandler).toHaveBeenCalledWith("aether:configure-global-shortcuts");
        expect(f.contents.listenerCount("did-start-navigation")).toBe(0);
        expect(powerMonitor.listenerCount("suspend")).toBe(0);
        expect(app.listenerCount("before-quit")).toBe(0);
    });
});
