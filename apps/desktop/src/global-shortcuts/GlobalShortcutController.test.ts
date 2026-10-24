/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it, vi } from "vitest";
import { GlobalShortcutController, validateConfiguration } from "./GlobalShortcutController.js";
import type { ActionId, BackendFactory, ShortcutBinding, ShortcutEvent } from "./types.js";

const hold: ShortcutBinding = { id: "push_to_talk", key: "Control+KeyV", kind: "hold" };
function fixture() {
    let emit!: (id: ActionId, pressed: boolean) => void;
    let failed!: () => void;
    const dispose = vi.fn();
    const configure = vi.fn(async (bindings: ShortcutBinding[]) =>
        bindings.map(({ id }) => ({ id, status: "registered" as const })),
    );
    const factory: BackendFactory = async (event, error) => {
        emit = event;
        failed = error;
        return { name: "native", configure, dispose };
    };
    const send = vi.fn<(event: ShortcutEvent) => void>();
    const showHide = vi.fn();
    const controller = new GlobalShortcutController(factory, send, showHide);
    return {
        controller,
        send,
        showHide,
        dispose,
        configure,
        emit: (id: ActionId, pressed: boolean) => emit(id, pressed),
        failed: () => failed(),
    };
}

describe("GlobalShortcutController", () => {
    it("should deliver both hold edges and suppress repeats and unknown actions", async () => {
        const f = fixture();
        await f.controller.configure({ enabled: true, bindings: [hold] });
        f.send.mockClear();
        f.emit("push_to_talk", true);
        f.emit("push_to_talk", true);
        f.emit("toggle_mute", true);
        f.emit("push_to_talk", false);
        expect(f.send.mock.calls.map(([event]) => event)).toEqual([
            { id: "push_to_talk", pressed: true },
            { id: "push_to_talk", pressed: false },
        ]);
    });
    it("should emit toggles once per press and control the actual show hide action", async () => {
        const f = fixture();
        await f.controller.configure({
            enabled: true,
            bindings: [{ id: "show_hide", key: "Control+KeyH", kind: "toggle" }],
        });
        f.send.mockClear();
        f.emit("show_hide", true);
        f.emit("show_hide", true);
        f.emit("show_hide", false);
        f.emit("show_hide", true);
        expect(f.showHide).toHaveBeenCalledTimes(2);
        expect(f.send.mock.calls.map(([event]) => event)).toEqual([
            { id: "show_hide", pressed: true },
            { id: "show_hide", pressed: false },
            { id: "show_hide", pressed: true },
        ]);
    });
    it.each(["toggle_mute", "toggle_deafen", "toggle_input_mode"] as const)(
        "should rearm the renderer pressed-state consumer for repeated %s activations",
        async (id) => {
            const f = fixture();
            const rendererPressed = new Set<ActionId>();
            const activate = vi.fn();
            f.send.mockImplementation((event) => {
                if (!event.pressed) {
                    rendererPressed.delete(event.id);
                    return;
                }
                if (rendererPressed.has(event.id)) return;
                rendererPressed.add(event.id);
                activate(event.id);
            });
            await f.controller.configure({ enabled: true, bindings: [{ id, key: "Control+KeyM", kind: "toggle" }] });
            f.emit(id, true);
            f.emit(id, true);
            f.emit(id, false);
            f.emit(id, false);
            f.emit(id, true);
            expect(activate.mock.calls).toEqual([[id], [id]]);
            f.controller.reset();
            expect(rendererPressed.has(id)).toBe(false);
            expect(f.send).toHaveBeenLastCalledWith({ id, pressed: false, reset: true });
        },
    );
    it.each(["disable", "reset", "error"])(
        "should release holds on %s and ignore stale backend events",
        async (reason) => {
            const f = fixture();
            await f.controller.configure({ enabled: true, bindings: [hold] });
            f.send.mockClear();
            f.emit("push_to_talk", true);
            if (reason === "disable") await f.controller.configure({ enabled: false, bindings: [hold] });
            else if (reason === "error") f.failed();
            else f.controller.reset();
            expect(f.send).toHaveBeenCalledWith({ id: "push_to_talk", pressed: false, reset: true });
            expect(f.dispose).toHaveBeenCalledOnce();
            f.send.mockClear();
            f.emit("push_to_talk", true);
            expect(f.send).not.toHaveBeenCalled();
        },
    );
    it("should report duplicate canonical chords and invalid keys without passing them to native code", async () => {
        const f = fixture();
        const result = await f.controller.configure({
            enabled: true,
            bindings: [
                { ...hold, key: "Alt+Control+KeyV" },
                { id: "toggle_mute", key: "Control+Alt+KeyV", kind: "toggle" },
                { id: "toggle_deafen", key: "invalid", kind: "toggle" },
            ],
        });
        expect(result.bindings).toContainEqual({ id: "toggle_mute", status: "conflict" });
        expect(result.bindings).toContainEqual({ id: "toggle_deafen", status: "invalid" });
        expect(f.configure.mock.calls[0][0]).toHaveLength(1);
    });
    it("should reject invalid IPC envelopes before resetting registrations", async () => {
        const f = fixture();
        await f.controller.configure({ enabled: true, bindings: [hold] });
        f.send.mockClear();
        for (const value of [
            null,
            {},
            { enabled: 1, bindings: [] },
            { enabled: true, bindings: [hold, hold] },
            { enabled: true, bindings: [{ ...hold, id: "exec" }] },
            { enabled: true, bindings: [{ ...hold, key: "x".repeat(81) }] },
            { enabled: true, bindings: [{ ...hold, kind: "toggle" }] },
        ]) {
            expect(() => validateConfiguration(value)).toThrow();
        }
        expect(f.dispose).not.toHaveBeenCalled();
    });
    it("should dispose a backend that resolves after the renderer has gone", async () => {
        let resolve!: (value: Awaited<ReturnType<BackendFactory>>) => void;
        const dispose = vi.fn();
        const controller = new GlobalShortcutController(
            () =>
                new Promise((done) => {
                    resolve = done;
                }),
            vi.fn(),
            vi.fn(),
        );
        const pending = controller.configure({ enabled: true, bindings: [hold] });
        controller.reset();
        resolve({ name: "native", configure: vi.fn(), dispose });
        await pending;
        expect(dispose).toHaveBeenCalledOnce();
    });
    it("should cancel both hold delays even after the key has already been released", async () => {
        const f = fixture();
        await f.controller.configure({ enabled: true, bindings: [hold] });
        f.emit("push_to_talk", true);
        f.emit("push_to_talk", false);
        f.send.mockClear();
        f.controller.reset();
        expect(f.send.mock.calls.map(([event]) => event)).toEqual([
            { id: "push_to_talk", pressed: false, reset: true },
            { id: "push_to_mute", pressed: false, reset: true },
        ]);
    });
    it("should report unsupported when native startup fails", async () => {
        const controller = new GlobalShortcutController(
            async () => {
                throw new Error("No display");
            },
            vi.fn(),
            vi.fn(),
        );
        expect(await controller.configure({ enabled: true, bindings: [hold] })).toEqual({
            backend: "unsupported",
            bindings: [{ id: hold.id, status: "unsupported" }],
        });
    });
});
