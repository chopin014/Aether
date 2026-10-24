/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { type Meta, type StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import { TopicDialogView, type TopicDialogViewActions, type TopicDialogViewSnapshot } from "./TopicDialogView";
import { useMockedViewModel } from "../../core/viewmodel";

function TopicStory(snapshot: TopicDialogViewSnapshot): JSX.Element {
    const vm = useMockedViewModel<TopicDialogViewSnapshot, TopicDialogViewActions>(snapshot, {
        onEdit: fn(),
        onClose: fn(),
    });
    return <TopicDialogView vm={vm} />;
}

const meta = {
    title: "Desktop/TopicDialog",
    component: TopicStory,
    args: {
        name: "general",
        kind: "text",
        topic: "Release planning and everyday chatter. Docs live at https://example.org/docs",
        canEdit: true,
    },
} satisfies Meta<typeof TopicStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const ReadOnly: Story = { args: { canEdit: false } };
