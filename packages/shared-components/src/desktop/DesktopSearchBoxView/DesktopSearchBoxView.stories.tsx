/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { type Meta, type StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import {
    DesktopSearchBoxView,
    type DesktopSearchBoxActions,
    type DesktopSearchBoxSnapshot,
} from "./DesktopSearchBoxView";
import { useMockedViewModel } from "../../core/viewmodel";

function BoxStory(snapshot: DesktopSearchBoxSnapshot): JSX.Element {
    const vm = useMockedViewModel<DesktopSearchBoxSnapshot, DesktopSearchBoxActions>(snapshot, {
        setText: fn(),
        setOpen: fn(),
        removeChip: fn(),
        removeLastChip: fn(),
        activate: fn(),
        moveActive: fn(),
        submit: fn(),
        clear: fn(),
        dismiss: fn(),
        clearSection: fn(),
    });
    return (
        <div style={{ display: "flex", justifyContent: "flex-end", minHeight: 460 }}>
            <DesktopSearchBoxView vm={vm} />
        </div>
    );
}

const meta = {
    title: "Desktop/Search/Box",
    component: BoxStory,
    args: {
        scopeName: "Servidor de Guizika",
        text: "",
        chips: [],
        open: true,
        activeId: null,
        focusRequest: 0,
        sections: [
            {
                id: "filters",
                options: [
                    { id: "filter:from", kind: "filter", filter: "from" },
                    { id: "filter:in", kind: "filter", filter: "in" },
                    { id: "filter:has", kind: "filter", filter: "has" },
                    { id: "filter:mentions", kind: "filter", filter: "mentions" },
                    { id: "filter:more", kind: "filter", filter: "more" },
                ],
            },
        ],
    },
} satisfies Meta<typeof BoxStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Filters: Story = {};
export const Closed: Story = { args: { open: false } };
export const Autocomplete: Story = {
    args: {
        text: "from:ali",
        activeId: "from:@alice:x",
        sections: [
            {
                id: "members",
                options: [
                    {
                        id: "from:@alice:x",
                        kind: "choice",
                        filter: "from",
                        title: "Alice",
                        subtitle: "@alice:example.org",
                    },
                    {
                        id: "from:@alina:x",
                        kind: "choice",
                        filter: "from",
                        title: "Alina",
                        subtitle: "@alina:example.org",
                    },
                ],
            },
        ],
    },
};
export const HasValues: Story = {
    args: {
        text: "has:",
        sections: [
            {
                id: "has",
                options: (["has_link", "has_file", "has_image", "has_video", "has_sound"] as const).map((titleKey) => ({
                    id: titleKey,
                    kind: "choice" as const,
                    filter: "has" as const,
                    titleKey,
                })),
            },
        ],
    },
};
export const WithChipsAndRecents: Story = {
    args: {
        chips: [
            { id: "from:@alice:x", filter: "from", value: "Alice" },
            { id: "has:file", filter: "has", value: "file" },
        ],
        sections: [
            {
                id: "recent",
                clearable: true,
                options: [
                    {
                        id: "recent:0",
                        kind: "recent",
                        text: "budget",
                        chips: [{ id: "in:!g:x", filter: "in", value: "general" }],
                    },
                    { id: "recent:1", kind: "recent", text: "release notes", chips: [] },
                ],
            },
        ],
    },
};
