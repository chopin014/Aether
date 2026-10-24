/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { fn } from "storybook/test";
import { type Meta, type StoryObj } from "@storybook/react-vite";

import { PinnedMessagesView, type PinnedMessagesViewSnapshot } from "./PinnedMessagesView";
import { useMockedViewModel } from "../../core/viewmodel";

const meta = {
    title: "Room/PinnedMessagesView",
    parameters: { layout: "centered" },
    args: { items: [], loading: false, error: null },
    render: function PinnedMessagesStory(snapshot: PinnedMessagesViewSnapshot) {
        const vm = useMockedViewModel(snapshot, { retry: fn(), jump: fn(), unpin: fn(), close: fn() });
        return (
            <div style={{ width: "min(480px, 90vw)" }}>
                <PinnedMessagesView
                    vm={vm}
                    renderAvatar={() => <span aria-hidden>AL</span>}
                    renderMessage={() => <p>The release notes are ready for review.</p>}
                />
            </div>
        );
    },
} satisfies Meta<PinnedMessagesViewSnapshot>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Empty: Story = {};
export const Loading: Story = { args: { loading: true } };
export const Unavailable: Story = {
    args: {
        error: "load",
        items: [{ id: "$missing", author: "", timestamp: "", unavailable: true, canUnpin: true, unpinning: false }],
    },
};
export const Populated: Story = {
    args: {
        items: Array.from({ length: 8 }, (_, i) => ({
            id: `$pin${i}`,
            author: i % 2 ? "Alice" : "Bob",
            timestamp: "23 Oct 2026, 12:30",
            datetime: "2026-10-23T12:30:00Z",
            unavailable: false,
            canUnpin: true,
            unpinning: false,
        })),
    },
};
