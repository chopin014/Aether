/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { type Meta, type StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import { PromoteToPeerView, type PromoteToPeerViewActions, type PromoteToPeerViewSnapshot } from "./PromoteToPeerView";
import { useMockedViewModel } from "../../core/viewmodel";

function Confirmation(snapshot: PromoteToPeerViewSnapshot): JSX.Element {
    const vm = useMockedViewModel<PromoteToPeerViewSnapshot, PromoteToPeerViewActions>(snapshot, {
        setTyped: fn(),
        confirm: fn(),
        cancel: fn(),
    });
    return <PromoteToPeerView vm={vm} />;
}

const meta = {
    title: "Desktop/PromoteToPeer",
    component: Confirmation,
    args: {
        target: { name: "Bob" },
        roomName: "Gamers",
        isServer: true,
        phrase: "I want to make Bob as powerful as me",
        typed: "",
        matches: false,
    },
} satisfies Meta<typeof Confirmation>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};
export const Typed: Story = { args: { typed: "I want to make Bob as powerful as me", matches: true } };
export const SeveralPeopleInChannel: Story = {
    args: {
        target: { count: 3 },
        isServer: false,
        roomName: "general",
        phrase: "I want to make these 3 people as powerful as me",
    },
};
