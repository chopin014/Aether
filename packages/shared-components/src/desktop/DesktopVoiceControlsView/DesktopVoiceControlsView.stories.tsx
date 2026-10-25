/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, useEffect, useState } from "react";
import { type Meta, type StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import {
    DesktopVoiceControlsView,
    DesktopVoiceConnectionView,
    type DesktopVoiceControlsViewSnapshot,
    type DesktopVoiceControlsViewActions,
} from "./DesktopVoiceControlsView";
import { useMockedViewModel } from "../../core/viewmodel";

function VoiceStory(snapshot: DesktopVoiceControlsViewSnapshot): JSX.Element {
    const [current, setCurrent] = useState(snapshot);
    useEffect(() => setCurrent(snapshot), [snapshot]);
    const vm = useMockedViewModel<DesktopVoiceControlsViewSnapshot, DesktopVoiceControlsViewActions>(current, {
        toggleMicrophone: fn(),
        toggleDeafened: fn(),
        toggleVideo: fn(),
        toggleScreenShare: fn(),
        disconnect: fn(),
        showCall: fn(),
        setPanel: fn((panel) => setCurrent((value) => ({ ...value, panel }))),
        setNoiseSuppression: fn(async (noiseSuppression) => setCurrent((value) => ({ ...value, noiseSuppression }))),
        setNoiseSuppressionStrength: fn(async (noiseSuppressionStrength) =>
            setCurrent((value) => ({ ...value, noiseSuppressionStrength })),
        ),
        toggleMicrophoneTest: fn(async () =>
            setCurrent((value) => ({
                ...value,
                microphoneTest: { active: !value.microphoneTest.active, level: -24, open: true },
            })),
        ),
    });
    return (
        <div
            style={{
                width: 340,
                maxWidth: "100%",
                minHeight: 560,
                display: "flex",
                flexDirection: "column",
                justifyContent: "flex-end",
            }}
        >
            <DesktopVoiceConnectionView vm={vm} />
            <DesktopVoiceControlsView vm={vm} />
        </div>
    );
}
const meta = {
    title: "Desktop/Voice controls",
    component: VoiceStory,
    args: {
        microphoneMuted: false,
        deafened: false,
        videoEnabled: false,
        screenShareAvailable: true,
        screenSharing: false,
        busy: false,
        panel: null,
        noiseSuppression: true,
        noiseSuppressionStrength: 100,
        microphoneTest: { active: false, level: null, open: false },
        connection: {
            state: "connected",
            quality: "good",
            rttMs: 17,
            averageRttMs: 19,
            outboundPacketLossPercent: 0,
            history: [20, 18, 19, 17, 18, 21, 19, 17],
        },
    },
} satisfies Meta<typeof VoiceStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Connected: Story = { args: { roomName: "Lounge" } };
export const SharingScreen: Story = { args: { roomName: "Lounge", videoEnabled: true, screenSharing: true } };
export const ScreenShareUnavailable: Story = { args: { roomName: "Lounge", screenShareAvailable: false } };
export const Deafened: Story = { args: { roomName: "Lounge", microphoneMuted: true, deafened: true } };
export const DeviceError: Story = { args: { error: "The audio control could not be changed. Please try again." } };

export const NoiseSuppression: Story = { args: { roomName: "Lounge", panel: "noise", noiseSuppressionStrength: 80 } };
export const TestingMicrophone: Story = {
    args: { roomName: "Lounge", panel: "noise", microphoneTest: { active: true, level: -24, open: true } },
};
export const NoiseSuppressionUnavailable: Story = {
    args: { roomName: "Lounge", panel: "noise", noiseSuppressionProblem: "failed" },
};
export const ConnectionDetails: Story = { args: { roomName: "Lounge", panel: "connection" } };
export const Connecting: Story = {
    args: {
        roomName: "Lounge",
        connection: {
            state: "connecting",
            quality: "unknown",
            rttMs: null,
            averageRttMs: null,
            outboundPacketLossPercent: null,
            history: [],
        },
    },
};
export const Reconnecting: Story = {
    args: { ...Connecting.args, connection: { ...Connecting.args!.connection!, state: "reconnecting" } },
};
export const StatisticsUnavailable: Story = {
    args: {
        ...Connecting.args,
        panel: "connection",
        connection: { ...Connecting.args!.connection!, state: "connected" },
    },
};
export const PoorConnection: Story = {
    args: {
        roomName: "Lounge",
        panel: "connection",
        connection: {
            state: "connected",
            quality: "poor",
            rttMs: 320,
            averageRttMs: 191,
            outboundPacketLossPercent: 6.2,
            history: [17, 23, 90, 120, null, 250, 300, 320],
        },
    },
};
