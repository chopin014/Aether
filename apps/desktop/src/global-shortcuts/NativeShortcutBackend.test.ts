/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { uIOhook, UiohookKey } from "uiohook-napi";
import { NativeShortcutBackend } from "./NativeShortcutBackend.js";

function fixture() {
    const hook = Object.assign(new EventEmitter(), { start: vi.fn(), stop: vi.fn() });
    const registrar = { register: vi.fn(() => true), unregister: vi.fn() };
    const emit = vi.fn();
    const failed = vi.fn();
    const keys = {
        V: 47,
        M: 50,
        Ctrl: 29,
        CtrlRight: 3613,
        Alt: 56,
        AltRight: 3640,
        Shift: 42,
        ShiftRight: 54,
        Meta: 3675,
        MetaRight: 3676,
    };
    const backend = new NativeShortcutBackend(
        hook as unknown as typeof uIOhook,
        keys as typeof UiohookKey,
        registrar,
        emit,
        failed,
    );
    return { hook, registrar, emit, failed, backend };
}

describe("NativeShortcutBackend", () => {
    it("should observe release outside the window and release when a modifier is lifted first", async () => {
        const f = fixture();
        await f.backend.configure([{ id: "push_to_talk", key: "Control+KeyV", kind: "hold" }]);
        f.hook.emit("keydown", { keycode: 29 });
        f.hook.emit("keydown", { keycode: 47 });
        expect(f.emit).toHaveBeenLastCalledWith("push_to_talk", true);
        const count = f.emit.mock.calls.length;
        f.hook.emit("keydown", { keycode: 47 });
        expect(f.emit).toHaveBeenCalledTimes(count);
        f.hook.emit("keyup", { keycode: 29 });
        expect(f.emit).toHaveBeenLastCalledWith("push_to_talk", false);
        f.hook.emit("keyup", { keycode: 47 });
        expect(f.emit).toHaveBeenLastCalledWith("push_to_talk", false);
        f.backend.dispose();
        expect(f.registrar.unregister).toHaveBeenCalledWith("Control+V");
        expect(f.hook.stop).toHaveBeenCalledOnce();
        expect(f.hook.listenerCount("keydown")).toBe(0);
    });
    it("should report conflicts and unsupported bare modifiers", async () => {
        const f = fixture();
        f.registrar.register.mockReturnValue(false);
        expect(
            await f.backend.configure([
                { id: "toggle_mute", key: "Control+KeyM", kind: "toggle" },
                { id: "push_to_talk", key: "ControlLeft", kind: "hold" },
            ]),
        ).toEqual([
            { id: "toggle_mute", status: "conflict" },
            { id: "push_to_talk", status: "unsupported" },
        ]);
        f.hook.emit("keydown", { keycode: 50 });
        expect(f.emit).not.toHaveBeenCalled();
        f.backend.dispose();
        expect(f.registrar.unregister).not.toHaveBeenCalled();
    });
    it("should never re-trigger a toggle when an unrelated modifier is lifted", async () => {
        const f = fixture();
        await f.backend.configure([{ id: "toggle_mute", key: "KeyM", kind: "toggle" }]);
        f.hook.emit("keydown", { keycode: 50 });
        f.hook.emit("keydown", { keycode: 42 });
        f.hook.emit("keyup", { keycode: 42 });
        expect(f.emit.mock.calls.filter(([, pressed]) => pressed)).toHaveLength(1);
        f.backend.dispose();
    });
});
