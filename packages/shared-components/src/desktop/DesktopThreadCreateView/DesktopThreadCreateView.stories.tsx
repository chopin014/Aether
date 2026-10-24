/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { type Meta, type StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import {
    DesktopThreadCreateView,
    type DesktopThreadCreateSnapshot,
    type DesktopThreadCreateActions,
} from "./DesktopThreadCreateView";
import { useMockedViewModel } from "../../core/viewmodel";

function CreateStory(snapshot: DesktopThreadCreateSnapshot): JSX.Element {
    const vm = useMockedViewModel<DesktopThreadCreateSnapshot, DesktopThreadCreateActions>(snapshot, {
        setStarter: fn(),
        setReply: fn(),
        submit: fn(),
        cancel: fn(),
    });
    return (
        <div style={{ maxHeight: 600 }}>
            <DesktopThreadCreateView vm={vm} />
        </div>
    );
}
const meta = {
    title: "Desktop/Threads/Create",
    component: CreateStory,
    args: { starter: "", reply: "", sending: false, locked: false, starterSent: false, error: false },
} satisfies Meta<typeof CreateStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Empty: Story = {};
export const Draft: Story = { args: { starter: "Release planning", reply: "Let's ship on Friday." } };
export const Sending: Story = { args: { ...Draft.args, sending: true, locked: true } };
export const PartialFailure: Story = { args: { ...Draft.args, error: true, starterSent: true, locked: true } };
