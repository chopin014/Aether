/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, type ReactNode, useState } from "react";
import { type Meta, type StoryObj } from "@storybook/react-vite";

import { AnimatedDeviceIcon, HangUpIcon, NoiseSuppressionIcon, ReactionIcon, ScreenShareIcon, SignalIcon } from ".";
import { SoundboardIcon } from "../SoundboardView";

/** A plain button around each icon, so hovering, focusing and pressing it plays the icon's motion. */
function StoryButton({
    label,
    children,
    onClick,
}: {
    label: string;
    children: ReactNode;
    onClick?: () => void;
}): JSX.Element {
    return (
        <button
            type="button"
            aria-label={label}
            title={label}
            onClick={onClick}
            style={{
                display: "grid",
                placeItems: "center",
                width: 44,
                height: 40,
                padding: 10,
                border: 0,
                borderRadius: 10,
                color: "var(--cpd-color-icon-secondary)",
                background: "var(--cpd-color-bg-subtle-secondary)",
                cursor: "pointer",
            }}
        >
            {children}
        </button>
    );
}

function LiveIconsStory(): JSX.Element {
    const [muted, setMuted] = useState(false);
    const [deafened, setDeafened] = useState(false);
    const [cameraOff, setCameraOff] = useState(true);
    return (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <StoryButton label="Mute" onClick={() => setMuted(!muted)}>
                <AnimatedDeviceIcon device="microphone" off={muted} />
            </StoryButton>
            <StoryButton label="Deafen" onClick={() => setDeafened(!deafened)}>
                <AnimatedDeviceIcon device="headphones" off={deafened} />
            </StoryButton>
            <StoryButton label="Camera" onClick={() => setCameraOff(!cameraOff)}>
                <AnimatedDeviceIcon device="camera" off={cameraOff} />
            </StoryButton>
            <StoryButton label="Share screen">
                <ScreenShareIcon />
            </StoryButton>
            <StoryButton label="React">
                <ReactionIcon />
            </StoryButton>
            <StoryButton label="Soundboard">
                <SoundboardIcon aria-hidden="true" />
            </StoryButton>
            <StoryButton label="Noise suppression">
                <NoiseSuppressionIcon />
            </StoryButton>
            <StoryButton label="Connection">
                <SignalIcon bars={4} />
            </StoryButton>
            <StoryButton label="Connecting">
                <SignalIcon bars={2} pending />
            </StoryButton>
            <StoryButton label="Disconnect">
                <HangUpIcon />
            </StoryButton>
        </div>
    );
}

const meta = {
    title: "Desktop/Live icons",
    component: LiveIconsStory,
} satisfies Meta<typeof LiveIconsStory>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Hover, focus or press each button to see its icon act out what it does. */
export const Default: Story = {};
