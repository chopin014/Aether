/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { type Meta, type StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import {
    AccountOverviewView,
    type AccountOverviewViewActions,
    type AccountOverviewViewSnapshot,
} from "./AccountOverviewView";
import { useMockedViewModel } from "../../core/viewmodel";

function AccountOverviewStory(snapshot: AccountOverviewViewSnapshot): JSX.Element {
    const vm = useMockedViewModel<AccountOverviewViewSnapshot, AccountOverviewViewActions>(snapshot, {
        editProfile: fn(),
        copyUserId: fn(),
        toggleEmailEditor: fn(),
        togglePasswordEditor: fn(),
        manageAccount: fn(),
        openSessions: fn(),
        deactivate: fn(),
    });
    return (
        <div style={{ maxWidth: 640 }}>
            <AccountOverviewView vm={vm} passwordEditor={<p>Password form</p>} emailEditor={<p>Email form</p>} />
        </div>
    );
}

const meta = {
    title: "Desktop/Settings/Account overview",
    component: AccountOverviewStory,
    args: {
        identity: { userId: "@chopin:matrix.org", displayName: "chopin", roles: [] },
        emails: [],
        canChangeEmails: true,
        password: "managed",
        accountManagementHost: "matrix.org",
        sessionCount: 3,
        canDeactivate: true,
        copied: false,
    },
} satisfies Meta<typeof AccountOverviewStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ManagedElsewhere: Story = {};
export const ChangePassword: Story = { args: { password: "change", editing: "password" } };
export const WithEmail: Story = { args: { emails: ["chopin@example.org"] } };
export const NoDeactivation: Story = { args: { canDeactivate: false } };
