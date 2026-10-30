/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@test-utils";
import userEvent from "@testing-library/user-event";

import { DeleteChannelView, type DeleteChannelViewSnapshot } from "./DeleteChannelView";
import { MockViewModel } from "../../core/viewmodel";

function renderConfirmation(snapshot: Partial<DeleteChannelViewSnapshot> = {}) {
    const vm = Object.assign(
        new MockViewModel<DeleteChannelViewSnapshot>({ name: "general", busy: false, left: false, ...snapshot }),
        {
            confirm: vi.fn(),
            cancel: vi.fn(),
        },
    );
    render(<DeleteChannelView vm={vm} />);
    return vm;
}

describe("DeleteChannelView", () => {
    it("should identify the channel and explain removal and retained history", () => {
        renderConfirmation();
        expect(screen.getByText(/remove everyone from general/)).toBeVisible();
        expect(screen.getByText(/Previously received messages/)).toBeVisible();
        expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    });

    it("should send confirmation and cancellation to the model", async () => {
        const vm = renderConfirmation();
        await userEvent.click(screen.getByRole("button", { name: "Delete channel" }));
        expect(vm.confirm).toHaveBeenCalledOnce();
        await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(vm.cancel).toHaveBeenCalledOnce();
    });

    it("should announce progress and disable both buttons during deletion", () => {
        renderConfirmation({ busy: true, progress: "Removing members…" });
        expect(screen.getByRole("status")).toHaveTextContent("Removing members…");
        expect(screen.getByRole("button", { name: "Delete channel" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    });

    it("should offer retry with an accessible explanation of a partial failure", async () => {
        const vm = renderConfirmation({ error: "Deletion stopped. You have not left the channel." });
        expect(screen.getByRole("alert")).toHaveTextContent("Deletion stopped. You have not left the channel.");
        await userEvent.click(screen.getByRole("button", { name: "Retry" }));
        expect(vm.confirm).toHaveBeenCalledOnce();
    });

    it("should explain that only forgetting remains after leaving", () => {
        renderConfirmation({ left: true, error: "Could not remove history." });
        expect(screen.getByText(/You have already left/)).toBeVisible();
        expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
    });
});
