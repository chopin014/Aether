/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { type Meta, type StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import {
    DesktopThreadBrowserView,
    type DesktopThreadBrowserSnapshot,
    type DesktopThreadBrowserActions,
} from "./DesktopThreadBrowserView";
import { useMockedViewModel } from "../../core/viewmodel";

function BrowserStory(snapshot: DesktopThreadBrowserSnapshot): JSX.Element {
    const vm = useMockedViewModel<DesktopThreadBrowserSnapshot, DesktopThreadBrowserActions>(snapshot, {
        setQuery: fn(),
        setFilter: fn(),
        loadMore: fn(),
        retry: fn(),
        openThread: fn(),
        createThread: fn(),
    });
    return (
        <div style={{ maxHeight: 600 }}>
            <DesktopThreadBrowserView vm={vm} />
        </div>
    );
}
const meta = {
    title: "Desktop/Threads/Browser",
    component: BrowserStory,
    args: { query: "", filter: "all", loading: false, error: false, canCreate: true, hasMore: false, rows: [] },
} satisfies Meta<typeof BrowserStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Empty: Story = {};
export const Populated: Story = {
    args: {
        rows: [
            {
                id: "$planning",
                title: "Release planning",
                preview: "Let's ship on Friday.",
                replies: 4,
                activity: "Oct 23, 17:00",
                unread: true,
            },
            {
                id: "$docs",
                title: "Documentation",
                preview: "The guide is ready for review.",
                replies: 2,
                activity: "Oct 22, 10:00",
                unread: false,
            },
        ],
        hasMore: true,
    },
};
export const LongText: Story = {
    args: {
        rows: [
            {
                id: "$long",
                title: "A very long starter that should remain readable without widening the discovery browser or hiding its controls ".repeat(
                    3,
                ),
                preview: "A long reply ".repeat(20),
                replies: 100,
                activity: "Oct 23, 17:00",
                unread: true,
            },
        ],
    },
};
export const NoResults: Story = { args: { query: "unmatched" } };
export const Loading: Story = { args: { loading: true } };
export const Failed: Story = { args: { error: true } };
