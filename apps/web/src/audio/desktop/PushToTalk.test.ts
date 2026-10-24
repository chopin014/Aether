/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    describePushToTalkKey,
    formatPushToTalkKey,
    isModifierCode,
    parsePushToTalkKey,
    PushToTalkController,
    pushToTalkBindingFromEvent,
    pushToTalkBindingFromModifier,
} from "./PushToTalk";

function key(
    type: "keydown" | "keyup",
    code: string,
    init: KeyboardEventInit = {},
    target: EventTarget = window,
): void {
    const event = new KeyboardEvent(type, { code, bubbles: true, ...init });
    target.dispatchEvent(event);
}

describe("push to talk bindings", () => {
    it("round-trips a key with modifiers", () => {
        const binding = parsePushToTalkKey("Control+Shift+KeyV");
        expect(binding).toEqual({ code: "KeyV", ctrl: true, alt: false, shift: true, meta: false });
        expect(formatPushToTalkKey(binding!)).toBe("Control+Shift+KeyV");
    });

    it("writes modifiers in a fixed order", () => {
        expect(formatPushToTalkKey({ code: "F5", ctrl: false, alt: true, shift: false, meta: true })).toBe(
            "Alt+Meta+F5",
        );
    });

    it("reads nothing from an empty value", () => {
        expect(parsePushToTalkKey("")).toBeNull();
        expect(describePushToTalkKey("")).toBe("");
    });

    it("describes keys for people", () => {
        expect(describePushToTalkKey("KeyV")).toBe("V");
        expect(describePushToTalkKey("Control+Digit1")).toBe("Ctrl + 1");
        expect(describePushToTalkKey("ControlLeft")).toBe("Left Ctrl");
        expect(describePushToTalkKey("Alt+Backquote")).toBe("Alt + Backquote");
        expect(describePushToTalkKey("Space")).toBe("Space");
    });

    it("takes a binding from a key press but not from a bare modifier", () => {
        expect(pushToTalkBindingFromEvent(new KeyboardEvent("keydown", { code: "KeyG", altKey: true }))).toEqual({
            code: "KeyG",
            ctrl: false,
            alt: true,
            shift: false,
            meta: false,
        });
        expect(pushToTalkBindingFromEvent(new KeyboardEvent("keydown", { code: "ShiftLeft" }))).toBeNull();
        expect(isModifierCode("ShiftLeft")).toBe(true);
        expect(pushToTalkBindingFromModifier("ShiftLeft").code).toBe("ShiftLeft");
    });
});

describe("PushToTalkController", () => {
    let controller: PushToTalkController;
    let changes: boolean[];

    beforeEach(() => {
        vi.useFakeTimers();
        controller = new PushToTalkController(window);
        changes = [];
        controller.onChange((active) => changes.push(active));
    });

    afterEach(() => {
        controller.stop();
        vi.useRealTimers();
    });

    it("cancels a native release delay on reset and binding changes", () => {
        controller.configure("KeyV", 200);
        controller.setPressed(true);
        controller.setPressed(false);
        expect(controller.active).toBe(true);
        controller.setPressed(false, true);
        expect(controller.active).toBe(false);
        vi.advanceTimersByTime(500);
        expect(changes).toEqual([true, false]);
        controller.setPressed(true);
        controller.configure("KeyB", 200);
        expect(controller.active).toBe(false);
        controller.configure("", 0);
        controller.setPressed(true);
        expect(controller.active).toBe(false);
    });

    it("opens on key down and closes on key up without a delay", () => {
        controller.configure("KeyV", 0);
        controller.start();
        key("keydown", "KeyV");
        expect(controller.active).toBe(true);
        key("keyup", "KeyV");
        expect(controller.active).toBe(false);
        expect(changes).toEqual([true, false]);
    });

    it("keeps the microphone open for the release delay", () => {
        controller.configure("KeyV", 300);
        controller.start();
        key("keydown", "KeyV");
        key("keyup", "KeyV");
        vi.advanceTimersByTime(299);
        expect(controller.active).toBe(true);
        vi.advanceTimersByTime(1);
        expect(controller.active).toBe(false);
        expect(changes).toEqual([true, false]);
    });

    it("stays open without a gap when the key is pressed again during the delay", () => {
        controller.configure("KeyV", 300);
        controller.start();
        key("keydown", "KeyV");
        key("keyup", "KeyV");
        vi.advanceTimersByTime(200);
        key("keydown", "KeyV");
        vi.advanceTimersByTime(1000);
        expect(controller.active).toBe(true);
        expect(changes).toEqual([true]);
        key("keyup", "KeyV");
        vi.advanceTimersByTime(300);
        expect(changes).toEqual([true, false]);
    });

    it("ignores key repeat and other keys", () => {
        controller.configure("KeyV", 0);
        controller.start();
        key("keydown", "KeyB");
        expect(controller.active).toBe(false);
        key("keydown", "KeyV");
        key("keydown", "KeyV", { repeat: true });
        key("keyup", "KeyB");
        expect(controller.active).toBe(true);
        expect(changes).toEqual([true]);
    });

    it("needs the modifiers of the binding", () => {
        controller.configure("Control+KeyV", 0);
        controller.start();
        key("keydown", "KeyV");
        expect(controller.active).toBe(false);
        key("keydown", "KeyV", { ctrlKey: true });
        expect(controller.active).toBe(true);
        // The modifier may be released first; the key's own release is what closes it.
        key("keyup", "ControlLeft");
        expect(controller.active).toBe(true);
        key("keyup", "KeyV");
        expect(controller.active).toBe(false);
    });

    it("works with a modifier bound on its own", () => {
        controller.configure("ControlRight", 0);
        controller.start();
        key("keydown", "ControlRight", { ctrlKey: true });
        expect(controller.active).toBe(true);
        key("keyup", "ControlRight");
        expect(controller.active).toBe(false);
    });

    it("does not treat typing in a text field as a press, unless a modifier is part of the key", () => {
        const input = document.createElement("input");
        document.body.append(input);
        controller.configure("KeyV", 0);
        controller.start();
        key("keydown", "KeyV", {}, input);
        expect(controller.active).toBe(false);
        controller.configure("Control+KeyV", 0);
        key("keydown", "KeyV", { ctrlKey: true }, input);
        expect(controller.active).toBe(true);
        controller.configure("F8", 0);
        key("keyup", "KeyV");
        key("keydown", "F8", {}, input);
        expect(controller.active).toBe(true);
        input.remove();
    });

    it("closes at once when the window loses focus, even during the delay", () => {
        controller.configure("KeyV", 500);
        controller.start();
        key("keydown", "KeyV");
        window.dispatchEvent(new Event("blur"));
        expect(controller.active).toBe(false);
        vi.advanceTimersByTime(1000);
        expect(changes).toEqual([true, false]);
    });

    it("closes when the key is cleared or listening stops", () => {
        controller.configure("KeyV", 500);
        controller.start();
        key("keydown", "KeyV");
        controller.configure("", 500);
        expect(controller.active).toBe(false);
        controller.configure("KeyV", 500);
        key("keydown", "KeyV");
        controller.stop();
        expect(controller.active).toBe(false);
        key("keydown", "KeyV");
        expect(controller.active).toBe(false);
    });

    it("does nothing before a key is bound", () => {
        controller.start();
        key("keydown", "KeyV");
        expect(controller.active).toBe(false);
    });
});
