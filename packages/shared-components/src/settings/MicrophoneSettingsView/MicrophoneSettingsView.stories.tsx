/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { type Meta, type StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import {
    MicrophoneSettingsView,
    type MicrophoneSettingsViewActions,
    type MicrophoneSettingsViewSnapshot,
} from "./MicrophoneSettingsView";
import { useMockedViewModel } from "../../core/viewmodel";

function MicrophoneSettingsStory(snapshot: MicrophoneSettingsViewSnapshot): JSX.Element {
    const vm = useMockedViewModel<MicrophoneSettingsViewSnapshot, MicrophoneSettingsViewActions>(snapshot, {
        setMicrophone: fn(),
        setSpeaker: fn(),
        setInputVolume: fn(),
        setTestVolume: fn(),
        setAutomaticSensitivity: fn(),
        setSensitivityDb: fn(),
        toggleTest: fn(),
    });
    return <MicrophoneSettingsView vm={vm} />;
}

const meta = {
    title: "Settings/Microphone",
    component: MicrophoneSettingsStory,
    parameters: { layout: "padded" },
    args: {
        microphones: [
            { id: "default", label: "Default — Built-in microphone" },
            { id: "usb", label: "USB microphone" },
        ],
        speakers: [
            { id: "default", label: "Default — Headphones" },
            { id: "speakers", label: "Built-in speakers" },
        ],
        microphoneId: "default",
        speakerId: "default",
        inputVolume: 100,
        testVolume: 50,
        automaticSensitivity: true,
        sensitivityDb: -50,
        levelDb: -100,
        effectiveThresholdDb: -50,
        voiceDetected: false,
        testing: false,
        starting: false,
        error: null,
        canSelectOutput: true,
    },
} satisfies Meta<typeof MicrophoneSettingsStory>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Saved device preferences before the user starts a test. */
export const Idle: Story = {};

/** Processed microphone playback with voice above the live threshold. */
export const Testing: Story = { args: { testing: true, levelDb: -24, effectiveThresholdDb: -48, voiceDetected: true } };

/** Manual sensitivity with a quiet signal that does not open the voice gate. */
export const Manual: Story = { args: { automaticSensitivity: false, testing: true, levelDb: -70 } };

/** Browser permission is pending and another test cannot be started. */
export const Starting: Story = { args: { starting: true } };

/** A denied permission remains actionable without activating the microphone. */
export const PermissionError: Story = { args: { error: "Allow microphone access in your browser and try again." } };

/** Platforms without output selection explain which playback device is used. */
export const SystemOutput: Story = { args: { canSelectOutput: false } };
