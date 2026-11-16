/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@test-utils";
import userEvent from "@testing-library/user-event";

import { UnreadConversationsView, type UnreadConversationsViewSnapshot } from "./UnreadConversationsView";
import { MockViewModel } from "../../core/viewmodel";
import { RovingTabIndexProvider, useRovingTabIndex } from "../../core/roving";

/** A rail button before the conversations, as Home is. */
function HomeButton(): React.JSX.Element {
    const [onFocus, isActive, ref] = useRovingTabIndex<HTMLButtonElement>();
    return (
        <li role="treeitem" aria-selected={true}>
            <button ref={ref} type="button" tabIndex={isActive ? 0 : -1} onFocus={onFocus}>
                Home
            </button>
        </li>
    );
}

function makeVm(snapshot: Partial<UnreadConversationsViewSnapshot> = {}) {
    return Object.assign(
        new MockViewModel<UnreadConversationsViewSnapshot>({
            conversations: [
                { id: "!alice", name: "Alice", count: 2 },
                { id: "!group", name: "Weekend plans", count: 120 },
            ],
            ...snapshot,
        }),
        { openConversation: vi.fn(), markAsRead: vi.fn(), mute: vi.fn() },
    );
}

function renderInRail(vm: ReturnType<typeof makeVm>) {
    return render(
        <ul role="tree" aria-label="Servers">
            <UnreadConversationsView vm={vm} />
        </ul>,
    );
}

describe("UnreadConversationsView", () => {
    it("shows each unread conversation in order with its count", () => {
        renderInRail(makeVm());
        const items = screen.getAllByRole("button");
        expect(items.map((item) => item.getAttribute("aria-label"))).toEqual([
            "Alice, 2 unread messages",
            "Weekend plans, 120 unread messages",
        ]);
        expect(screen.getByRole("group", { name: "Unread conversations" })).toBeVisible();
        expect(screen.getByText("2")).toBeVisible();
        expect(screen.getByText("99+")).toBeVisible();
    });

    it("shows nothing while everything is read", () => {
        renderInRail(makeVm({ conversations: [] }));
        expect(screen.queryByRole("group")).not.toBeInTheDocument();
    });

    it("opens a conversation when clicked", async () => {
        const vm = makeVm();
        renderInRail(vm);
        await userEvent.click(screen.getByRole("button", { name: "Alice, 2 unread messages" }));
        expect(vm.openConversation).toHaveBeenCalledWith("!alice");
    });

    it("marks a conversation as read from its menu", async () => {
        const vm = makeVm();
        renderInRail(vm);
        fireEvent.contextMenu(screen.getByRole("button", { name: "Alice, 2 unread messages" }));
        await userEvent.click(await screen.findByRole("menuitem", { name: "Mark as read" }));
        expect(vm.markAsRead).toHaveBeenCalledWith("!alice");
    });

    it("offers to mute a conversation from its menu", async () => {
        const vm = makeVm();
        renderInRail(vm);
        fireEvent.contextMenu(screen.getByRole("button", { name: "Alice, 2 unread messages" }));
        await userEvent.click(await screen.findByRole("menuitem", { name: "Mute conversation" }));
        await userEvent.click(await screen.findByRole("menuitem", { name: "For 1 hour" }));
        expect(vm.mute).toHaveBeenCalledWith("!alice", 60 * 60_000);
    });

    it("joins the rail's arrow-key navigation instead of adding Tab stops", async () => {
        render(
            <RovingTabIndexProvider handleUpDown>
                {({ onKeyDownHandler }) => (
                    <ul role="tree" aria-label="Servers" onKeyDown={onKeyDownHandler}>
                        <HomeButton />
                        <UnreadConversationsView vm={makeVm()} />
                    </ul>
                )}
            </RovingTabIndexProvider>,
        );
        const home = screen.getByRole("button", { name: "Home" });
        const alice = screen.getByRole("button", { name: "Alice, 2 unread messages" });
        expect(alice).toHaveAttribute("tabindex", "-1");
        home.focus();
        await userEvent.keyboard("{ArrowDown}");
        expect(alice).toHaveFocus();
        await userEvent.keyboard("{ArrowDown}");
        expect(screen.getByRole("button", { name: "Weekend plans, 120 unread messages" })).toHaveFocus();
        expect(screen.getAllByRole("button").filter((button) => button.tabIndex === 0)).toHaveLength(1);
    });
});
