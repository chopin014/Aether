/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { type Meta, type StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { Menu } from "@vector-im/compound-web";

import { ServerMenuView, type ServerMenuViewActions, type ServerMenuViewSnapshot } from "./ServerMenuView";
import { useMockedViewModel } from "../../core/viewmodel";

function ServerMenuStory(snapshot: ServerMenuViewSnapshot): JSX.Element {
    const vm = useMockedViewModel<ServerMenuViewSnapshot, ServerMenuViewActions>(snapshot, {
        markAsRead: fn(),
        invite: fn(),
        mute: fn(),
        unmute: fn(),
        setNotificationLevel: fn(),
        toggleHideMutedChannels: fn(),
        openSettings: fn(),
        changeNickname: fn(),
        createChannel: fn(),
        createCategory: fn(),
        leave: fn(),
        openDevtools: fn(),
    });
    return (
        <Menu
            open={true}
            onOpenChange={() => {}}
            title="Terra do boi gordo"
            trigger={<button type="button">Open</button>}
        >
            <ServerMenuView vm={vm} />
        </Menu>
    );
}

const meta = {
    title: "Desktop/ServerMenu",
    component: ServerMenuStory,
    args: {
        canMarkAsRead: true,
        canInvite: true,
        isMuted: false,
        notificationLevel: "mentions",
        hideMutedChannels: false,
        canOpenSettings: true,
        canCreateChannel: true,
        canCreateCategory: true,
        showDevtools: false,
    },
} satisfies Meta<typeof ServerMenuStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Member: Story = {
    args: { canMarkAsRead: false, canOpenSettings: false, canCreateChannel: false, canCreateCategory: false },
};
