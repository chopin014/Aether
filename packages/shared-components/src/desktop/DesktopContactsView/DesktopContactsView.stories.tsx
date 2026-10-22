/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { type Meta, type StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import {
    DesktopContactsView,
    type DesktopContactsViewSnapshot,
    type DesktopContactsViewActions,
} from "./DesktopContactsView";
import { useMockedViewModel } from "../../core/viewmodel";

function ContactsStory(snapshot: DesktopContactsViewSnapshot): JSX.Element {
    const vm = useMockedViewModel<DesktopContactsViewSnapshot, DesktopContactsViewActions>(snapshot, {
        setTab: fn(),
        setQuery: fn(),
        openHome: fn(),
        startChat: fn(),
        openConversation: fn(),
        viewProfile: fn(),
        acceptInvitation: fn(),
        declineInvitation: fn(),
        unblock: fn(),
    });
    return (
        <div style={{ height: 640 }}>
            <DesktopContactsView vm={vm} />
        </div>
    );
}
const meta = {
    title: "Desktop/Contacts",
    component: ContactsStory,
    args: {
        tab: "all",
        query: "",
        contacts: [
            { userId: "@bob:example.org", name: "Bob", presence: "online", roomId: "!dm:example.org" },
            { userId: "@charlie:example.org", name: "Charlie", presence: "offline", roomId: "!other:example.org" },
        ],
        onlineContacts: [],
        pendingCount: 0,
        busyIds: [],
    },
} satisfies Meta<typeof ContactsStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const All: Story = {};
export const Empty: Story = { args: { contacts: [] } };
export const Pending: Story = {
    args: {
        tab: "pending",
        pendingCount: 1,
        contacts: [
            {
                userId: "@bob:example.org",
                name: "Bob",
                presence: "offline",
                invited: true,
                roomId: "!invite:example.org",
            },
        ],
    },
};
export const Blocked: Story = {
    args: {
        tab: "blocked",
        contacts: [{ userId: "@bob:example.org", name: "Bob", presence: "offline", blocked: true }],
    },
};
export const NetworkError: Story = { args: { error: "That action could not be completed. Please try again." } };
