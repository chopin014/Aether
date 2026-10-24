/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import SettingsStore from "../../settings/SettingsStore";
import { SettingLevel } from "../../settings/SettingLevel";
import {
    DesktopShortcutManager,
    normalizeDesktopShortcut,
    type GlobalShortcutApi,
    type DesktopShortcutEvent,
} from "./DesktopShortcutManager";

let values: Record<string, unknown>;
let watchers: Map<string, () => void>;
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
    watchers = new Map();
    vi.spyOn(SettingsStore, "getValue").mockImplementation((name) => values[name] as never);
    vi.spyOn(SettingsStore, "watchSetting").mockImplementation((name, _room, listener) => {
        watchers.set(name, listener as () => void);
        return name;
    });
    vi.spyOn(SettingsStore, "unwatchSetting").mockImplementation((ref) => {
        if (ref) watchers.delete(ref);
    });
    vi.spyOn(SettingsStore, "setValue").mockImplementation(async (name, _room, _level, value) => {
        values[name] = value;
        watchers.get(name)?.();
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
        expect(manager.isHeld("push_to_talk")).toBe(true);
        expect(listener.mock.lastCall?.[0]).toEqual({ id: "push_to_talk", pressed: true });
    });
    it("keeps native registrations and push to mute held when input mode changes", async () => {
        values.desktopShortcutBindings = { push_to_mute: "Control+KeyP" };
        stop = manager.start();
        await flush();
        nativeEvent({ id: "push_to_mute", pressed: true });
        expect(manager.isHeld("push_to_mute")).toBe(true);
        const listener = vi.fn();
        manager.onEvent(listener);
        vi.mocked(api.configure).mockClear();
        await SettingsStore.setValue("desktopInputMode", null, SettingLevel.DEVICE, "voice_activity");
        await Promise.resolve();
        expect(api.configure).not.toHaveBeenCalled();
        expect(listener).not.toHaveBeenCalled();
        expect(manager.isHeld("push_to_mute")).toBe(true);
        nativeEvent({ id: "push_to_mute", pressed: false });
        expect(manager.isHeld("push_to_mute")).toBe(false);
        expect(listener).toHaveBeenCalledWith({ id: "push_to_mute", pressed: false });
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
    it("fails closed when registration rejects and refuses invalid persisted keys", async () => {
        vi.mocked(api.configure).mockRejectedValueOnce(new Error("Permission denied"));
        values.desktopPushToTalkKey = "Super+Invalid";
        stop = manager.start();
        await flush();
        expect(manager.getStatus("push_to_talk")).toBe("invalid");
        expect(manager.getStatus("toggle_mute")).toBe("unsupported");
        await expect(manager.setKey("push_to_talk", "Bad+KeyV")).rejects.toThrow("Invalid shortcut");
        const listener = vi.fn();
        manager.onEvent(listener);
        nativeEvent({ id: "toggle_mute", pressed: true });
        expect(listener).not.toHaveBeenCalled();
    });
    it("cannot reactivate a stale registration result after recording begins", async () => {
        let resolve: (result: Awaited<ReturnType<GlobalShortcutApi["configure"]>>) => void = () => {};
        vi.mocked(api.configure).mockImplementationOnce(
            () =>
                new Promise((done) => {
                    resolve = done;
                }),
        );
        stop = manager.start();
        await vi.waitFor(() => expect(api.configure).toHaveBeenCalledOnce());
        const resume = manager.suspend();
        resolve({ backend: "native", bindings: [{ id: "push_to_talk", status: "registered" }] });
        await vi.waitFor(() => expect(api.configure).toHaveBeenLastCalledWith({ enabled: false, bindings: [] }));
        expect(manager.getStatus("push_to_talk")).toBe("paused");
        resume();
        await vi.waitFor(() => expect(manager.getStatus("push_to_talk")).toBe("registered"));
    });
    it.each(["input", "textarea", "div"])(
        "allows explicit chords from a focused %s while preserving bare-letter typing",
        (tag) => {
            values.desktopShortcutBindings = { toggle_mute: "Control+Shift+KeyM", toggle_deafen: "F8" };
            manager = new DesktopShortcutManager(window, undefined);
            stop = manager.start();
            const input = document.createElement(tag);
            if (tag === "div") input.contentEditable = "true";
            document.body.append(input);
            input.focus();
            const listener = vi.fn();
            manager.onEvent(listener);
            const chord = new KeyboardEvent("keydown", {
                code: "KeyM",
                ctrlKey: true,
                shiftKey: true,
                bubbles: true,
                cancelable: true,
            });
            input.dispatchEvent(chord);
            expect(chord.defaultPrevented).toBe(true);
            expect(listener).toHaveBeenCalledWith({ id: "toggle_mute", pressed: true });
            input.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyM", bubbles: true }));
            listener.mockClear();
            const letter = new KeyboardEvent("keydown", { code: "KeyV", bubbles: true, cancelable: true });
            input.dispatchEvent(letter);
            expect(listener).not.toHaveBeenCalled();
            expect(letter.defaultPrevented).toBe(false);
            input.dispatchEvent(new KeyboardEvent("keydown", { code: "F8", bubbles: true }));
            expect(listener).toHaveBeenCalledWith({ id: "toggle_deafen", pressed: true });
            input.remove();
        },
    );
    it("respects keyboard events already consumed by an editor", () => {
        manager = new DesktopShortcutManager(window, undefined);
        stop = manager.start();
        const input = document.createElement("input");
        document.body.append(input);
        input.addEventListener("keydown", (event) => event.preventDefault());
        const listener = vi.fn();
        manager.onEvent(listener);
        input.dispatchEvent(
            new KeyboardEvent("keydown", { code: "KeyM", ctrlKey: true, bubbles: true, cancelable: true }),
        );
        expect(listener).not.toHaveBeenCalled();
        input.remove();
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
