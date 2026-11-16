/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@test-utils";
import userEvent from "@testing-library/user-event";
import { Menu } from "@vector-im/compound-web";

import { ServerMenuView, type ServerMenuViewSnapshot } from "./ServerMenuView";
import { MockViewModel } from "../../core/viewmodel";

function makeVm(snapshot: Partial<ServerMenuViewSnapshot> = {}) {
    return Object.assign(
        new MockViewModel<ServerMenuViewSnapshot>({
            canMarkAsRead: true,
            canInvite: true,
            isMuted: false,
            notificationLevel: "mentions",
            hideMutedChannels: false,
            canOpenSettings: true,
            canCreateChannel: true,
            canCreateCategory: true,
            showDevtools: false,
            ...snapshot,
        }),
        {
            markAsRead: vi.fn(),
            invite: vi.fn(),
            mute: vi.fn(),
            unmute: vi.fn(),
            setNotificationLevel: vi.fn(),
            toggleHideMutedChannels: vi.fn(),
            openSettings: vi.fn(),
            changeNickname: vi.fn(),
            createChannel: vi.fn(),
            createCategory: vi.fn(),
            leave: vi.fn(),
            openDevtools: vi.fn(),
        },
    );
}

function renderMenu(vm: ReturnType<typeof makeVm>) {
    return render(
        <Menu open={true} onOpenChange={() => {}} title="Terra" trigger={<button type="button">Open</button>}>
            <ServerMenuView vm={vm} />
        </Menu>,
    );
}

describe("ServerMenuView", () => {
    it("lists Discord's server entries in order", () => {
        renderMenu(makeVm());
        const items = [...document.querySelectorAll('[role^="menuitem"]')];
        expect(items.map((item) => item.textContent)).toEqual([
            "Mark as read",
            "Invite to server",
            "Mute server",
            "Notification settings",
            "Hide muted channels",
            "Server settings",
            "Change nickname",
            "Create channel",
            "Create category",
            "Leave server",
        ]);
    });

    it("leaves out what the person may not do, and greys out marking a read server as read", () => {
        renderMenu(
            makeVm({
                canMarkAsRead: false,
                canInvite: false,
                canOpenSettings: false,
                canCreateChannel: false,
                canCreateCategory: false,
            }),
        );
        expect(screen.getByRole("menuitem", { name: "Mark as read" })).toBeDisabled();
        for (const name of ["Invite to server", "Server settings", "Create channel", "Create category"]) {
            expect(screen.queryByRole("menuitem", { name })).not.toBeInTheDocument();
        }
        expect(screen.getByRole("menuitem", { name: "Leave server" })).toBeVisible();
        // Anyone may change their own nickname.
        expect(screen.getByRole("menuitem", { name: "Change nickname" })).toBeVisible();
    });

    it("acts through the view model", async () => {
        const vm = makeVm({ showDevtools: true });
        renderMenu(vm);
        await userEvent.click(screen.getByRole("menuitem", { name: "Invite to server" }));
        expect(vm.invite).toHaveBeenCalled();
        renderMenu(vm);
        await userEvent.click(screen.getByRole("menuitemcheckbox", { name: "Hide muted channels" }));
        expect(vm.toggleHideMutedChannels).toHaveBeenCalled();
        renderMenu(vm);
        await userEvent.click(screen.getByRole("menuitem", { name: "Change nickname" }));
        expect(vm.changeNickname).toHaveBeenCalled();
        renderMenu(vm);
        await userEvent.click(screen.getByRole("menuitem", { name: "Create channel" }));
        await userEvent.click(screen.getByRole("menuitem", { name: "View timeline (devtools)" }));
        await userEvent.click(screen.getByRole("menuitem", { name: "Leave server" }));
        expect(vm.createChannel).toHaveBeenCalled();
        expect(vm.openDevtools).toHaveBeenCalled();
        expect(vm.leave).toHaveBeenCalled();
    });

    it("changes the notification level from its submenu", async () => {
        const vm = makeVm();
        renderMenu(vm);
        expect(screen.getByRole("menuitem", { name: "Notification settings" })).toHaveAccessibleDescription(
            "Only @mentions",
        );
        await userEvent.click(screen.getByRole("menuitem", { name: /Notification settings/ }));
        await userEvent.click(await screen.findByRole("menuitemradio", { name: "All messages" }));
        expect(vm.setNotificationLevel).toHaveBeenCalledWith("all");
    });

    it("offers to unmute a muted server", async () => {
        const vm = makeVm({ isMuted: true });
        renderMenu(vm);
        await userEvent.click(screen.getByRole("menuitem", { name: "Unmute server" }));
        expect(vm.unmute).toHaveBeenCalled();
    });
});
