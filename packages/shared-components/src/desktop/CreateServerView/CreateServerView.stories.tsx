/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { type Meta, type StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import { CreateServerView, type CreateServerViewActions, type CreateServerViewSnapshot } from "./CreateServerView";
import { useMockedViewModel } from "../../core/viewmodel";

function Flow(snapshot: CreateServerViewSnapshot): JSX.Element {
    const vm = useMockedViewModel<CreateServerViewSnapshot, CreateServerViewActions>(snapshot, {
        startCreate: fn(),
        startJoin: fn(),
        chooseAudience: fn(),
        back: fn(),
        setName: fn(),
        setAvatar: fn(),
        create: fn(),
        setJoinAddress: fn(),
        join: fn(),
        explore: fn(),
    });
    return (
        <div style={{ maxInlineSize: 440 }}>
            <CreateServerView vm={vm} />
        </div>
    );
}

const meta = {
    title: "Desktop/CreateServer",
    component: Flow,
    args: {
        step: "start",
        canChooseAudience: true,
        canExplore: true,
        audience: "friends",
        name: "Alice's server",
        joinAddress: "",
        busy: false,
    },
} satisfies Meta<typeof Flow>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Start: Story = {};
export const Audience: Story = { args: { step: "audience" } };
export const Customise: Story = { args: { step: "customise" } };
export const Creating: Story = { args: { step: "customise", busy: true, progress: "Setting up channels…" } };
export const Join: Story = { args: { step: "join", joinAddress: "https://matrix.to/#/#aether:matrix.org" } };
