/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { type Room } from "matrix-js-sdk/src/matrix";
import { createTestClient, flushPromises, mkStubRoom } from "test-utils";

import { CategoryDialogViewModel } from "./CategoryDialogViewModel";
import * as actions from "../../stores/space-layout/spaceLayoutActions";

const CATEGORY = "c_7e50cc0b-4fb5-4ed0-89db-769fb11c837e";

describe("CategoryDialogViewModel", () => {
    let space: Room;
    let onFinished: Mock<() => void>;

    beforeEach(() => {
        space = mkStubRoom("!space:example.org", "Server", createTestClient());
        onFinished = vi.fn();
    });

    afterEach(() => vi.restoreAllMocks());

    it("creates a category from the typed name", async () => {
        const create = vi.spyOn(actions, "createCategory").mockResolvedValue(CATEGORY);
        const vm = new CategoryDialogViewModel({ space, onFinished });
        expect(vm.getSnapshot()).toMatchObject({ mode: "create", name: "", canSubmit: false });
        vm.setName("  Governo ");
        expect(vm.getSnapshot().canSubmit).toBe(true);
        const submitting = vm.submit();
        expect(vm.getSnapshot().busy).toBe(true);
        await submitting;
        expect(create).toHaveBeenCalledWith(space, "  Governo ");
        expect(onFinished).toHaveBeenCalled();
    });

    it("won't submit an empty name", async () => {
        const create = vi.spyOn(actions, "createCategory");
        const vm = new CategoryDialogViewModel({ space, onFinished });
        vm.setName("   ");
        await vm.submit();
        expect(create).not.toHaveBeenCalled();
        expect(onFinished).not.toHaveBeenCalled();
    });

    it("renames a category, and closes without a request when the name is unchanged", async () => {
        const rename = vi.spyOn(actions, "renameCategory").mockResolvedValue();
        const vm = new CategoryDialogViewModel({ space, categoryId: CATEGORY, currentName: "Geral", onFinished });
        expect(vm.getSnapshot()).toMatchObject({ mode: "rename", name: "Geral", canSubmit: true });
        await vm.submit();
        expect(rename).not.toHaveBeenCalled();
        expect(onFinished).toHaveBeenCalledTimes(1);
        vm.setName("Governo");
        await vm.submit();
        expect(rename).toHaveBeenCalledWith(space, CATEGORY, "Governo");
    });

    it("keeps the dialog open with an error when saving fails", async () => {
        vi.spyOn(actions, "createCategory").mockRejectedValue(new Error("M_FORBIDDEN"));
        const vm = new CategoryDialogViewModel({ space, onFinished });
        vm.setName("Governo");
        await vm.submit();
        await flushPromises();
        expect(vm.getSnapshot()).toMatchObject({ busy: false, error: expect.any(String) });
        expect(onFinished).not.toHaveBeenCalled();
        vm.setName("Governo 2");
        expect(vm.getSnapshot().error).toBeUndefined();
    });

    it("closes on cancel", () => {
        new CategoryDialogViewModel({ space, onFinished }).cancel();
        expect(onFinished).toHaveBeenCalled();
    });
});
