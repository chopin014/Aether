/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
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
    const vm = useMockedViewModel<DesktopVoiceControlsViewSnapshot, DesktopVoiceControlsViewActions>(snapshot, {
        toggleMicrophone: fn(),
        toggleDeafened: fn(),
        toggleVideo: fn(),
        toggleScreenShare: fn(),
        disconnect: fn(),
        showCall: fn(),
    });
    return (
        <div style={{ width: 340 }}>
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
