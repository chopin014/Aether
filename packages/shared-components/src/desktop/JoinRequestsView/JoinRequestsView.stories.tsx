/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { type Meta, type StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import { JoinRequestsView, type JoinRequestsViewActions, type JoinRequestsViewSnapshot } from "./JoinRequestsView";
import { useMockedViewModel } from "../../core/viewmodel";

function Requests(snapshot: JoinRequestsViewSnapshot): JSX.Element {
    const vm = useMockedViewModel<JoinRequestsViewSnapshot, JoinRequestsViewActions>(snapshot, {
        toggle: fn(),
        approve: fn(),
        decline: fn(),
    });
    return (
        <div style={{ width: 300 }}>
            <JoinRequestsView vm={vm} />
        </div>
    );
}

const meta = {
    title: "Desktop/JoinRequests",
    component: Requests,
    args: {
        requests: [
            { userId: "@carol:matrix.org", name: "Carol", reason: "Bob sent me the link" },
            { userId: "@dave.with.a.very.long.username:example.org", name: "Dave" },
        ],
        expanded: true,
        canDecline: true,
        busyIds: [],
    },
} satisfies Meta<typeof Requests>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {};
export const Closed: Story = { args: { expanded: false } };
export const OnePerson: Story = { args: { requests: [{ userId: "@carol:matrix.org", name: "Carol" }] } };
export const CannotDecline: Story = { args: { canDecline: false } };
export const Failed: Story = { args: { error: "That didn't work. Try again." } };
