/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { type Meta, type StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import {
    DesktopSearchResultsView,
    type DesktopSearchResultsActions,
    type DesktopSearchResultsSnapshot,
} from "./DesktopSearchResultsView";
import { useMockedViewModel } from "../../core/viewmodel";

function ResultsStory(snapshot: DesktopSearchResultsSnapshot): JSX.Element {
    const vm = useMockedViewModel<DesktopSearchResultsSnapshot, DesktopSearchResultsActions>(snapshot, {
        setSort: fn(),
        loadMore: fn(),
        retry: fn(),
        openResult: fn(),
        close: fn(),
        openSecuritySettings: fn(),
    });
    return (
        <div style={{ width: 420, height: 560 }}>
            <DesktopSearchResultsView
                vm={vm}
                renderAvatar={(row) => (
                    <div
                        style={{
                            width: 40,
                            height: 40,
                            borderRadius: "50%",
                            background: "var(--cpd-color-bg-accent-rest)",
                            color: "var(--cpd-color-text-on-solid-primary)",
                            display: "grid",
                            placeItems: "center",
                        }}
                    >
                        {row.senderName[0]}
                    </div>
                )}
                renderAttachment={(row) => <em>{row.attachmentName}</em>}
            />
        </div>
    );
}

const meta = {
    title: "Desktop/Search/Results",
    component: ResultsStory,
    args: {
        status: "ready",
        resultCount: 3,
        countIsLowerBound: false,
        sort: "recent",
        sorts: ["recent", "relevance"],
        hasMore: false,
        loadingMore: false,
        approximate: false,
        encryptedSkipped: false,
        browseSkipsEncrypted: false,
        activeId: null,
        groups: [
            {
                roomId: "!gen:x",
                roomName: "geral",
                rows: [
                    {
                        id: "$1",
                        roomId: "!gen:x",
                        senderId: "@alice:x",
                        senderName: "Alice",
                        timeLabel: "Oct 23, 17:00",
                        fullTimeLabel: "Friday, 23 October 2026, 17:00",
                        segments: [
                            { text: "The ", match: false },
                            { text: "budget", match: true },
                            { text: " is ready for review", match: false },
                        ],
                    },
                    {
                        id: "$2",
                        roomId: "!gen:x",
                        senderId: "@bob:x",
                        senderName: "Bob",
                        timeLabel: "Oct 22, 10:12",
                        fullTimeLabel: "Thursday, 22 October 2026, 10:12",
                        segments: [{ text: "q3-budget.pdf", match: true }],
                        attachmentName: "q3-budget.pdf",
                    },
                ],
            },
            {
                roomId: "!dev:x",
                roomName: "dev",
                rows: [
                    {
                        id: "$3",
                        roomId: "!dev:x",
                        senderId: "@alice:x",
                        senderName: "Alice",
                        timeLabel: "Oct 20, 09:00",
                        fullTimeLabel: "Tuesday, 20 October 2026, 09:00",
                        segments: [{ text: "Updated the budget sheet", match: false }],
                    },
                ],
            },
        ],
    },
} satisfies Meta<typeof ResultsStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Results: Story = {};
export const ApproximateWithMore: Story = {
    args: { approximate: true, hasMore: true, countIsLowerBound: true },
};
export const EncryptedNotice: Story = { args: { encryptedSkipped: true } };
export const Loading: Story = { args: { status: "loading", groups: [], resultCount: 0 } };
export const Empty: Story = { args: { status: "ready", groups: [], resultCount: 0 } };
export const Error: Story = { args: { status: "error", groups: [], resultCount: 0 } };
