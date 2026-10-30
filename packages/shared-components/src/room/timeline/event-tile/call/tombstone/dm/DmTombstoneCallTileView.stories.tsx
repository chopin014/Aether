/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import React, { useState } from "react";
import { fn } from "storybook/test";
import { EventTileView } from "../../../EventTileView/EventTileView";
import { ActionBarAction, ActionBarView } from "../../../actions/ActionBarView/ActionBarView";
import { EventPresentationProvider } from "../../../../EventPresentation";

import type { Meta, StoryObj } from "@storybook/react-vite";
import { DmTombstoneCallTileView, type DmTombstoneCallTileViewSnapshot } from "./DmTombstoneCallTileView";
import { useMockedViewModel } from "../../../../../../core/viewmodel";
import { withViewDocs } from "../../../../../../../.storybook/withViewDocs";
import { CallDirection, CallType } from "../../common";

const RoomTombstoneCallTileViewWrapperImpl = (snapshot: DmTombstoneCallTileViewSnapshot): React.ReactNode => {
    const vm = useMockedViewModel(snapshot, {});
    return <DmTombstoneCallTileView vm={vm} />;
};

const RoomTombstoneCallTileViewWrapper = withViewDocs(RoomTombstoneCallTileViewWrapperImpl, DmTombstoneCallTileView);

const meta = {
    title: "Timeline/Timeline Event/Call/Tombstone/DmTombstoneCallTileView",
    component: RoomTombstoneCallTileViewWrapper,
    tags: ["autodocs"],
    argTypes: {
        timestamp: {
            control: { type: "text" },
        },
        callDirection: {
            options: [CallDirection.Incoming, CallDirection.Outgoing],
            control: { type: "radio" },
        },

        type: {
            options: [CallType.Voice, CallType.Video],
            control: { type: "radio" },
        },
    },
    args: {
        timestamp: "12:36",
        startedByDisplayName: "Bob",
        callDirection: CallDirection.Incoming,
        isCallDeclined: false,
        type: CallType.Voice,
    },
    parameters: {
        design: {
            type: "figma",
            url: "https://www.figma.com/design/rTaQE2nIUSLav4Tg3nozq7/Compound-Web-Components?node-id=11217-3905&t=iEfhUcFrV01fQeyQ-4",
        },
    },
} satisfies Meta<typeof RoomTombstoneCallTileViewWrapper>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const VoiceEnded: Story = {
    args: {
        type: CallType.Voice,
    },
};

export const VideoEnded: Story = {
    args: {
        type: CallType.Video,
    },
};

export const IncomingVoiceDeclined: Story = {
    args: {
        type: CallType.Voice,
        callDirection: CallDirection.Incoming,
        isCallDeclined: true,
    },
};

export const IncomingVideoDeclined: Story = {
    args: {
        type: CallType.Video,
        callDirection: CallDirection.Incoming,
        isCallDeclined: true,
    },
};

export const OutgoingVoiceDeclined: Story = {
    args: {
        type: CallType.Voice,
        callDirection: CallDirection.Outgoing,
        isCallDeclined: true,
    },
};

export const OutgoingVideoDeclined: Story = {
    args: {
        type: CallType.Video,
        callDirection: CallDirection.Outgoing,
        isCallDeclined: true,
    },
};

/** Call history in the same event shell used by the chat timeline. */
function CallHistoryTimeline(): React.ReactNode {
    const [hovered, setHovered] = useState(false);
    const vm = useMockedViewModel(
        {
            timestamp: "16:50",
            startedByDisplayName: "chopin",
            type: CallType.Voice,
            callDirection: CallDirection.Incoming,
            isCallDeclined: false,
        },
        {},
    );
    const actionsVm = useMockedViewModel(
        {
            actions: [ActionBarAction.React, ActionBarAction.Options],
            isDownloadEncrypted: false,
            isDownloadLoading: false,
            isPinned: false,
            isQuoteExpanded: false,
            isThreadReplyAllowed: false,
        },
        { onReactionsClick: fn(), onOptionsClick: fn() },
    );
    return (
        <EventPresentationProvider value={{ layout: "group", density: "default", messageStyle: "desktop" }}>
            <div style={{ paddingBlock: "var(--cpd-space-8x)", maxWidth: "960px" }}>
                <EventTileView
                    root={{
                        as: "div",
                        id: "before-call",
                        shape: "Room",
                        state: { isOwnEvent: false, hasReply: false },
                    }}
                    slots={{ sender: <strong>chopin</strong>, body: "Anyone around for a call?" }}
                />
                <EventTileView
                    root={{
                        as: "div",
                        id: "voice-history",
                        shape: "Room",
                        state: { isOwnEvent: false, hasReply: false, noSender: true },
                    }}
                    onMouseEnter={() => setHovered(true)}
                    onMouseLeave={() => setHovered(false)}
                    slots={{
                        body: <DmTombstoneCallTileView vm={vm} />,
                        actionBar: hovered ? <ActionBarView vm={actionsVm} /> : undefined,
                    }}
                />
                <EventTileView
                    root={{ as: "div", id: "after-call", shape: "Room", state: { isOwnEvent: false, hasReply: false } }}
                    slots={{ sender: <strong>oPon</strong>, body: "Be right there!" }}
                />
            </div>
        </EventPresentationProvider>
    );
}

export const InTimeline: Story = {
    render: () => <CallHistoryTimeline />,
};
