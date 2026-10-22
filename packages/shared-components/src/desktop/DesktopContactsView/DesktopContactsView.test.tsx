/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@test-utils";
import userEvent from "@testing-library/user-event";

import {
    DesktopContactsView,
    DesktopHomeNavigationView,
    type DesktopContactsViewSnapshot,
    type DesktopContactsViewActions,
} from "./DesktopContactsView";
import { MockViewModel } from "../../core/viewmodel";

function makeVm(snapshot: Partial<DesktopContactsViewSnapshot> = {}) {
    return Object.assign(
        new MockViewModel<DesktopContactsViewSnapshot>({
            tab: "all",
            query: "",
            contacts: [{ userId: "@bob:example.org", name: "Bob", roomId: "!dm:example.org", presence: "online" }],
            onlineContacts: [],
            pendingCount: 0,
            busyIds: [],
            ...snapshot,
        }),
        {
            setTab: vi.fn(),
            setQuery: vi.fn(),
            openHome: vi.fn(),
            startChat: vi.fn(),
            openConversation: vi.fn(),
            viewProfile: vi.fn(),
            acceptInvitation: vi.fn(),
            declineInvitation: vi.fn(),
            unblock: vi.fn(),
        } satisfies DesktopContactsViewActions,
    );
}

describe("DesktopContactsView", () => {
    it("uses the real user ID for message and profile actions", async () => {
        const vm = makeVm();
        render(<DesktopContactsView vm={vm} />);
        await userEvent.click(screen.getByRole("button", { name: "Message" }));
        expect(vm.openConversation).toHaveBeenCalledWith("@bob:example.org");
        await userEvent.click(screen.getByRole("button", { name: "Profile Bob" }));
        expect(vm.viewProfile).toHaveBeenCalledWith("@bob:example.org");
    });
    it("changes tabs, searches and opens contact creation", async () => {
        const vm = makeVm();
        render(<DesktopContactsView vm={vm} />);
        const navigation = screen.getByRole("navigation", { name: "Friends" });
        await userEvent.click(within(navigation).getByRole("button", { name: "Pending" }));
        expect(vm.setTab).toHaveBeenCalledWith("pending");
        await userEvent.type(screen.getByRole("searchbox", { name: "Search" }), "b");
        expect(vm.setQuery).toHaveBeenCalledWith("b");
        await userEvent.click(screen.getByRole("button", { name: "Add Friend" }));
        expect(vm.startChat).toHaveBeenCalledOnce();
    });
    it("accepts or ignores actual room invitations and does not offer messaging for them", async () => {
        const vm = makeVm({
            tab: "pending",
            pendingCount: 1,
            contacts: [
                {
                    userId: "@bob:example.org",
                    name: "Bob",
                    presence: "offline",
                    invited: true,
                    roomId: "!invite:example.org",
                },
            ],
        });
        render(<DesktopContactsView vm={vm} />);
        expect(screen.queryByRole("button", { name: "Message" })).not.toBeInTheDocument();
        await userEvent.click(screen.getByRole("button", { name: "Accept" }));
        expect(vm.acceptInvitation).toHaveBeenCalledWith("!invite:example.org");
        await userEvent.click(screen.getByRole("button", { name: "Ignore" }));
        expect(vm.declineInvitation).toHaveBeenCalledWith("!invite:example.org");
    });
    it("disables pending actions until the server operation completes and displays errors", () => {
        render(
            <DesktopContactsView
                vm={makeVm({
                    error: "Connection failed",
                    busyIds: ["!invite:example.org"],
                    contacts: [
                        {
                            userId: "@bob:example.org",
                            name: "Bob",
                            presence: "offline",
                            invited: true,
                            roomId: "!invite:example.org",
                        },
                    ],
                })}
            />,
        );
        expect(screen.getByRole("button", { name: "Accept" })).toBeDisabled();
        expect(screen.getByRole("alert")).toHaveTextContent("Connection failed");
    });
    it("unblocks actual ignored users", async () => {
        const vm = makeVm({
            tab: "blocked",
            contacts: [{ userId: "@bob:example.org", name: "Bob", presence: "offline", blocked: true }],
        });
        render(<DesktopContactsView vm={vm} />);
        await userEvent.click(screen.getByRole("button", { name: "Unblock" }));
        expect(vm.unblock).toHaveBeenCalledWith("@bob:example.org");
    });
    it("shows an empty state without inventing contact activity", () => {
        render(<DesktopContactsView vm={makeVm({ contacts: [] })} />);
        expect(screen.getByText("No one is here yet.")).toBeVisible();
        expect(screen.getByText("It’s quiet for now…")).toBeInTheDocument();
    });
    it("keeps Home and new direct messages accessible from the sidebar", async () => {
        const vm = makeVm({ pendingCount: 2 });
        render(<DesktopHomeNavigationView vm={vm} />);
        await userEvent.click(screen.getByRole("button", { name: "Friends 2" }));
        expect(vm.openHome).toHaveBeenCalledOnce();
        await userEvent.click(screen.getByRole("button", { name: "New message" }));
        expect(vm.startChat).toHaveBeenCalledOnce();
    });
});
