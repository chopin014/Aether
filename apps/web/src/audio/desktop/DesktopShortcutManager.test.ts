/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import SettingsStore from "../../settings/SettingsStore";
import {
    DesktopShortcutManager,
    normalizeDesktopShortcut,
    type GlobalShortcutApi,
    type DesktopShortcutEvent,
} from "./DesktopShortcutManager";

let values: Record<string, unknown>;
let watchers: Set<() => void>;
let nativeEvent: (event: DesktopShortcutEvent) => void;
let api: GlobalShortcutApi;
let manager: DesktopShortcutManager;
let stop: (() => void) | undefined;
const flush = async (): Promise<void> => {
    await vi.waitFor(() => expect(api.configure).toHaveBeenCalled());
    await Promise.resolve();
};

beforeEach(() => {
    values = {
        feature_desktop_shell: true,
        desktopShortcutBindings: { toggle_mute: "Control+KeyM" },
        desktopPushToTalkKey: "KeyV",
        desktopInputMode: "push_to_talk",
    };
    watchers = new Set();
    vi.spyOn(SettingsStore, "getValue").mockImplementation((name) => values[name] as never);
    vi.spyOn(SettingsStore, "watchSetting").mockImplementation((_name, _room, listener) => {
        watchers.add(listener as () => void);
        return "watcher";
    });
    vi.spyOn(SettingsStore, "unwatchSetting").mockImplementation(() => {});
    vi.spyOn(SettingsStore, "setValue").mockImplementation(async (name, _room, _level, value) => {
        values[name] = value;
        watchers.forEach((listener) => listener());
    });
    api = {
        configure: vi.fn<GlobalShortcutApi["configure"]>(async ({ bindings }) => ({
            backend: "native",
            bindings: bindings.map(({ id }) => ({ id, status: "registered" })),
        })),
        onEvent: vi.fn((listener) => {
            nativeEvent = listener;
            return vi.fn();
        }),
    };
    manager = new DesktopShortcutManager(window, api);
});
afterEach(() => {
    stop?.();
    stop = undefined;
    vi.restoreAllMocks();
});

describe("desktop shortcut validation", () => {
    it("normalizes supported combinations and rejects unknown codes/modifiers", () => {
        expect(normalizeDesktopShortcut("Shift+Control+KeyV")).toBe("Control+Shift+KeyV");
        expect(normalizeDesktopShortcut("Super+KeyV")).toBeNull();
        expect(normalizeDesktopShortcut("Control+Control+KeyV")).toBeNull();
        expect(normalizeDesktopShortcut("KeyINVALID")).toBeNull();
        expect(normalizeDesktopShortcut("")).toBe("");
    });
});
describe("DesktopShortcutManager", () => {
    it("persists PTT in its original setting and other shortcuts together", async () => {
        stop = manager.start();
        await manager.setKey("push_to_talk", "Alt+KeyP");
        await manager.setKey("toggle_deafen", "Control+KeyD");
        expect(values.desktopPushToTalkKey).toBe("Alt+KeyP");
        expect(values.desktopShortcutBindings).toEqual({ toggle_mute: "Control+KeyM", toggle_deafen: "Control+KeyD" });
    });
    it("blocks both duplicate combinations and unregisters a cleared binding", async () => {
        stop = manager.start();
        await manager.setKey("push_to_talk", "Control+KeyM");
        await flush();
        expect(manager.getStatus("push_to_talk")).toBe("conflict");
        expect(manager.getStatus("toggle_mute")).toBe("conflict");
        await manager.setKey("toggle_mute", "");
        await vi.waitFor(() => expect(manager.getStatus("push_to_talk")).toBe("registered"));
        expect(manager.getStatus("toggle_mute")).toBe("unbound");
        expect(vi.mocked(api.configure).mock.lastCall?.[0].bindings.map((row) => row.id)).not.toContain("toggle_mute");
    });
    it("ignores unknown/unbound events and key-repeat, and resets holds immediately", async () => {
        const listener = vi.fn();
        manager.onEvent(listener);
        stop = manager.start();
        await flush();
        listener.mockClear();
        nativeEvent({ id: "unknown", pressed: true });
        nativeEvent({ id: "toggle_deafen", pressed: true });
        nativeEvent({ id: "push_to_talk", pressed: true });
        nativeEvent({ id: "push_to_talk", pressed: true });
        expect(listener).toHaveBeenCalledTimes(1);
        nativeEvent({ id: "push_to_talk", pressed: false, reset: true });
        expect(listener).toHaveBeenCalledWith({ id: "push_to_talk", pressed: false, reset: true });
        nativeEvent({ id: "push_to_talk", pressed: true });
        expect(listener.mock.lastCall?.[0]).toEqual({ id: "push_to_talk", pressed: true });
    });
    it("pauses native events and registrations throughout nested recording", async () => {
        stop = manager.start();
        await flush();
        const resume = manager.suspend();
        const resumeOther = manager.suspend();
        const listener = vi.fn();
        manager.onEvent(listener);
        nativeEvent({ id: "push_to_talk", pressed: true });
        expect(listener).not.toHaveBeenCalled();
        resume();
        await vi.waitFor(() => expect(api.configure).toHaveBeenLastCalledWith({ enabled: false, bindings: [] }));
        expect(manager.getStatus("push_to_talk")).toBe("paused");
        resumeOther();
        await vi.waitFor(() => expect(manager.getStatus("push_to_talk")).toBe("registered"));
    });
    it("survives setup-cleanup-setup without stale native registrations", async () => {
        const firstStop = manager.start();
        firstStop();
        firstStop();
        stop = manager.start();
        await flush();
        expect(api.configure).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true }));
        stop();
        stop = undefined;
        await vi.waitFor(() => expect(api.configure).toHaveBeenLastCalledWith({ enabled: false, bindings: [] }));
        expect(api.onEvent).toHaveBeenCalledTimes(2);
    });
    it("reports missing and rejected native registrations honestly", async () => {
        vi.mocked(api.configure).mockResolvedValue({
            backend: "portal",
            bindings: [{ id: "push_to_talk", status: "conflict" }],
        });
        stop = manager.start();
        await flush();
        expect(manager.getStatus("push_to_talk")).toBe("conflict");
        expect(manager.getStatus("toggle_mute")).toBe("unsupported");
    });
    it("does not register or run anything when the desktop flag is off", async () => {
        values.feature_desktop_shell = false;
        stop = manager.start();
        await flush();
        expect(api.configure).toHaveBeenLastCalledWith({ enabled: false, bindings: [] });
        const listener = vi.fn();
        manager.onEvent(listener);
        nativeEvent({ id: "push_to_talk", pressed: true });
        expect(listener).not.toHaveBeenCalled();
    });
    it("has a focused browser fallback without claiming global support", () => {
        manager = new DesktopShortcutManager(window, undefined);
        stop = manager.start();
        expect(manager.getStatus("push_to_talk")).toBe("focused");
        const listener = vi.fn();
        manager.onEvent(listener);
        window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyV" }));
        expect(listener).toHaveBeenCalledWith({ id: "push_to_talk", pressed: true });
        window.dispatchEvent(new Event("blur"));
        expect(listener).toHaveBeenCalledWith({ id: "push_to_talk", pressed: false, reset: true });
    });
});
