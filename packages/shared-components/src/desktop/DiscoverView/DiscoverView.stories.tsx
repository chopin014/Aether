/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { type Meta, type StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import { DiscoverView, type DiscoverViewActions, type DiscoverViewSnapshot } from "./DiscoverView";
import { DiscoverNavigationView } from "./DiscoverNavigationView";
import { useMockedViewModel } from "../../core/viewmodel";

function DiscoverStory(snapshot: DiscoverViewSnapshot): JSX.Element {
    const vm = useMockedViewModel<DiscoverViewSnapshot, DiscoverViewActions>(snapshot, {
        setSection: fn(),
        setCategory: fn(),
        setQuery: fn(),
        setServer: fn(),
        addServer: fn(),
        loadMore: fn(),
        retry: fn(),
        open: fn(),
    });
    return (
        <div style={{ display: "flex", height: 760 }}>
            <div style={{ width: 280, flex: "none" }}>
                <DiscoverNavigationView vm={vm} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
                <DiscoverView vm={vm} />
            </div>
        </div>
    );
}

const meta = {
    title: "Desktop/Discover",
    component: DiscoverStory,
    args: {
        section: "spaces",
        category: "home",
        query: "",
        server: "example.org",
        servers: [
            { name: "example.org", isHome: true },
            { name: "other.example", isHome: false },
        ],
        entries: [
            {
                roomId: "!community:example.org",
                name: "Open Source Community",
                topic: "Everything about free software. Introduce yourself in the lobby, then explore the subspaces.",
                memberCount: 36485,
                joined: true,
            },
            {
                roomId: "!games:example.org",
                name: "Video Games",
                topic: "A space for all things video games: PC, console and mobile. Keep off-topic in the off-topic room.",
                memberCount: 3230,
                joined: false,
            },
            {
                roomId: "!music:example.org",
                name: "Rock & Metal Music",
                topic: "A community for everyone who loves rock and metal, from classic legends to underground bands.",
                memberCount: 598,
                joined: false,
            },
            {
                roomId: "!quiet:example.org",
                name: "A community with no topic",
                memberCount: 1,
                joined: false,
            },
        ],
        status: "ready",
        loadingMore: false,
        hasMore: true,
    },
} satisfies Meta<typeof DiscoverStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Spaces: Story = {};
export const Rooms: Story = { args: { section: "rooms" } };
export const Category: Story = { args: { category: "gaming", hasMore: false } };
export const Search: Story = { args: { query: "metal", hasMore: false } };
export const Loading: Story = { args: { status: "loading", entries: [], hasMore: false } };
export const Empty: Story = { args: { query: "nothing", entries: [], hasMore: false } };
export const Error: Story = { args: { status: "error", entries: [], hasMore: false } };
