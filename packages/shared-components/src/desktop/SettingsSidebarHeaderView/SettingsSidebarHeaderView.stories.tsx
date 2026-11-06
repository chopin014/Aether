/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { type Meta, type StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import {
    SettingsSidebarHeaderView,
    type SettingsSidebarHeaderViewActions,
    type SettingsSidebarHeaderViewSnapshot,
} from "./SettingsSidebarHeaderView";
import { useMockedViewModel } from "../../core/viewmodel";

function SidebarHeaderStory(snapshot: SettingsSidebarHeaderViewSnapshot): JSX.Element {
    const vm = useMockedViewModel<SettingsSidebarHeaderViewSnapshot, SettingsSidebarHeaderViewActions>(snapshot, {
        editProfile: fn(),
        setQuery: fn(),
        openFirstMatch: fn(),
    });
    return (
        <div style={{ width: 220 }}>
            <SettingsSidebarHeaderView vm={vm} />
        </div>
    );
}

const meta = {
    title: "Desktop/Settings/Sidebar header",
    component: SidebarHeaderStory,
    args: { userId: "@chopin:matrix.org", displayName: "chopin", query: "" },
} satisfies Meta<typeof SidebarHeaderStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Searching: Story = { args: { query: "senha" } };
