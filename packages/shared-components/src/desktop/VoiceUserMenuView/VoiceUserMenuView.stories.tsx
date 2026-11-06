/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { type Meta, type StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import { VoiceUserMenuView, type VoiceUserMenuViewActions, type VoiceUserMenuViewSnapshot } from "./VoiceUserMenuView";
import { useMockedViewModel } from "../../core/viewmodel";

const actions: VoiceUserMenuViewActions = {
    viewProfile: fn(),
    mention: fn(),
    message: fn(),
    startCall: fn(),
    setVolume: fn(),
    toggleMuted: fn(),
    toggleSoundboardMuted: fn(),
    toggleVideoDisabled: fn(),
    toggleMicrophoneMuted: fn(),
    toggleDeafened: fn(),
    editProfile: fn(),
    verify: fn(),
    inviteToServer: fn(),
    copyUserId: fn(),
    toggleIgnore: fn(),
    setRole: fn(),
};

function MenuStory(snapshot: VoiceUserMenuViewSnapshot): JSX.Element {
    const vm = useMockedViewModel<VoiceUserMenuViewSnapshot, VoiceUserMenuViewActions>(snapshot, actions);
    return (
        <div style={{ minHeight: 640 }}>
            <VoiceUserMenuView vm={vm} position={{ x: 24, y: 24 }} onClose={fn()} />
        </div>
    );
}

const meta = {
    title: "Desktop/VoiceUserMenu",
    component: MenuStory,
    args: {
        userId: "@jay:example.org",
        displayName: "J ay D ee",
        isSelf: false,
        canMention: true,
        canMessage: true,
        canCall: true,
        volumePercent: 100,
        muted: false,
        soundboardMuted: false,
        videoDisabled: false,
        microphoneMuted: false,
        deafened: false,
        canVerify: true,
        isIgnored: false,
        inviteServers: [
            { id: "!terra:example.org", name: "Terra do boi gordo" },
            { id: "!english:example.org", name: "English" },
        ],
        roles: [
            { level: 100, label: "Admin", selected: false },
            { level: 50, label: "Moderator", selected: false },
            { level: 0, label: "Default", selected: true },
        ],
    },
    parameters: { layout: "fullscreen" },
} satisfies Meta<typeof MenuStory>;
// Storybook indexes the metadata through its required default export.
export default meta;
type Story = StoryObj<typeof meta>;

export const SomeoneElse: Story = {};
/** Turned up past full volume, muted for this user only, with their soundboard silenced. */
export const Boosted: Story = { args: { volumePercent: 175, soundboardMuted: true } };
export const Muted: Story = { args: { muted: true } };
/** The user's own menu offers their microphone and deafen instead of a volume. */
export const Self: Story = {
    args: { isSelf: true, canCall: false, canMessage: false, inviteServers: [], roles: [], microphoneMuted: true },
};
