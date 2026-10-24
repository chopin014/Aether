/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { render, screen } from "@test-utils";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";

import { PinnedMessagesView, type PinnedMessagesViewSnapshot } from "./PinnedMessagesView";
import { MockViewModel } from "../../core/viewmodel/MockViewModel";

class TestViewModel extends MockViewModel<PinnedMessagesViewSnapshot> {
    public retry = vi.fn();
    public jump = vi.fn();
    public unpin = vi.fn();
    public close = vi.fn();
}

const item = {
    id: "$one",
    author: "Alice",
    timestamp: "23 Oct 2026",
    datetime: "2026-10-23T12:00:00Z",
    unavailable: false,
    canUnpin: true,
    unpinning: false,
};
function renderView(snapshot: PinnedMessagesViewSnapshot): TestViewModel {
    const vm = new TestViewModel(snapshot);
    render(
        <PinnedMessagesView
            vm={vm}
            renderAvatar={() => <span>Avatar</span>}
            renderMessage={() => <p>Release notes and attachments</p>}
        />,
    );
    return vm;
}

describe("PinnedMessagesView", () => {
    it("renders compact author, timestamp and content cards with working actions", async () => {
        const vm = renderView({ items: [item], loading: false, error: null });
        expect(screen.getByText("Alice")).toBeVisible();
        expect(screen.getByText("23 Oct 2026").getAttribute("datetime")).toBe(item.datetime);
        expect(screen.getByText("Release notes and attachments")).toBeVisible();
        await userEvent.click(screen.getByRole("button", { name: "Jump to message" }));
        expect(vm.jump).toHaveBeenCalledWith("$one");
        await userEvent.click(screen.getByRole("button", { name: "Unpin" }));
        expect(vm.unpin).toHaveBeenCalledWith("$one");
        await userEvent.click(screen.getByRole("button", { name: "Close" }));
        expect(vm.close).toHaveBeenCalledOnce();
    });
    it("hides unpin without permission and disables it during a request", () => {
        renderView({
            items: [
                { ...item, canUnpin: false },
                { ...item, id: "$two", unpinning: true },
            ],
            loading: false,
            error: null,
        });
        expect(screen.getAllByRole("button", { name: "Unpin" })).toHaveLength(1);
        expect(screen.getByRole("button", { name: "Unpin" })).toBeDisabled();
    });
    it("offers a retry for unavailable messages without pretending they are empty", async () => {
        const vm = renderView({ items: [{ ...item, unavailable: true }], loading: false, error: "load" });
        expect(screen.getByRole("alert").textContent).toContain("Some pinned messages could not be loaded");
        expect(screen.getByText(/This message is unavailable/)).toBeVisible();
        expect(screen.queryByRole("button", { name: "Jump to message" })).toBeNull();
        await userEvent.click(screen.getByRole("button", { name: "Retry" }));
        expect(vm.retry).toHaveBeenCalledOnce();
    });
    it("announces loading", () => {
        renderView({ items: [], loading: true, error: null });
        expect(screen.getByRole("status").textContent).toContain("Loading pinned messages");
        expect(screen.queryByText("No pinned messages yet")).toBeNull();
    });
    it("explains an empty list", () => {
        renderView({ items: [], loading: false, error: null });
        expect(screen.getByRole("heading", { name: "No pinned messages yet" })).toBeVisible();
    });
    it("announces an unpin failure", () => {
        renderView({ items: [item], loading: false, error: "unpin" });
        expect(screen.getByRole("alert").textContent).toContain("The message could not be unpinned");
    });
});
