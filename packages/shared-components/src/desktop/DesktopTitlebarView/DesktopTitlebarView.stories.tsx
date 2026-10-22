/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { type Meta, type StoryObj } from "@storybook/react-vite";

import { DesktopTitlebarView } from "./DesktopTitlebarView";
import { MockViewModel } from "../../core/viewmodel";

const meta = {
    title: "Desktop/DesktopTitlebarView",
    component: DesktopTitlebarView,
} satisfies Meta<typeof DesktopTitlebarView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Space: Story = {
    render: () => <DesktopTitlebarView vm={new MockViewModel({ title: "Studio", displaySpaceMenu: true })} />,
};
export const Home: Story = {
    render: () => <DesktopTitlebarView vm={new MockViewModel({ title: "Home", displaySpaceMenu: false })} />,
};
