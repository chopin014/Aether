/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type Meta, type StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import { DesktopKeybindsView, type DesktopKeybindsSnapshot } from "./DesktopKeybindsView";
import { MockViewModel } from "../../core/viewmodel";

const snapshot: DesktopKeybindsSnapshot = {
    rows: [
        { id: "push_to_talk", label: "Push to talk", key: "Left Ctrl", status: "Available across applications" },
        { id: "push_to_mute", label: "Push to mute", key: "", status: "No key assigned" },
        {
            id: "toggle_mute",
            label: "Toggle microphone",
            key: "Ctrl + M",
            status: "This key is already in use. Choose another combination.",
        },
        { id: "toggle_deafen", label: "Toggle deafen", key: "Ctrl + D", status: "Available across applications" },
        { id: "toggle_input_mode", label: "Toggle input mode", key: "", status: "No key assigned" },
        { id: "show_hide", label: "Show or hide Aether", key: "", status: "Unavailable on this desktop session" },
    ],
    description:
        "Shortcuts work across applications when your desktop allows them. Registration status is shown for each action.",
};
const meta = {
    title: "Desktop/Keybinds",
    component: DesktopKeybindsView,
    args: { vm: Object.assign(new MockViewModel(snapshot), { record: fn(), clear: fn() }) },
} satisfies Meta<typeof DesktopKeybindsView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
