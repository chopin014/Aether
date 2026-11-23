/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import React, { type JSX } from "react";
import { fn } from "storybook/test";

import type { Meta, StoryObj } from "@storybook/react-vite";
import type { Room, RoomListItemViewModel, RoomListItemViewSnapshot } from "./RoomListItemWrapper/RoomListItemView";
import { VirtualizedRoomListView, type RoomListViewState } from "./VirtualizedRoomListView";
import type { RoomListViewSnapshot, RoomListViewActions } from "../RoomListView";
import { useMockedViewModel } from "../../core/viewmodel";
import { withViewDocs } from "../../../.storybook/withViewDocs";
import type { FilterId } from "../RoomListPrimaryFilters";
import {
    renderAvatar,
    createGetRoomItemViewModel,
    createMockRoomItemViewModel,
    mock10RoomsIds,
    createGetSectionHeaderViewModel,
    mock10RoomsSections,
} from "../story-mocks";

type RoomListStoryProps = RoomListViewSnapshot &
    RoomListViewActions & { renderAvatar: (room: Room) => React.ReactElement };

// Wrapper component that creates a mocked ViewModel
const RoomListWrapperImpl = ({
    onToggleFilter,
    createChatRoom,
    createRoom,
    getRoomItemViewModel,
    getSectionHeaderViewModel,
    updateVisibleRooms,
    updateVisibleFold,
    closeToast,
    scrollToUnreadActivity,
    setScrollToIndex,
    renderAvatar: renderAvatarProp,
    changeRoomSection,
    changeSectionOrder,
    onSectionOrRoomDragStart,
    onSectionOrRoomDragEnd,
    moveCallParticipant,
    ...rest
}: RoomListStoryProps): JSX.Element => {
    const vm = useMockedViewModel(rest, {
        onToggleFilter,
        createChatRoom,
        createRoom,
        getRoomItemViewModel,
        getSectionHeaderViewModel,
        updateVisibleRooms,
        updateVisibleFold,
        closeToast,
        scrollToUnreadActivity,
        setScrollToIndex,
        changeRoomSection,
        changeSectionOrder,
        onSectionOrRoomDragStart,
        onSectionOrRoomDragEnd,
        moveCallParticipant,
    });

    return (
        <div style={{ height: "400px", border: "1px solid #ccc" }}>
            <VirtualizedRoomListView vm={vm} renderAvatar={renderAvatarProp} />
        </div>
    );
};
const RoomListWrapper = withViewDocs(RoomListWrapperImpl, VirtualizedRoomListView);

const mockFilterIds: FilterId[] = ["unread", "people"];

const defaultRoomListState: RoomListViewState = {
    activeRoomIndex: 0,
    spaceId: "!space:server",
    filterKeys: undefined,
};

const meta = {
    title: "Room List/VirtualizedRoomListView",
    component: RoomListWrapper,
    tags: ["autodocs"],
    args: {
        isLoadingRooms: false,
        isRoomListEmpty: false,
        filterIds: mockFilterIds,
        activeFilterId: undefined,
        sections: mock10RoomsSections,
        roomListState: defaultRoomListState,
        canCreateRoom: true,
        onToggleFilter: fn(),
        createChatRoom: fn(),
        createRoom: fn(),
        getRoomItemViewModel: createGetRoomItemViewModel(mock10RoomsIds),
        getSectionHeaderViewModel: createGetSectionHeaderViewModel(mock10RoomsSections.map((section) => section.id)),
        updateVisibleRooms: fn(),
        updateVisibleFold: fn(),
        renderAvatar,
        isFlatList: true,
        closeToast: fn(),
        scrollToUnreadActivity: fn(),
        setScrollToIndex: fn(),
        changeRoomSection: fn(),
        changeSectionOrder: fn(),
        onSectionOrRoomDragStart: fn(),
        onSectionOrRoomDragEnd: fn(),
        moveCallParticipant: fn(),
    },
    parameters: {
        design: {
            type: "figma",
            url: "https://www.figma.com/design/vlmt46QDdE4dgXDiyBJXqp/ER-33-Left-Panel-2025?node-id=98-1979&t=vafb4zoYMNLRuAbh-4",
        },
    },
    decorators: [
        (Story) => (
            <div style={{ width: "300px" }}>
                <Story />
            </div>
        ),
    ],
} satisfies Meta<typeof RoomListWrapper>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Sections: Story = {
    args: {
        isFlatList: false,
    },
};

const voiceChannelIds = ["!geral1:server", "!geral2:server", "!afk:server"];

/** A server's voice channels, with Bob and Carol in the first one's call. */
function voiceChannelViewModels(canMoveCallParticipants: boolean): (roomId: string) => RoomListItemViewModel {
    const names = ["Geral#1", "Geral#2", "AFK"];
    const viewModels = new Map(
        voiceChannelIds.map((roomId, index) => {
            const vm = createMockRoomItemViewModel(roomId, names[index], index);
            const snapshot: RoomListItemViewSnapshot = {
                ...vm.getSnapshot(),
                channelKind: "voice",
                messagePreview: undefined,
                canChangeSection: false,
                canMoveCallParticipants,
                callParticipants:
                    index === 0
                        ? [
                              { userId: "@bob:server", name: "Bob" },
                              { userId: "@carol:server", name: "Carol", isMuted: true },
                          ]
                        : undefined,
            };
            return [roomId, { ...vm, getSnapshot: () => snapshot }];
        }),
    );
    return (roomId) => viewModels.get(roomId)!;
}

/** A moderator's view of the voice channels: the people in a call can be dragged to another channel. */
export const VoiceChannels: Story = {
    args: {
        isFlatList: false,
        sections: [{ id: "voice", roomIds: voiceChannelIds }],
        getRoomItemViewModel: voiceChannelViewModels(true),
        getSectionHeaderViewModel: createGetSectionHeaderViewModel(["voice"]),
    },
};

/** The same channels for someone without the power to move people: nobody can be dragged. */
export const VoiceChannelsWithoutPower: Story = {
    args: {
        ...VoiceChannels.args,
        getRoomItemViewModel: voiceChannelViewModels(false),
    },
};
