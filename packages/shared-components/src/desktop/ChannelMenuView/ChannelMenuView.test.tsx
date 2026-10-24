/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@test-utils";
import userEvent from "@testing-library/user-event";

import { ChannelMenuContent, ChannelMenuView, type ChannelMenuViewSnapshot } from "./ChannelMenuView";
import { MockViewModel } from "../../core/viewmodel";
import { RoomNotifState } from "../../room-list/VirtualizedRoomListView/RoomListItemWrapper/RoomListItemView/RoomNotifs";

const base: ChannelMenuViewSnapshot = {
    name: "general",
    kind: "text",
    topic: "Release planning",
    canEditTopic: true,
    isEncrypted: true,
    historyVisibility: "shared",
    hasMessages: true,
    canMarkAsRead: true,
    isFavourite: false,
    canInvite: true,
    canCopyLink: true,
    canChangeNotifications: true,
    roomNotifState: RoomNotifState.AllMessages,
    canEditChannel: true,
    canCreateChannel: true,
};

function makeVm(snapshot: Partial<ChannelMenuViewSnapshot> = {}) {
    return Object.assign(new MockViewModel<ChannelMenuViewSnapshot>({ ...base, ...snapshot }), {
        onMarkAsRead: vi.fn(),
        onToggleFavourite: vi.fn(),
        onInvite: vi.fn(),
        onCopyLink: vi.fn(),
        onSetNotifState: vi.fn(),
        onEditChannel: vi.fn(),
        onEditTopic: vi.fn(),
        onOpenSecuritySettings: vi.fn(),
        onCreateChannel: vi.fn(),
        onLeave: vi.fn(),
        onFiles: vi.fn(),
        onPolls: vi.fn(),
        onExtensions: vi.fn(),
        onExport: vi.fn(),
        onReport: vi.fn(),
    });
}

const names = (): string[] =>
    [...document.querySelectorAll('[role^="menuitem"]')].map((item) => item.textContent ?? "");

describe("ChannelMenuView", () => {
    it("opens beneath the trigger and lists the entries in Discord's order", async () => {
        const vm = makeVm();
        render(
            <ChannelMenuView vm={vm} open onOpenChange={() => {}} trigger={<button type="button">general</button>} />,
        );
        const labels = names();
        const order = [
            "Edit topic",
            "End-to-end encrypted",
            "Mark as read",
            "Favourite",
            "Invite to channel",
            "Copy link",
            "Mute channel",
            "Notification settings",
            "Edit channel",
            "Create text channel",
            "Files",
            "Polls",
            "Extensions",
            "Export chat",
            "Report channel",
            "Leave channel",
        ];
        const positions = order.map((label) => labels.findIndex((text) => text.startsWith(label)));
        expect(positions.filter((index) => index < 0)).toEqual([]);
        expect(positions).toEqual([...positions].sort((a, b) => a - b));
        expect(screen.getByText("Release planning")).toBeVisible();
        expect(screen.queryByRole("menuitem", { name: /People|Threads|Pinned/ })).not.toBeInTheDocument();
    });

    it("closes when asked to", async () => {
        const onOpenChange = vi.fn();
        render(
            <ChannelMenuView
                vm={makeVm()}
                open
                onOpenChange={onOpenChange}
                trigger={<button type="button">general</button>}
            />,
        );
        await userEvent.keyboard("{Escape}");
        expect(onOpenChange).toHaveBeenCalledWith(false);
    });
});

describe("ChannelMenuContent", () => {
    function renderContent(snapshot: Partial<ChannelMenuViewSnapshot> = {}, showInfo = false) {
        const vm = makeVm(snapshot);
        render(
            <div role="menu">
                <ChannelMenuContent vm={vm} showInfo={showInfo} />
            </div>,
        );
        return vm;
    }

    it("omits the info lines in the context menu", () => {
        renderContent();
        expect(screen.queryByText("Release planning")).not.toBeInTheDocument();
        expect(screen.queryByRole("menuitem", { name: "End-to-end encrypted" })).not.toBeInTheDocument();
    });

    it("hides what the user may not do", () => {
        renderContent({
            canInvite: false,
            canCopyLink: false,
            canEditChannel: false,
            canCreateChannel: false,
            canChangeNotifications: false,
        });
        for (const name of [
            "Invite to channel",
            "Copy link",
            "Edit channel",
            "Create text channel",
            "Mute channel",
            "Notification settings",
        ]) {
            expect(screen.queryByRole("menuitem", { name: new RegExp(name) })).not.toBeInTheDocument();
        }
        expect(screen.getByRole("menuitem", { name: "Leave channel" })).toBeVisible();
    });

    it("leaves out the Matrix extras of a voice channel but keeps Report", () => {
        renderContent({ kind: "voice", hasMessages: false });
        for (const name of ["Files", "Polls", "Extensions", "Export chat"]) {
            expect(screen.queryByRole("menuitem", { name })).not.toBeInTheDocument();
        }
        expect(screen.getByRole("menuitem", { name: "Report channel" })).toBeVisible();
    });

    it("disables Mark as read when nothing is unread", () => {
        renderContent({ canMarkAsRead: false });
        expect(screen.getByRole("menuitem", { name: "Mark as read" })).toBeDisabled();
    });

    it("reflects the favourite state and toggles it", async () => {
        const vm = renderContent({ isFavourite: true });
        const toggle = screen.getByRole("menuitemcheckbox", { name: "Favourite" });
        expect(toggle).toBeChecked();
        await userEvent.click(toggle);
        expect(vm.onToggleFavourite).toHaveBeenCalled();
    });

    it("mutes, and unmutes a muted channel", async () => {
        const vm = renderContent();
        await userEvent.click(screen.getByRole("menuitem", { name: "Mute channel" }));
        expect(vm.onSetNotifState).toHaveBeenCalledWith(RoomNotifState.Mute);
    });

    it("offers Unmute for a muted channel", async () => {
        const vm = renderContent({ roomNotifState: RoomNotifState.Mute });
        await userEvent.click(screen.getByRole("menuitem", { name: "Unmute channel" }));
        expect(vm.onSetNotifState).toHaveBeenCalledWith(RoomNotifState.AllMessages);
    });

    it("sends each entry to its action", async () => {
        const vm = renderContent({}, true);
        const cases: [string, keyof ReturnType<typeof makeVm> & string][] = [
            ["Edit topic", "onEditTopic"],
            ["End-to-end encrypted", "onOpenSecuritySettings"],
            ["Mark as read", "onMarkAsRead"],
            ["Invite to channel", "onInvite"],
            ["Copy link", "onCopyLink"],
            ["Edit channel", "onEditChannel"],
            ["Create text channel", "onCreateChannel"],
            ["Files", "onFiles"],
            ["Polls", "onPolls"],
            ["Extensions", "onExtensions"],
            ["Export chat", "onExport"],
            ["Report channel", "onReport"],
            ["Leave channel", "onLeave"],
        ];
        for (const [label, action] of cases) {
            await userEvent.click(screen.getByRole("menuitem", { name: label }));
            expect(vm[action as "onLeave"]).toHaveBeenCalledTimes(1);
        }
    });

    it("describes history visibility and encryption", () => {
        renderContent({ isEncrypted: false, historyVisibility: "world_readable" }, true);
        expect(screen.getByRole("menuitem", { name: "Not encrypted" })).toBeVisible();
        expect(screen.getByRole("menuitem", { name: "Anyone can read the history" })).toBeVisible();
    });
});
