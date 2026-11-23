/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import type { Meta, StoryObj } from "@storybook/react-vite";
import { CallParticipantDragOverlayView } from "./CallParticipantDragOverlayView";

const meta = {
    title: "Room List/CallParticipantDragOverlayView",
    component: CallParticipantDragOverlayView,
    tags: ["autodocs"],
    args: {
        userId: "@chopin:example.org",
        name: "chopin",
    },
} satisfies Meta<typeof CallParticipantDragOverlayView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const LongName: Story = {
    args: { name: "Somebody with a very long display name that does not fit" },
};
