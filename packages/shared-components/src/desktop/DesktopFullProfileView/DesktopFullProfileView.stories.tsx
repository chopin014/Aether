/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { type Meta, type StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import {
    DesktopFullProfileView,
    type DesktopFullProfileViewActions,
    type DesktopFullProfileViewSnapshot,
} from "./DesktopFullProfileView";
import { useMockedViewModel } from "../../core/viewmodel";

function FullStory(snapshot: DesktopFullProfileViewSnapshot): JSX.Element {
    const vm = useMockedViewModel<DesktopFullProfileViewSnapshot, DesktopFullProfileViewActions>(snapshot, {
        message: fn(),
        verify: fn(),
        mention: fn(),
        copyLink: fn(),
        toggleIgnore: fn(),
        moderate: fn(),
        openRoom: fn(),
        retryMutualRooms: fn(),
        close: fn(),
    });
    return <DesktopFullProfileView vm={vm} />;
}

const meta = {
    title: "Desktop/Profile/Full",
    component: FullStory,
    parameters: { layout: "fullscreen" },
    args: {
        userId: "@robin:example.org",
        displayName: "Robin",
        presence: "online",
        roles: [{ key: "admin", label: "Admin" }],
        isMe: false,
        canMessage: true,
        canVerify: true,
        isVerified: false,
        canMention: true,
        isIgnored: false,
        canModerate: false,
        memberSince: { text: "May 3, 2026", datetime: "2026-05-03T10:00:00.000Z" },
        verification: { verified: false, deviceCount: 2 },
        mutualRooms: {
            state: "ready",
            items: [
                { id: "!a:example.org", name: "general" },
                { id: "!b:example.org", name: "design" },
            ],
        },
        mutualSpaces: [{ id: "!s:example.org", name: "Aether HQ" }],
    },
} satisfies Meta<typeof FullStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const MutualRoomsUnsupported: Story = { args: { mutualRooms: { state: "unsupported", items: [] } } };
export const MutualRoomsLoading: Story = { args: { mutualRooms: { state: "loading", items: [] } } };
export const MutualRoomsFailed: Story = { args: { mutualRooms: { state: "error", items: [] } } };
export const Self: Story = { args: { isMe: true, canMessage: false, canVerify: false } };
