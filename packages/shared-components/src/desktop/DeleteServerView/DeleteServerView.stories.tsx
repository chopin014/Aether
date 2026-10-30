/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { type Meta, type StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import { DeleteServerView, type DeleteServerViewSnapshot, type DeleteServerViewActions } from "./DeleteServerView";
import { useMockedViewModel } from "../../core/viewmodel";

// The metadata below has a named default re-export, which this rule does not recognize.
/* oxlint-disable storybook/default-exports */
function Confirmation(snapshot: DeleteServerViewSnapshot): JSX.Element {
    const vm = useMockedViewModel<DeleteServerViewSnapshot, DeleteServerViewActions>(snapshot, {
        confirm: fn(),
        cancel: fn(),
        setConfirmation: fn(),
    });
    return <DeleteServerView vm={vm} />;
}

const meta = {
    title: "Desktop/DeleteServer",
    component: Confirmation,
    args: {
        name: "Community",
        busy: false,
        ready: true,
        confirmation: "",
        rooms: [
            { id: "text", name: "general", kind: "text" },
            { id: "voice", name: "Lounge", kind: "voice" },
            { id: "space", name: "Projects", kind: "space" },
        ],
    },
} satisfies Meta<typeof Confirmation>;
export { meta as default };
type Story = StoryObj<typeof meta>;
export const Confirm: Story = {};
export const Checking: Story = { args: { busy: true, ready: false, progress: "Checking every channel and server…" } };
export const Interrupted: Story = {
    args: { error: "Deletion stopped at Lounge. Retry to finish the remaining steps." },
};
