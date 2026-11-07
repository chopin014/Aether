/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { type Meta, type StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import {
    DesktopProfilePopoutView,
    type DesktopProfilePopoutViewActions,
    type DesktopProfilePopoutViewSnapshot,
} from "./DesktopProfilePopoutView";
import { useMockedViewModel } from "../../core/viewmodel";

function PopoutStory(snapshot: DesktopProfilePopoutViewSnapshot): JSX.Element {
    const vm = useMockedViewModel<DesktopProfilePopoutViewSnapshot, DesktopProfilePopoutViewActions>(snapshot, {
        message: fn(),
        verify: fn(),
        mention: fn(),
        copyLink: fn(),
        toggleIgnore: fn(),
        moderate: fn(),
        openFullProfile: fn(),
        openRoom: fn(),
        editProfile: fn(),
        close: fn(),
    });
    return <DesktopProfilePopoutView vm={vm} />;
}

const meta = {
    title: "Desktop/Profile/Popout",
    component: PopoutStory,
    args: {
        userId: "@robin:example.org",
        displayName: "Robin",
        presence: "online",
        roles: [{ key: "moderator", label: "Moderator" }],
        isMe: false,
        canMessage: true,
        canVerify: true,
        isVerified: false,
        canMention: true,
        isIgnored: false,
        canModerate: true,
        busy: false,
        error: false,
    },
} satisfies Meta<typeof PopoutStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const WithStatus: Story = { args: { status: { emoji: "🎧", text: "Listening to lo-fi" } } };
export const UnknownPresence: Story = { args: { presence: undefined, roles: [] } };
export const OpenFailed: Story = { args: { error: true } };
export const Self: Story = { args: { isMe: true, canMessage: false, canVerify: false, canModerate: false } };
export const Decorated: Story = {
    args: {
        displayName: "Airo",
        pronouns: "they/them",
        status: { emoji: "🦨", text: "Skunk Works" },
        bio: "Aerospace | UAVs | Programming | Simulators | Game Engines | CGI. Long enough to fold away behind the button that opens the rest of it.",
        tag: { label: "ENG", emoji: "💗", colour: "#ff7ab6", spaceName: "English Server" },
        appearance: {
            theme: { primary: "#1b0a0a", accent: "#c8102e" },
            decoration: "flame-crown",
            effect: "embers",
            nameStyle: { font: "pixel", effect: "neon", colour: "#ff3a6a", colourEnd: "#ff0044" },
        },
    },
};
export const LightTheme: Story = {
    args: {
        ...Decorated.args,
        appearance: {
            theme: { primary: "#b8d4ff", accent: "#e3c7ff" },
            decoration: "frost-crown",
            effect: "snow",
            nameStyle: { font: "medieval", effect: "gradient", colour: "#d14f7a", colourEnd: "#7b2fd0" },
        },
    },
};
/** A themed cosmic card: the ringed decoration, comets over it and someone to join in voice. */
export const InVoice: Story = {
    args: {
        displayName: "LiTz",
        pronouns: "he/him",
        bio: "Building Aether. Usually in the Lounge.",
        mutual: {
            count: 4,
            faces: [
                { id: "!a:example.org", name: "Aether HQ" },
                { id: "!b:example.org", name: "Bussines party" },
                { id: "!c:example.org", name: "Work in Silence" },
            ],
        },
        activity: {
            kind: "voice",
            roomId: "!voice:example.org",
            channelName: "Geral#1",
            spaceName: "Terra do borgerds",
            count: 3,
            people: [
                { id: "@litz:example.org", name: "LiTz" },
                { id: "@chopin:example.org", name: "chopin" },
                { id: "@pon:example.org", name: "Pon" },
            ],
        },
        appearance: {
            theme: { primary: "#0b1030", accent: "#3a1f7a" },
            decoration: "ringed",
            effect: "comets",
            nameStyle: { font: "scifi", effect: "prism", colour: "#8ed8ea", colourEnd: "#c77dff" },
        },
    },
};
/** Nothing chosen at all: the banner takes the avatar's colour. */
export const Plain: Story = { args: { roles: [], canVerify: false } };

