/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { type Meta, type StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import { DesktopAccountDockView } from "./DesktopAccountDockView";
import { type UserMenuViewSnapshot, type UserMenuViewActions } from "../../menus/UserMenu/UserMenu";
import { MockViewModel, useMockedViewModel } from "../../core/viewmodel";
import { type SetStatusViewSnapshot } from "../../status/SetStatusView";

const statusVm = Object.assign(new MockViewModel<SetStatusViewSnapshot>({}), { setStatus: fn(), clearStatus: fn() });

function DockStory(snapshot: UserMenuViewSnapshot): JSX.Element {
    const vm = useMockedViewModel<UserMenuViewSnapshot, UserMenuViewActions>(snapshot, {
        setOpen: fn(),
        createAccount: fn(),
        signIn: fn(),
        linkNewDevice: fn(),
        openFeedback: fn(),
        openHomePage: fn(),
        openSecurity: fn(),
        openSettings: fn(),
        clearStatus: fn(),
    });
    return (
        <div style={{ width: 300 }}>
            <DesktopAccountDockView vm={vm} />
        </div>
    );
}

const meta = {
    title: "Desktop/Account dock",
    component: DockStory,
    args: {
        open: false,
        expanded: true,
        displayName: "Alice",
        userId: "@alice:example.org",
        setStatusViewModel: statusVm,
        actions: { openSettings: true, openSecurity: true, linkNewDevice: true },
    },
} satisfies Meta<typeof DockStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const LongIdentity: Story = {
    args: { displayName: "Alice with a very long display name", userId: "@alice:very-long-homeserver.example.org" },
};
export const RestrictedAccount: Story = { args: { actions: {} } };
