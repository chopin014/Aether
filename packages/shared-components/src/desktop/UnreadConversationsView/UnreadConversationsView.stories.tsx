/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { type Meta, type StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import {
    UnreadConversationsView,
    type UnreadConversationsViewActions,
    type UnreadConversationsViewSnapshot,
} from "./UnreadConversationsView";
import { useMockedViewModel } from "../../core/viewmodel";

function UnreadConversationsStory(snapshot: UnreadConversationsViewSnapshot): JSX.Element {
    const vm = useMockedViewModel<UnreadConversationsViewSnapshot, UnreadConversationsViewActions>(snapshot, {
        openConversation: fn(),
        markAsRead: fn(),
        mute: fn(),
    });
    return (
        <ul role="tree" aria-label="Servers" style={{ width: 72, padding: 0, margin: 0 }}>
            <UnreadConversationsView vm={vm} />
        </ul>
    );
}

const meta = {
    title: "Desktop/UnreadConversations",
    component: UnreadConversationsStory,
    args: {
        conversations: [
            { id: "!alice:example.org", name: "Alice", count: 2 },
            { id: "!team:example.org", name: "Weekend plans", count: 128 },
            { id: "!bob:example.org", name: "Bob", count: 1 },
        ],
    },
} satisfies Meta<typeof UnreadConversationsStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Empty: Story = { args: { conversations: [] } };
