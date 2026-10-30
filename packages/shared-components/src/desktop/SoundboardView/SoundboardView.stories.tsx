/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { type Meta, type StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import { SoundboardView, type SoundboardViewSnapshot } from "./SoundboardView";
import { useMockedViewModel } from "../../core/viewmodel";

function SoundboardStory(snapshot: SoundboardViewSnapshot): JSX.Element {
    const vm = useMockedViewModel(snapshot, {
        open: fn(),
        setLibrary: fn(),
        setQuery: fn(),
        setVolume: fn(),
        play: fn(),
        setUploadLibrary: fn(),
        setUploadName: fn(),
        setUploadEmoji: fn(),
        upload: fn(),
        edit: fn(),
        setClipVolume: fn(),
        setClipRange: fn(),
        previewClip: fn(),
        stopClipPreview: fn(),
        cancelClip: fn(),
        saveClip: fn(),
        remove: fn(),
    });
    return (
        <div style={{ width: 600, maxWidth: "100%" }}>
            <SoundboardView vm={vm} />
        </div>
    );
}
const sounds = [
    { id: "airhorn", name: "Airhorn", emoji: "🔊", libraryId: "builtin" },
    { id: "quack", name: "Quack", emoji: "🦆", libraryId: "builtin" },
    { id: "sad-horn", name: "Sad horn", emoji: "🎺", libraryId: "builtin" },
    { id: "cricket", name: "Cricket", emoji: "🦗", libraryId: "builtin" },
    { id: "golf-clap", name: "Golf clap", emoji: "👏", libraryId: "builtin" },
    { id: "ba-dum-tss", name: "Ba dum tss", emoji: "🥁", libraryId: "builtin" },
];
const meta = {
    title: "Desktop/Soundboard",
    component: SoundboardStory,
    args: {
        query: "",
        libraries: [
            {
                id: "space",
                name: "My server",
                canUpload: true,
                sounds: [{ id: "hello", name: "Hello there", emoji: "👋", libraryId: "space" }],
            },
            { id: "builtin", name: "Aether sounds", canUpload: false, sounds },
        ],
        suggested: sounds,
        volume: 80,
        busy: false,
        uploadLibraryId: "space",
        uploadName: "",
        uploadEmoji: "🔊",
    },
} satisfies Meta<typeof SoundboardStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const UploadError: Story = {
    args: { error: "Choose playable audio up to 10 seconds and 512 KB." },
};

export const TrimAudio: Story = {
    args: {
        clip: {
            name: "voice-line.wav",
            duration: 24,
            peaks: Array.from({ length: 100 }, (_, i) => 0.1 + Math.abs(Math.sin(i * 1.3) * Math.cos(i / 12)) * 0.9),
            start: 5,
            end: 15,
            position: 5,
            playing: false,
            volume: 85,
        },
    },
};
export const EditSound: Story = {
    args: {
        uploadName: "Welcome",
        uploadEmoji: "👋",
        clip: {
            name: "Welcome",
            duration: 8,
            peaks: Array.from({ length: 100 }, (_, i) => 0.1 + Math.abs(Math.sin(i * 1.7)) * 0.8),
            start: 0,
            end: 8,
            position: 0,
            playing: false,
            volume: 80,
            editing: true,
        },
    },
};
