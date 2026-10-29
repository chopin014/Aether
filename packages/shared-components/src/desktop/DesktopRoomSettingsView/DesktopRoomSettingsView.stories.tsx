/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { useMockedViewModel } from "../../core/viewmodel";
import { withViewDocs } from "../../../.storybook/withViewDocs";
import {
    DesktopRoomSettingsView,
    type DesktopRoomSettingsViewActions,
    type DesktopRoomSettingsViewSnapshot,
} from "./DesktopRoomSettingsView";

type DesktopRoomSettingsStoryProps = DesktopRoomSettingsViewSnapshot & DesktopRoomSettingsViewActions;

function DesktopRoomSettingsStoryView({ selectTab, ...snapshot }: DesktopRoomSettingsStoryProps): React.JSX.Element {
    const vm = useMockedViewModel(snapshot, { selectTab });
    return <DesktopRoomSettingsView vm={vm} />;
}

const DesktopRoomSettingsStory = withViewDocs(DesktopRoomSettingsStoryView, DesktopRoomSettingsView);

const meta = {
    title: "Desktop/Room Settings View",
    component: DesktopRoomSettingsStory,
    tags: ["autodocs"],
    args: {
        navigationLabel: "Channel settings for #build-room",
        groups: [
            {
                label: "CHANNEL SETTINGS",
                tabs: [
                    { id: "GENERAL", label: "Overview", icon: <span aria-hidden="true">#</span> },
                    { id: "SECURITY", label: "Security & Privacy", icon: null },
                ],
            },
            {
                label: "ACCESS",
                tabs: [{ id: "ROLES", label: "Permissions", icon: null }],
            },
        ],
        activeTabId: "GENERAL",
        activeTabContent: <div className="mx_SettingsTab">Room name, topic, and avatar settings</div>,
        selectTab: fn(),
    },
} satisfies Meta<typeof DesktopRoomSettingsStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
