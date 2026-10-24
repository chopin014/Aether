/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { type Meta, type StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import { ChannelMenuView, type ChannelMenuViewActions, type ChannelMenuViewSnapshot } from "./ChannelMenuView";
import { useMockedViewModel } from "../../core/viewmodel";
import { RoomNotifState } from "../../room-list/VirtualizedRoomListView/RoomListItemWrapper/RoomListItemView/RoomNotifs";

const actions: ChannelMenuViewActions = {
    onMarkAsRead: fn(),
    onToggleFavourite: fn(),
    onInvite: fn(),
    onCopyLink: fn(),
    onSetNotifState: fn(),
    onEditChannel: fn(),
    onEditTopic: fn(),
    onOpenSecuritySettings: fn(),
    onCreateChannel: fn(),
    onLeave: fn(),
    onFiles: fn(),
    onPolls: fn(),
    onExtensions: fn(),
    onExport: fn(),
    onReport: fn(),
};

function MenuStory(snapshot: ChannelMenuViewSnapshot): JSX.Element {
    const vm = useMockedViewModel<ChannelMenuViewSnapshot, ChannelMenuViewActions>(snapshot, actions);
    return (
        <div style={{ minHeight: 640 }}>
            <ChannelMenuView vm={vm} open onOpenChange={fn()} trigger={<button type="button"># general</button>} />
        </div>
    );
}

const meta = {
    title: "Desktop/ChannelMenu",
    component: MenuStory,
    args: {
        name: "general",
        kind: "text",
        topic: "Release planning and everyday chatter",
        canEditTopic: true,
        isEncrypted: true,
        historyVisibility: "shared",
        hasMessages: true,
        canMarkAsRead: true,
        isFavourite: false,
        canInvite: true,
        canCopyLink: true,
        canChangeNotifications: true,
        roomNotifState: RoomNotifState.MentionsOnly,
        canEditChannel: true,
        canCreateChannel: true,
    },
} satisfies Meta<typeof MenuStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Favourite: Story = { args: { isFavourite: true } };
export const Member: Story = {
    args: { canEditTopic: false, canEditChannel: false, canCreateChannel: false, canInvite: false },
};
export const Voice: Story = { args: { kind: "voice", hasMessages: false } };
