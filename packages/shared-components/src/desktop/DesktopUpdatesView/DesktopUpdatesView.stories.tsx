/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { type Meta, type StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import {
    DesktopUpdatesView,
    type DesktopUpdatesViewActions,
    type DesktopUpdatesViewSnapshot,
} from "./DesktopUpdatesView";
import { useMockedViewModel } from "../../core/viewmodel";

function UpdatesStory(snapshot: DesktopUpdatesViewSnapshot): JSX.Element {
    const vm = useMockedViewModel<DesktopUpdatesViewSnapshot, DesktopUpdatesViewActions>(snapshot, {
        checkForUpdates: fn(),
        restartToUpdate: fn(),
    });
    return <DesktopUpdatesView vm={vm} />;
}

const meta = {
    title: "Desktop/Settings/Updates",
    component: UpdatesStory,
    args: { state: { status: "idle", currentVersion: "1.4.2" }, loading: false },
} satisfies Meta<typeof UpdatesStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Current: Story = {};
export const Downloading: Story = {
    args: { state: { status: "downloading", currentVersion: "1.4.2", version: "1.5.0", percent: 58 } },
};
export const Ready: Story = { args: { state: { status: "ready", currentVersion: "1.4.2", version: "1.5.0" } } };
export const Unsupported: Story = {
    args: { state: { status: "unsupported", currentVersion: "1.4.2", reason: "package" } },
};
