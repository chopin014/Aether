/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import { DesktopKeybindsViewModel } from "./DesktopKeybindsViewModel";
import { DesktopShortcutManager } from "../../audio/desktop/DesktopShortcutManager";

const resume = vi.fn();
const manager = {
    subscribe: vi.fn(() => vi.fn()),
    getKey: vi.fn(() => ""),
    getStatus: vi.fn(() => "unbound"),
    getBackend: vi.fn(() => "focused"),
    suspend: vi.fn(() => resume),
    setKey: vi.fn(async () => {}),
};
let vm: DesktopKeybindsViewModel;
function create(): DesktopKeybindsViewModel {
    // A small manager fixture isolates recording from native registration, covered in its own tests.
    return (vm = new DesktopKeybindsViewModel(manager as unknown as DesktopShortcutManager));
}
afterEach(() => {
    vm?.dispose();
    vi.clearAllMocks();
});

describe("DesktopKeybindsViewModel", () => {
    it("records a normalized combination and resumes only after it has saved", async () => {
        create().record("toggle_mute");
        const event = new KeyboardEvent("keydown", { code: "KeyM", ctrlKey: true, cancelable: true });
        window.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
        expect(manager.setKey).toHaveBeenCalledWith("toggle_mute", "Control+KeyM");
        expect(resume).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(resume).toHaveBeenCalledOnce());
        expect(vm.getSnapshot().recording).toBeUndefined();
    });
    it("cancels recording on escape, blur and disposal without saving", () => {
        create().record("push_to_talk");
        window.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape" }));
        expect(vm.getSnapshot().recording).toBeUndefined();
        vm.record("push_to_talk");
        window.dispatchEvent(new Event("blur"));
        vm.record("push_to_talk");
        vm.dispose();
        expect(resume).toHaveBeenCalledTimes(3);
        expect(manager.setKey).not.toHaveBeenCalled();
    });
    it("supports a lone modifier, clearing and rejects unknown actions", async () => {
        create().record("push_to_talk");
        window.dispatchEvent(new KeyboardEvent("keyup", { code: "ControlLeft" }));
        expect(manager.setKey).toHaveBeenCalledWith("push_to_talk", "ControlLeft");
        vm.clear("toggle_mute");
        expect(manager.setKey).toHaveBeenCalledWith("toggle_mute", "");
        vm.record("unknown");
        expect(vm.getSnapshot().recording).toBeUndefined();
        await Promise.resolve();
    });
    it("surfaces save failures and keeps browser focus limits visible", async () => {
        manager.setKey.mockRejectedValueOnce(new Error("Storage failed"));
        create().clear("toggle_mute");
        await vi.waitFor(() => expect(vm.getSnapshot().error).toContain("Could not save"));
        expect(vm.getSnapshot().description).toContain("focused");
    });
});
