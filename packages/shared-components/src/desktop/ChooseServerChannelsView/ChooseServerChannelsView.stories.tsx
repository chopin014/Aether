/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { type Meta, type StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import {
    ChooseServerChannelsView,
    type ChooseServerChannelsViewActions,
    type ChooseServerChannelsViewSnapshot,
} from "./ChooseServerChannelsView";
import { useMockedViewModel } from "../../core/viewmodel";

function Picker(snapshot: ChooseServerChannelsViewSnapshot): JSX.Element {
    const vm = useMockedViewModel<ChooseServerChannelsViewSnapshot, ChooseServerChannelsViewActions>(snapshot, {
        toggle: fn(),
        setAll: fn(),
        confirm: fn(),
        skip: fn(),
    });
    return (
        <div style={{ maxInlineSize: 480 }}>
            <ChooseServerChannelsView vm={vm} />
        </div>
    );
}

const text = ["announcements", "general", "memes", "clips", "lfg", "off-topic", "art", "music", "help", "rules"];

const meta = {
    title: "Desktop/ChooseServerChannels",
    component: Picker,
    args: {
        serverName: "Gamers",
        channels: [
            ...text.map((name, index) => ({
                id: `!${name}`,
                name,
                kind: "text" as const,
                topic: index % 3 === 0 ? `Everything about ${name}` : undefined,
                memberCount: 200 - index * 13,
                selected: index < 2,
            })),
            { id: "!lounge", name: "Lounge", kind: "voice" as const, memberCount: 80, selected: true },
            { id: "!squad", name: "Squad", kind: "voice" as const, memberCount: 25, selected: false },
        ],
        busy: false,
    },
} satisfies Meta<typeof Picker>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Joining: Story = { args: { busy: true } };
