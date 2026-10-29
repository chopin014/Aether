/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, useState } from "react";
import { type Meta, type StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import { ChannelKindPicker, type ChannelKindPickerProps } from "./ChannelKindPicker";

/** Keeps the picked kind, so the story behaves like the dialog that owns it. */
function PickerStory({ value, onChange }: ChannelKindPickerProps): JSX.Element {
    const [kind, setKind] = useState(value);
    return (
        <div style={{ width: 420 }}>
            <ChannelKindPicker
                value={kind}
                onChange={(next) => {
                    setKind(next);
                    onChange(next);
                }}
            />
        </div>
    );
}

const meta = {
    title: "Desktop/ChannelKindPicker",
    component: PickerStory,
    args: { value: "text", onChange: fn() },
} satisfies Meta<typeof PickerStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Text: Story = {};
export const Voice: Story = { args: { value: "voice" } };
