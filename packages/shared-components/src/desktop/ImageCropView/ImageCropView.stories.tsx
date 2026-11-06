/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { type Meta, type StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import { ImageCropView, type ImageCropViewActions, type ImageCropViewSnapshot } from "./ImageCropView";
import { useMockedViewModel } from "../../core/viewmodel";

// The metadata below has a named default re-export, which this rule does not recognize.
/* oxlint-disable storybook/default-exports */
/** A landscape test picture, so moving and zooming are easy to see. */
const PICTURE = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1d4e89"/><stop offset="1" stop-color="#7cc6fe"/></linearGradient></defs>
<rect width="1200" height="800" fill="url(#g)"/>
<circle cx="600" cy="380" r="220" fill="#ffd166"/>
<circle cx="530" cy="340" r="28" fill="#1b1b1b"/><circle cx="670" cy="340" r="28" fill="#1b1b1b"/>
<path d="M500 450 Q600 540 700 450" stroke="#1b1b1b" stroke-width="18" fill="none" stroke-linecap="round"/>
<rect x="40" y="40" width="160" height="80" fill="#ef476f"/></svg>`)}`;

function Editor(snapshot: ImageCropViewSnapshot): JSX.Element {
    const vm = useMockedViewModel<ImageCropViewSnapshot, ImageCropViewActions>(snapshot, {
        setZoom: fn(),
        moveBy: fn(),
        rotate: fn(),
        reset: fn(),
        apply: fn(),
        keepOriginal: fn(),
        cancel: fn(),
    });
    return <ImageCropView vm={vm} />;
}

const meta = {
    title: "Desktop/ImageCrop",
    component: Editor,
    args: {
        imageUrl: PICTURE,
        imageWidth: 1200,
        imageHeight: 800,
        shape: "circle",
        aspectRatio: 1,
        rotation: 0,
        zoom: 1,
        maxZoom: 5,
        centreX: 0.5,
        centreY: 0.5,
        animated: false,
        busy: false,
    },
} satisfies Meta<typeof Editor>;
export { meta as default };
type Story = StoryObj<typeof meta>;

export const Avatar: Story = {};
export const Zoomed: Story = { args: { zoom: 2.2, centreX: 0.45, centreY: 0.42 } };
export const Turned: Story = { args: { rotation: 1 } };
export const SpaceIcon: Story = { args: { shape: "rounded" } };
export const Banner: Story = { args: { shape: "rectangle", aspectRatio: 3 } };
export const Animated: Story = { args: { animated: true } };
export const Failed: Story = { args: { error: "This image could not be edited. Try another one." } };
