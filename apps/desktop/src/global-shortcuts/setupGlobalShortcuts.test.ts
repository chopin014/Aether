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
vi.mock("./GlobalShortcutController.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./GlobalShortcutController.js")>()),
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
        mocks.reset.mockReset();
        mocks.configure.mockResolvedValue({ backend: "unsupported", bindings: [] });
    });
    it("cleans up after the native window closes without reading its destroyed webContents getter", () => {
        const f = fixture();
        Object.defineProperty(f.window, "webContents", {
            get: () => {
                throw new Error("Object has been destroyed");
            },
        });
        vi.spyOn(f.contents, "isDestroyed").mockReturnValue(true);
        mocks.reset.mockImplementation(() => mocks.send!({ id: "push_to_talk", pressed: false }));
        expect(() => f.window.emit("closed")).not.toThrow();
        expect(f.contents.send).not.toHaveBeenCalled();
        expect(powerMonitor.listenerCount("suspend")).toBe(0);
        expect(ipcMain.removeHandler).toHaveBeenCalledWith("aether:configure-global-shortcuts");
    });
    function fixture(enabled = true) {
        const mainFrame = {};
        const contents = Object.assign(new EventEmitter(), {
            mainFrame,
            isDestroyed: (): boolean => false,
            send: vi.fn(),
        });
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
    it("should restore the last validated configuration only after both lock and suspend end", () => {
        const f = fixture();
        const configuration = { enabled: true, bindings: [{ id: "push_to_talk", key: "Control+KeyV", kind: "hold" }] };
        f.handler(f.event, configuration);
        powerMonitor.emit("lock-screen");
        powerMonitor.emit("suspend");
        powerMonitor.emit("resume");
        expect(mocks.configure).toHaveBeenCalledTimes(1);
        powerMonitor.emit("unlock-screen");
        expect(mocks.configure).toHaveBeenCalledTimes(2);
        expect(mocks.configure).toHaveBeenLastCalledWith(configuration);
        powerMonitor.emit("unlock-screen");
        expect(mocks.configure).toHaveBeenCalledTimes(2);
        f.dispose();
    });
    it.each(["disabled", "navigation", "crash", "dispose", "quit"])("should not restore after %s", (reason) => {
        const f = fixture();
        f.handler(f.event, { enabled: true, bindings: [{ id: "push_to_talk", key: "KeyV", kind: "hold" }] });
        powerMonitor.emit("lock-screen");
        if (reason === "disabled") f.handler(f.event, { enabled: false, bindings: [] });
        else if (reason === "navigation")
            f.contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
        else if (reason === "crash") f.contents.emit("render-process-gone");
        else if (reason === "quit") app.emit("before-quit", {});
        else f.dispose();
        mocks.configure.mockClear();
        powerMonitor.emit("unlock-screen");
        powerMonitor.emit("resume");
        expect(mocks.configure).not.toHaveBeenCalled();
        if (reason !== "dispose") f.dispose();
    });
    it("should defer configurations received while blocked and preserve the last valid envelope", () => {
        const f = fixture();
        powerMonitor.emit("suspend");
        const configuration = { enabled: true, bindings: [{ id: "push_to_talk", key: "KeyV", kind: "hold" }] };
        f.handler(f.event, configuration);
        expect(mocks.configure).toHaveBeenLastCalledWith({ ...configuration, enabled: false });
        expect(() => f.handler(f.event, { enabled: true, bindings: [{ id: "exec" }] })).toThrow();
        configuration.bindings[0].key = "KeyM";
        powerMonitor.emit("resume");
        expect(mocks.configure).toHaveBeenLastCalledWith({
            enabled: true,
            bindings: [{ id: "push_to_talk", key: "KeyV", kind: "hold" }],
        });
        f.dispose();
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
