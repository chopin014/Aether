/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type Meta, type StoryObj } from "@storybook/react-vite";

import { ServerVoiceActivity } from "./ServerVoiceActivity";

const person = (name: string): { userId: string; name: string } => ({
    userId: `@${name.toLowerCase()}:example.org`,
    name,
});

const meta = {
    title: "Desktop/Server voice activity",
    component: ServerVoiceActivity,
    args: {
        channels: [
            { roomId: "!lounge", name: "Lounge", people: ["Alice", "Bob", "Carol"].map(person) },
            {
                roomId: "!geral",
                name: "Geral#1",
                people: ["Dave", "Erin", "Frank", "Grace", "Heidi", "Ivan", "Judy"].map(person),
            },
        ],
    },
} satisfies Meta<typeof ServerVoiceActivity>;
// Storybook indexes the metadata through its required default export.
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
