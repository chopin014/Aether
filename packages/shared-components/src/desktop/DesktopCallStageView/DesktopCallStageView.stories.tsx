/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import { useMockedViewModel } from "../../core/viewmodel";
import {
    DesktopCallStageView,
    type DesktopCallStageViewSnapshot,
    type DesktopCallStageViewActions,
} from "./DesktopCallStageView";

const actions: DesktopCallStageViewActions = {
    joinCall: fn(),
    returnToLobby: fn(),
    requestDevicePermissions: fn(),
    toggleRaisedHand: fn(),
    sendReaction: fn(),
    dismissDeviceError: fn(),
    leaveCall: fn(),
    reconnect: fn(),
    toggleLocalAudio: fn(),
    toggleLocalVideo: fn(),
    toggleScreenShare: fn(),
    startScreenShareWithQuality: fn(),
    updateScreenShareQuality: fn(),
    dismissScreenShareError: fn(),
    selectAudioInput: fn(),
    selectAudioOutput: fn(),
    selectVideoInput: fn(),
    setActiveMenu: fn(),
    setOpenTileMenuId: fn(),
    setSpotlightTileId: fn(),
    setLayoutMode: fn(),
    setParticipantMicrophoneVolume: fn(),
    toggleParticipantMicrophoneMuted: fn(),
    setScreenShareAudioVolume: fn(),
    toggleScreenShareAudioMuted: fn(),
    openInviteDialog: fn(),
    showRoomChat: fn(),
    popoutCall: fn(),
    toggleFullscreen: fn(),
    renderAudioElement: () => null,
};

/** Storybook fixtures use the same presentation contract as the retained call engine. */
function StageStory(snapshot: DesktopCallStageViewSnapshot): JSX.Element {
    const vm = useMockedViewModel(snapshot, actions);
    return (
        <div style={{ height: "640px" }}>
            <DesktopCallStageView vm={vm} />
        </div>
    );
}

const snapshot: DesktopCallStageViewSnapshot = {
    presentation: "channel",
    phase: "in_call",
    roomName: "General Voice",
    participantCount: 2,
    connected: true,
    reconnecting: false,
    encrypted: true,
    keyRotationSuppressed: false,
    localAudioEnabled: true,
    localVideoEnabled: false,
    localDeafened: false,
    sharingScreen: false,
    canShareScreen: true,
    miniMode: false,
    isFullscreen: false,
    layoutMode: "grid",
    spotlightTileId: null,
    activeMenu: null,
    openTileMenuId: null,
    audioInputDevices: [{ id: "mic-1", label: "Studio Mic", selected: true }],
    audioOutputDevices: [{ id: "spk-1", label: "Studio Monitors", selected: true }],
    videoInputDevices: [{ id: "cam-1", label: "HD Webcam", selected: true }],
    participants: [],
    screenShares: [],
    lobbyPreviewVideo: null,
    screenShareQuality: {
        resolutionHeight: 1080,
        frameRate: 30,
        maxBitrate: null,
        includeSystemAudio: true,
    },
    screenSharePolicyLimits: {
        maxResolutionHeight: null,
        maxFrameRate: null,
        maxBitrate: null,
    },
    fatalError: null,
    screenShareError: null,
    deviceError: null,
    needsDevicePermissions: false,
    permissionError: null,
    supportsReactions: true,
    localHandRaised: false,
    ringing: null,
    canShareSystemAudio: true,
};
const participants: DesktopCallStageViewSnapshot["participants"] = [
    {
        id: "alice",
        userId: "@alice:example.org",
        displayName: "Alice",
        initialLetter: "A",
        local: true,
        speaking: false,
        audioEnabled: true,
        videoEnabled: false,
        deafened: false,
        mirror: false,
        waitingForMedia: false,
        unencryptedWarning: false,
        encryptionStatus: "okay",
        handRaisedAt: null,
        reactionEmoji: null,
        video: null,
        hasVolumeControl: false,
        microphoneVolumePercent: 100,
        microphoneMuted: false,
    },
    {
        id: "bob",
        userId: "@bob:example.org",
        displayName: "Bob",
        initialLetter: "B",
        local: false,
        speaking: true,
        audioEnabled: true,
        videoEnabled: false,
        deafened: false,
        mirror: false,
        waitingForMedia: false,
        unencryptedWarning: false,
        encryptionStatus: "okay",
        handRaisedAt: null,
        reactionEmoji: null,
        video: null,
        hasVolumeControl: true,
        microphoneVolumePercent: 80,
        microphoneMuted: false,
    },
];

const meta = {
    title: "Desktop/Call stage",
    component: StageStory,
    args: { ...snapshot, participants },
    parameters: { layout: "fullscreen" },
} satisfies Meta<typeof StageStory>;
// Storybook indexes the metadata through its required default export.
export default meta;
type Story = StoryObj<typeof meta>;

export const Connected: Story = {};
export const Conversation: Story = { args: { presentation: "conversation" } };
export const AloneInChannel: Story = { args: { participants: participants.slice(0, 1), participantCount: 1 } };
export const Lobby: Story = {
    args: { phase: "lobby", connected: false, participants: [], needsDevicePermissions: true },
};
export const Reconnecting: Story = { args: { phase: "reconnecting", connected: false, reconnecting: true } };
export const Error: Story = {
    args: {
        phase: "error",
        connected: false,
        fatalError: {
            code: "connection",
            title: "Connection interrupted",
            message: "The call server cannot be reached.",
            canReconnect: true,
        },
    },
};
export const Sharing: Story = {
    args: {
        layoutMode: "spotlight",
        spotlightTileId: "share",
        screenShares: [
            {
                id: "share",
                userId: "@bob:example.org",
                displayName: "Bob",
                initialLetter: "B",
                local: false,
                videoEnabled: true,
                audioEnabled: true,
                unencryptedWarning: false,
                encryptionStatus: "okay",
                video: null,
                hasStreamAudioVolumeControl: true,
                streamAudioVolumePercent: 65,
                streamAudioMuted: false,
            },
        ],
    },
};
