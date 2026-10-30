/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@test-utils";
import userEvent from "@testing-library/user-event";

import { DeleteServerView, type DeleteServerViewSnapshot } from "./DeleteServerView";
import { MockViewModel } from "../../core/viewmodel";

function show(snapshot: Partial<DeleteServerViewSnapshot> = {}) {
    const vm = Object.assign(
        new MockViewModel<DeleteServerViewSnapshot>({
            name: "Community",
            rooms: [
                { id: "!text:test", name: "general", kind: "text" },
                { id: "!voice:test", name: "Lounge", kind: "voice" },
            ],
            busy: false,
            ready: true,
            confirmation: "",
            ...snapshot,
        }),
        { confirm: vi.fn(), cancel: vi.fn(), setConfirmation: vi.fn() },
    );
    render(<DeleteServerView vm={vm} />);
    return vm;
}

describe("DeleteServerView", () => {
    it("lists affected channels and requires the server name", async () => {
        const vm = show();
        expect(screen.getByRole("list", { name: "Channels and nested servers to delete" })).toBeVisible();
        expect(screen.getByText("general")).toBeVisible();
        expect(screen.getByText("Lounge")).toBeVisible();
        expect(screen.getByRole("button", { name: "Delete server" })).toBeDisabled();
        await userEvent.type(screen.getByRole("textbox", { name: "Type Community to confirm" }), "C");
        expect(vm.setConfirmation).toHaveBeenCalledWith("C");
    });

    it("allows confirmation when the entered name matches", async () => {
        const vm = show({ confirmation: "Community" });
        await userEvent.click(screen.getByRole("button", { name: "Delete server" }));
        expect(vm.confirm).toHaveBeenCalledOnce();
        await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(vm.cancel).toHaveBeenCalledOnce();
    });

    it("announces progress and prevents dismissal while busy", () => {
        show({ busy: true, ready: false, progress: "Checking every channel…" });
        expect(screen.getByRole("status")).toHaveTextContent("Checking every channel…");
        expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Delete server" })).toBeDisabled();
        expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    });

    it("allows retrying a failed permission check", async () => {
        const vm = show({ ready: false, error: "Cannot delete Lounge." });
        expect(screen.getByRole("alert")).toHaveTextContent("Cannot delete Lounge.");
        await userEvent.click(screen.getByRole("button", { name: "Retry" }));
        expect(vm.confirm).toHaveBeenCalledOnce();
    });
});
