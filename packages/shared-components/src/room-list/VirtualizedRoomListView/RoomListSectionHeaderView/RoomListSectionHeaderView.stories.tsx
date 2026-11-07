/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import React, { type JSX } from "react";
import { fn } from "storybook/test";
import { DragDropProvider } from "@dnd-kit/react";
import { PointerActivationConstraints, PointerSensor } from "@dnd-kit/dom";

import type { Meta, StoryObj } from "@storybook/react-vite";
import {
    RoomListSectionHeaderView,
    type RoomListSectionHeaderViewSnapshot,
    type RoomListSectionHeaderActions,
    type RoomListSectionHeaderViewProps,
} from "./RoomListSectionHeaderView";
import { useMockedViewModel } from "../../../core/viewmodel";
import { withViewDocs } from "../../../../.storybook/withViewDocs";

type RoomListSectionHeaderProps = RoomListSectionHeaderViewSnapshot &
    RoomListSectionHeaderActions &
    Omit<RoomListSectionHeaderViewProps, "vm">;

const RoomListSectionHeaderViewWrapperImpl = ({
    onClick,
    onFocus,
    editSection,
    removeSection,
    createChannel,
    markCategoryAsRead,
    collapseAllCategories,
    editCategory,
    deleteCategory,
    muteCategory,
    unmuteCategory,
    isFocused,
    sectionIndex,
    sectionCount,
    indexInList,
    roomCountInSection,
    ...rest
}: RoomListSectionHeaderProps): JSX.Element => {
    const vm = useMockedViewModel(rest, {
        onClick,
        editSection,
        removeSection,
        createChannel,
        markCategoryAsRead,
        collapseAllCategories,
        editCategory,
        deleteCategory,
        muteCategory,
        unmuteCategory,
    });
    return (
        <RoomListSectionHeaderView
            vm={vm}
            onFocus={onFocus}
            isFocused={isFocused}
            sectionIndex={sectionIndex}
            sectionCount={sectionCount}
            indexInList={indexInList}
            roomCountInSection={roomCountInSection}
        />
    );
};
const RoomListSectionHeaderViewWrapper = withViewDocs(RoomListSectionHeaderViewWrapperImpl, RoomListSectionHeaderView);

const meta = {
    title: "Room List/RoomListSectionHeaderView",
    component: RoomListSectionHeaderViewWrapper,
    tags: ["autodocs"],
    args: {
        id: "favourites",
        title: "Favourites",
        isExpanded: true,
        isFocused: false,
        isUnread: false,
        notification: {
            hasAnyNotificationOrActivity: false,
            isUnsentMessage: false,
            invited: false,
            isMention: false,
            isActivityNotification: false,
            isNotification: false,
            hasUnreadCount: false,
            count: 0,
            muted: false,
        },
        displaySectionMenu: true,
        canBeReordered: true,
        acceptedRoomKind: "any",
        onClick: fn(),
        onFocus: fn(),
        editSection: fn(),
        removeSection: fn(),
        createChannel: fn(),
        markCategoryAsRead: fn(),
        collapseAllCategories: fn(),
        editCategory: fn(),
        deleteCategory: fn(),
        muteCategory: fn(),
        unmuteCategory: fn(),
        sectionIndex: 1,
        sectionCount: 3,
        roomCountInSection: 5,
        indexInList: 3,
    },
    decorators: [
        (Story) => (
            <DragDropProvider
                sensors={[
                    PointerSensor.configure({
                        activationConstraints: [new PointerActivationConstraints.Distance({ value: 5 })],
                    }),
                ]}
            >
                <div role="treegrid" style={{ width: "320px" }}>
                    <Story />
                </div>
            </DragDropProvider>
        ),
    ],
    parameters: {
        design: {
            type: "figma",
            url: "https://www.figma.com/design/rTaQE2nIUSLav4Tg3nozq7/Compound-Web-Components?node-id=10657-20703&p=f",
        },
    },
} satisfies Meta<typeof RoomListSectionHeaderViewWrapper>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Collapsed: Story = {
    args: {
        isExpanded: false,
    },
};

export const LongTitle: Story = {
    args: {
        title: "This is a very long title that should be truncated with an ellipsis",
    },
};

export const FirstHeader: Story = {
    args: {
        sectionIndex: 0,
    },
};

export const LastHeaderCollapsed: Story = {
    args: {
        isExpanded: false,
        sectionIndex: 2,
    },
};

export const Unread: Story = {
    args: {
        isUnread: true,
    },
};

export const WithNotificationDecoration: Story = {
    args: {
        isUnread: true,
        notification: {
            hasAnyNotificationOrActivity: true,
            isUnsentMessage: true,
            invited: true,
            isMention: true,
            isActivityNotification: false,
            isNotification: true,
            hasUnreadCount: true,
            count: 12,
            muted: false,
            callType: "video",
        },
        isExpanded: false,
    },
};

/** A desktop channel section offers to create a channel from its header, as in Discord. */
export const DesktopChannelCategory: Story = {
    args: {
        id: "desktop.voice_channels",
        title: "Voice Channels",
        displaySectionMenu: false,
        canBeReordered: false,
        acceptedRoomKind: "none",
        createChannelKind: "voice",
    },
};

/** A server category the person may edit: right-clicking it opens its menu, as in Discord. */
export const DesktopServerCategory: Story = {
    args: {
        id: "desktop.category.c_7e50cc0b-4fb5-4ed0-89db-769fb11c837e",
        title: "Governo",
        displaySectionMenu: false,
        canBeReordered: true,
        acceptedRoomKind: "nonDm",
        createChannelKind: "text",
        categoryMenu: { canEdit: true },
        isUnread: true,
    },
};

/** The channels at the top of a server's list have no header, only a gap. */
export const DesktopUncategorized: Story = {
    args: {
        id: "desktop.uncategorized",
        title: "",
        displaySectionMenu: false,
        canBeReordered: false,
        acceptedRoomKind: "none",
        isHidden: true,
    },
};

/** A category whose channels are all muted is dimmed, as in Discord. */
export const DesktopMutedCategory: Story = {
    args: {
        ...DesktopServerCategory.args,
        isUnread: false,
        isMuted: true,
        categoryMenu: { canEdit: true, isMuted: true },
    },
};
