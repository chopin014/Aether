/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { type Meta, type StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import { IncomingCallView, type IncomingCallViewActions, type IncomingCallViewSnapshot } from "./IncomingCallView";
import { useMockedViewModel } from "../../core/viewmodel";

// The metadata below has a named default re-export, which this rule does not recognize.
/* oxlint-disable storybook/default-exports */
function Popup(snapshot: IncomingCallViewSnapshot): JSX.Element {
    const vm = useMockedViewModel<IncomingCallViewSnapshot, IncomingCallViewActions>(snapshot, {
        accept: fn(),
        decline: fn(),
    });
    return <IncomingCallView vm={vm} />;
}

const meta = {
    title: "Desktop/IncomingCall",
    component: Popup,
    args: { calls: [{ id: "dm", name: "Pon", initialLetter: "P", kind: "voice" }] },
} satisfies Meta<typeof Popup>;
export { meta as default };
type Story = StoryObj<typeof meta>;
export const VoiceCall: Story = {};
export const VideoCall: Story = {
    args: { calls: [{ id: "dm", name: "Pon", initialLetter: "P", kind: "video" }] },
};
export const LongName: Story = {
    args: {
        calls: [{ id: "dm", name: "Someone with a remarkably long display name", initialLetter: "S", kind: "voice" }],
    },
};
export const SeveralCalls: Story = {
    args: {
        calls: [
            { id: "dm", name: "Pon", initialLetter: "P", kind: "voice" },
            { id: "group", name: "Business Meeting", initialLetter: "B", kind: "video", startedBy: "Ana" },
        ],
    },
};
