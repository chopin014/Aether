/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { type Meta, type StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import { DeleteChannelView, type DeleteChannelViewActions, type DeleteChannelViewSnapshot } from "./DeleteChannelView";
import { useMockedViewModel } from "../../core/viewmodel";

// The metadata below has a named default re-export, which this rule does not recognize.
/* oxlint-disable storybook/default-exports */
function Confirmation(snapshot: DeleteChannelViewSnapshot): JSX.Element {
    const vm = useMockedViewModel<DeleteChannelViewSnapshot, DeleteChannelViewActions>(snapshot, {
        confirm: fn(),
        cancel: fn(),
    });
    return <DeleteChannelView vm={vm} />;
}

const meta = {
    title: "Desktop/DeleteChannel",
    component: Confirmation,
    args: { name: "general", busy: false, left: false },
} satisfies Meta<typeof Confirmation>;
export { meta as default };
type Story = StoryObj<typeof meta>;

export const Confirm: Story = {};
export const RemovingMembers: Story = { args: { busy: true, progress: "Removing members and invitations…" } };
export const Interrupted: Story = {
    args: { error: "Deletion stopped. Some changes may already have been applied. Retry to finish." },
};
export const ForgetFailed: Story = {
    args: { left: true, error: "The channel is closed, but it could not be removed from your history." },
};
