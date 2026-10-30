/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { type Meta, type StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import {
    ColorThemeView,
    type ColorThemeColors,
    type ColorThemeViewActions,
    type ColorThemeViewSnapshot,
} from "./ColorThemeView";
import { useMockedViewModel } from "../../core/viewmodel";

const dark: ColorThemeColors = {
    rail: "#121214",
    sidebar: "#121214",
    chat: "#1a1a1e",
    raised: "#222327",
    text: "#efeff1",
    mutedText: "#96979e",
    accent: "#5865f2",
};
const legacy: ColorThemeColors = {
    rail: "#1e1f22",
    sidebar: "#2b2d31",
    chat: "#313338",
    raised: "#383a40",
    text: "#dbdee1",
    mutedText: "#949ba4",
    accent: "#5865f2",
};
const light: ColorThemeColors = {
    rail: "#f3f3f4",
    sidebar: "#f3f3f4",
    chat: "#fbfbfb",
    raised: "#ffffff",
    text: "#2e2e34",
    mutedText: "#6c6d76",
    accent: "#5865f2",
};

function ColorThemeStory(snapshot: ColorThemeViewSnapshot): JSX.Element {
    const vm = useMockedViewModel<ColorThemeViewSnapshot, ColorThemeViewActions>(snapshot, {
        selectTheme: fn(),
        setColor: fn(),
    });
    return <ColorThemeView vm={vm} />;
}

const meta = {
    title: "Desktop/Settings/Colour themes",
    component: ColorThemeStory,
    args: {
        groups: [
            {
                id: "aether",
                themes: [
                    { id: "aether-dark", colors: dark },
                    { id: "aether-light", colors: light },
                    { id: "custom", colors: legacy },
                ],
            },
            {
                id: "discord",
                themes: [
                    { id: "discord-light", colors: light },
                    { id: "discord-ash", colors: legacy },
                    { id: "discord-dark", colors: dark },
                ],
            },
        ],
        selectedId: "discord-dark",
        colors: dark,
    },
} satisfies Meta<typeof ColorThemeStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
/** A high contrast or custom theme is in use, so none of the colour themes applies. */
export const NothingSelected: Story = { args: { selectedId: undefined } };
