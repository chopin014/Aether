/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import { useMockedViewModel } from "../../core/viewmodel";
import {
    DesktopScreenSharePickerView,
    type DesktopScreenSharePickerViewSnapshot,
} from "./DesktopScreenSharePickerView";

const snapshot: DesktopScreenSharePickerViewSnapshot = {
    step: "source",
    tab: "window",
    sources: [{ id: "window:1:0", name: "Project notes", thumbnailURL: "" }],
    selectedSource: null,
    loading: false,
    error: null,
    quality: { resolutionHeight: 1080, frameRate: 30, maxBitrate: null, includeSystemAudio: false },
    limits: { maxResolutionHeight: 1080, maxFrameRate: 30, maxBitrate: 5_000_000 },
};

function PickerStory(props: DesktopScreenSharePickerViewSnapshot): React.JSX.Element {
    const vm = useMockedViewModel(props, {
        selectTab: fn(),
        selectSource: fn(),
        setQuality: fn(),
        next: fn(),
        back: fn(),
        confirm: fn(),
        cancel: fn(),
        refresh: fn().mockResolvedValue(undefined),
    });
    return <DesktopScreenSharePickerView vm={vm} />;
}

const meta = { title: "Desktop/Screen Share Picker", component: PickerStory, args: snapshot } satisfies Meta<
    typeof PickerStory
>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Sources: Story = {};
export const Quality: Story = { args: { step: "quality", selectedSource: snapshot.sources[0] } };
