/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { type Meta, type StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import {
    DesktopVoiceVideoSettingsView,
    type DesktopVoiceVideoSettingsViewActions,
    type DesktopVoiceVideoSettingsViewSnapshot,
} from "./DesktopVoiceVideoSettingsView";
import { useMockedViewModel } from "../../core/viewmodel";

function SettingsStory(snapshot: DesktopVoiceVideoSettingsViewSnapshot): JSX.Element {
    const vm = useMockedViewModel<DesktopVoiceVideoSettingsViewSnapshot, DesktopVoiceVideoSettingsViewActions>(
        snapshot,
        {
            requestPermissions: fn(),
            setAudioInput: fn(),
            setAudioOutput: fn(),
            setVideoInput: fn(),
            setMicrophoneVolume: fn(),
            setSpeakerVolume: fn(),
            toggleMicrophoneTest: fn(),
            setInputProfile: fn(),
            setNoiseSuppression: fn(),
            setNoiseSuppressionStrength: fn(),
            setVoiceDetection: fn(),
            setSensitivityAuto: fn(),
            setSensitivity: fn(),
            setInputMode: fn(),
            toggleRecordingPushToTalk: fn(),
            clearPushToTalk: fn(),
            setPushToTalkReleaseDelay: fn(),
            setPushToTalkSound: fn(),
            setEchoCancellation: fn(),
            setAutoGainControl: fn(),
            setVoiceChannelSwitchWarning: fn(),
            toggleVideoTest: fn(),
            setMirrorVideo: fn(),
            setAlwaysPreviewVideo: fn(),
            setSoundEnabled: fn(),
            previewSound: fn(),
            openNotificationSettings: fn(),
            setPeerToPeer: fn(),
            setFallbackIceServer: fn(),
            submitDebugLogs: fn(),
            openHelp: fn(),
            resetAll: fn(),
        },
    );
    return <DesktopVoiceVideoSettingsView vm={vm} />;
}

const sound = (
    id: string,
    label: string,
    extra = false,
    enabled = true,
): DesktopVoiceVideoSettingsViewSnapshot["sounds"][number] => ({
    id,
    label,
    extra,
    enabled,
});

const meta = {
    title: "Desktop/Settings/Voice & Video",
    component: SettingsStory,
    parameters: { layout: "padded" },
    args: {
        devicesVisible: true,
        audioInputs: [
            { id: "default", label: "Default - Headset microphone" },
            { id: "usb", label: "USB studio microphone" },
        ],
        audioOutputs: [
            { id: "default", label: "Default - Headset" },
            { id: "desk", label: "Desk speakers" },
        ],
        videoInputs: [{ id: "cam", label: "HD Webcam" }],
        audioInputId: "default",
        audioOutputId: "default",
        videoInputId: "cam",
        microphoneVolume: 100,
        speakerVolume: 60,
        microphoneTest: { active: false, level: null, open: false },
        inputLevel: { level: -38, open: true, threshold: -50 },
        inputProfile: "custom",
        noiseSuppression: "enhanced",
        noiseSuppressionStrength: 100,
        voiceDetection: true,
        sensitivityAuto: false,
        sensitivity: -50,
        inputMode: "voice_activity",
        pushToTalk: { key: "Ctrl + V", recording: false, releaseDelay: 200, soundEnabled: true },
        echoCancellation: true,
        autoGainControl: true,
        voiceChannelSwitchWarning: false,
        videoTest: { active: false, stream: null },
        mirrorVideo: true,
        alwaysPreviewVideo: false,
        sounds: [
            sound("mute", "Mute"),
            sound("unmute", "Unmute"),
            sound("deafen", "Deafen"),
            sound("undeafen", "Undeafen"),
            sound("join", "Join the call"),
            sound("leave", "Leave the call"),
            sound("userJoined", "Someone joined your call", true),
            sound("userLeft", "Someone left your call", true),
            sound("cameraOn", "Camera on", true),
            sound("pttActivate", "Push to talk on", true, false),
        ],
        peerToPeer: true,
        fallbackIceServer: false,
        inCall: false,
    },
} satisfies Meta<typeof SettingsStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const TestingMicrophone: Story = {
    args: { microphoneTest: { active: true, level: -38, open: true }, sensitivityAuto: false, sensitivity: -45 },
};
export const VoiceIsolation: Story = { args: { inputProfile: "voice_isolation", sensitivityAuto: true } };
export const Studio: Story = {
    args: {
        inputProfile: "studio",
        noiseSuppression: "none",
        voiceDetection: false,
        echoCancellation: false,
        autoGainControl: false,
    },
};
export const StandardNoiseSuppression: Story = { args: { noiseSuppression: "standard" } };
export const NoiseSuppressionOverloaded: Story = {
    args: {
        microphoneTest: { active: true, level: -38, open: true },
        noiseSuppressionProblem: "overloaded",
    },
};
export const PushToTalk: Story = { args: { inputMode: "push_to_talk" } };
export const RecordingKeybind: Story = {
    args: {
        inputMode: "push_to_talk",
        pushToTalk: { key: "", recording: true, releaseDelay: 200, soundEnabled: true },
    },
};
export const NeedsPermission: Story = {
    args: { devicesVisible: false, audioInputs: [], audioOutputs: [], videoInputs: [] },
};
export const MicrophoneBlocked: Story = {
    args: { microphoneTest: { active: false, level: null, open: false, error: "denied" } },
};
export const CameraBlocked: Story = { args: { videoTest: { active: false, stream: null, error: "denied" } } };
export const InCall: Story = { args: { inCall: true } };
