/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { type Meta, type StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import {
    DesktopProfilePopoutView,
    type DesktopProfilePopoutViewActions,
    type DesktopProfilePopoutViewSnapshot,
} from "./DesktopProfilePopoutView";
import { useMockedViewModel } from "../../core/viewmodel";

function PopoutStory(snapshot: DesktopProfilePopoutViewSnapshot): JSX.Element {
    const vm = useMockedViewModel<DesktopProfilePopoutViewSnapshot, DesktopProfilePopoutViewActions>(snapshot, {
        message: fn(),
        verify: fn(),
        mention: fn(),
        copyLink: fn(),
        toggleIgnore: fn(),
        moderate: fn(),
        openFullProfile: fn(),
        close: fn(),
    });
    return <DesktopProfilePopoutView vm={vm} />;
}

const meta = {
    title: "Desktop/Profile/Popout",
    component: PopoutStory,
    args: {
        userId: "@robin:example.org",
        displayName: "Robin",
        presence: "online",
        roles: [{ key: "moderator", label: "Moderator" }],
        isMe: false,
        canMessage: true,
        canVerify: true,
        isVerified: false,
        canMention: true,
        isIgnored: false,
        canModerate: true,
        busy: false,
        error: false,
    },
} satisfies Meta<typeof PopoutStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const WithStatus: Story = { args: { status: { emoji: "🎧", text: "Listening to lo-fi" } } };
export const UnknownPresence: Story = { args: { presence: undefined, roles: [] } };
export const OpenFailed: Story = { args: { error: true } };
export const Self: Story = { args: { isMe: true, canMessage: false, canVerify: false, canModerate: false } };
