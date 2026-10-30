/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { type Meta, type StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import {
    DesktopFullProfileView,
    type DesktopFullProfileViewActions,
    type DesktopFullProfileViewSnapshot,
} from "./DesktopFullProfileView";
import { useMockedViewModel } from "../../core/viewmodel";

function FullStory(snapshot: DesktopFullProfileViewSnapshot): JSX.Element {
    const vm = useMockedViewModel<DesktopFullProfileViewSnapshot, DesktopFullProfileViewActions>(snapshot, {
        message: fn(),
        verify: fn(),
        mention: fn(),
        copyLink: fn(),
        toggleIgnore: fn(),
        moderate: fn(),
        openRoom: fn(),
        retryMutualRooms: fn(),
        setNote: fn(),
        editProfile: fn(),
        close: fn(),
    });
    return <DesktopFullProfileView vm={vm} />;
}

const meta = {
    title: "Desktop/Profile/Full",
    component: FullStory,
    parameters: { layout: "fullscreen" },
    args: {
        userId: "@robin:example.org",
        displayName: "Robin",
        presence: "online",
        roles: [{ key: "admin", label: "Admin" }],
        isMe: false,
        canMessage: true,
        canVerify: true,
        isVerified: false,
        canMention: true,
        isIgnored: false,
        canModerate: false,
        memberSince: { text: "May 3, 2026", datetime: "2026-05-03T10:00:00.000Z" },
        verification: { verified: false, deviceCount: 2 },
        mutualRooms: {
            state: "ready",
            items: [
                { id: "!a:example.org", name: "general" },
                { id: "!b:example.org", name: "design" },
            ],
        },
        mutualSpaces: [{ id: "!s:example.org", name: "Aether HQ" }],
    },
} satisfies Meta<typeof FullStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const MutualRoomsUnsupported: Story = { args: { mutualRooms: { state: "unsupported", items: [] } } };
export const MutualRoomsLoading: Story = { args: { mutualRooms: { state: "loading", items: [] } } };
export const MutualRoomsFailed: Story = { args: { mutualRooms: { state: "error", items: [] } } };
export const Self: Story = { args: { isMe: true, canMessage: false, canVerify: false } };

const BANNER = `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 384"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#1c2e86"/><stop offset="1" stop-color="#b14bff"/></linearGradient></defs><rect width="960" height="384" fill="url(#g)"/><path d="M0 384 300 120l180 150 170-190 310 304Z" fill="#141a55"/></svg>`,
)}`;
const poster = (colour: string): string =>
    `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 3 4"><rect width="3" height="4" fill="${colour}"/></svg>`)}`;

export const Decorated: Story = {
    args: {
        displayName: "Benshin Jimpact",
        pronouns: "he/him",
        status: { emoji: "❄️", text: "Hwy starest þu on me?" },
        bio: "Aerospace | UAVs | Programming | Simulators | Game Engines | CGI\nhttps://example.org/about",
        tag: { label: "ENG", emoji: "💗", colour: "#ff7ab6", spaceName: "English Server" },
        localTime: "14:32",
        note: "",
        links: [{ url: "https://example.org/", label: "Portfolio", host: "example.org" }],
        board: {
            title: "Games I like",
            items: [
                { id: "1", title: "Squad", caption: "brrrrrrrrr", imageUrl: poster("#7a6a3a") },
                { id: "2", title: "DCS World", imageUrl: poster("#3a5a7a") },
                { id: "3", title: "Arma Reforger", imageUrl: poster("#3a6a5a") },
            ],
        },
        appearance: {
            bannerUrl: BANNER,
            theme: { primary: "#14163a", accent: "#7b2fd0" },
            decoration: "flame-crown",
            effect: "snow",
            nameStyle: { font: "medieval", effect: "gradient", colour: "#ff7ab6", colourEnd: "#ffd27a" },
        },
    },
};
export const LightTheme: Story = {
    args: {
        ...Decorated.args,
        appearance: {
            ...Decorated.args?.appearance,
            theme: { primary: "#b8d4ff", accent: "#e3c7ff" },
            decoration: "frost-crown",
            effect: "stars",
            nameStyle: { font: "medieval", effect: "gradient", colour: "#b0245e", colourEnd: "#5a1fb0" },
        },
    },
};
