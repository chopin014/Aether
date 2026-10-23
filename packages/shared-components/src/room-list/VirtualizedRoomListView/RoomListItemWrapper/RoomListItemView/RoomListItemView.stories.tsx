/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import React, { type JSX, useEffect } from "react";
import { fn } from "storybook/test";

import type { Meta, StoryObj } from "@storybook/react-vite";
import {
    type Room,
    RoomListItemView,
    type RoomListItemViewSnapshot,
    type RoomListItemViewActions,
} from "./RoomListItemView";
import { useMockedViewModel } from "../../../../core/viewmodel";
import { withViewDocs } from "../../../../../.storybook/withViewDocs";
import { defaultSnapshot } from "./default-snapshot";
import { renderAvatar } from "../../../story-mocks";
import { mockedActions } from "./mocked-actions";

type RoomListItemProps = RoomListItemViewSnapshot &
    RoomListItemViewActions & {
        isSelected: boolean;
        isFocused: boolean;
        onFocus: (room: Room, e: React.FocusEvent) => void;
        isFirstItem: boolean;
        isLastItem: boolean;
        renderAvatar: (room: Room) => React.ReactElement;
    };

// Wrapper component that creates a mocked ViewModel
const RoomListItemWrapperImpl = ({
    onViewCallParticipant,
    onOpenRoom,
    onMarkAsRead,
    onMarkAsUnread,
    onToggleFavorite,
    onToggleLowPriority,
    onInvite,
    onCopyRoomLink,
    onLeaveRoom,
    onSetRoomNotifState,
    onCreateSection,
    onToggleSection,
    onRemoveFromSection,
    isSelected,
    isFocused,
    onFocus,
    isFirstItem,
    isLastItem,
    renderAvatar: renderAvatarProp,
    ...rest
}: RoomListItemProps): JSX.Element => {
    const vm = useMockedViewModel(rest, {
        onViewCallParticipant,
        onOpenRoom,
        onMarkAsRead,
        onMarkAsUnread,
        onToggleFavorite,
        onToggleLowPriority,
        onInvite,
        onCopyRoomLink,
        onLeaveRoom,
        onSetRoomNotifState,
        onCreateSection,
        onToggleSection,
        onRemoveFromSection,
    });
    return (
        <RoomListItemView
            vm={vm}
            isSelected={isSelected}
            isFocused={isFocused}
            onFocus={onFocus}
            isFirstItem={isFirstItem}
            isLastItem={isLastItem}
            renderAvatar={renderAvatarProp}
            role="option"
        />
    );
};
const RoomListItemWrapper = withViewDocs(RoomListItemWrapperImpl, RoomListItemView);

const meta = {
    title: "Room List/RoomListItemView",
    component: RoomListItemWrapper,
    tags: ["autodocs"],
    decorators: [
        (Story) => (
            <div role="listbox" aria-label="Room list" style={{ width: "320px", padding: "8px" }}>
                <Story />
            </div>
        ),
    ],
    args: {
        ...defaultSnapshot,
        ...mockedActions,
        isSelected: false,
        isFocused: false,
        isFirstItem: false,
        isLastItem: false,
        onFocus: fn(),
        renderAvatar,
    },
    parameters: {
        design: {
            type: "figma",
            url: "https://www.figma.com/design/rTaQE2nIUSLav4Tg3nozq7/Compound-Web-Components?node-id=10800-21153&t=gFDc2D7TMEffSSCo-0",
        },
    },
} satisfies Meta<typeof RoomListItemWrapper>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const LongContent: Story = {
    args: {
        name: "Loooooooooooooooooooooooooooooooooooooong name",
        messagePreview: "Loooooooooooooooooooooooooooooooooooooong preview",
    },
};

export const Selected: Story = {
    args: {
        isSelected: true,
    },
};

export const Bold: Story = {
    args: {
        isBold: true,
        name: "Team Updates",
    },
};

export const WithNotification: Story = {
    args: {
        isBold: true,
        notification: {
            hasAnyNotificationOrActivity: true,
            isUnsentMessage: false,
            invited: false,
            isMention: false,
            isActivityNotification: false,
            isNotification: true,
            hasUnreadCount: true,
            count: 3,
            muted: false,
        },
    },
};

export const WithMention: Story = {
    args: {
        isBold: true,
        notification: {
            hasAnyNotificationOrActivity: true,
            isUnsentMessage: false,
            invited: false,
            isMention: true,
            isActivityNotification: false,
            isNotification: true,
            hasUnreadCount: true,
            count: 1,
            muted: false,
        },
    },
};

export const WithVoiceCall: Story = {
    args: {
        isBold: true,
        notification: {
            hasAnyNotificationOrActivity: true,
            isUnsentMessage: false,
            invited: false,
            isMention: false,
            isActivityNotification: false,
            isNotification: false,
            hasUnreadCount: false,
            count: 0,
            muted: false,
            callType: "voice",
        },
    },
};

export const WithVideoCall: Story = {
    args: {
        isBold: true,
        notification: {
            hasAnyNotificationOrActivity: true,
            isUnsentMessage: false,
            invited: false,
            isMention: false,
            isActivityNotification: false,
            isNotification: false,
            hasUnreadCount: false,
            count: 0,
            muted: false,
            callType: "video",
        },
    },
};

export const Invitation: Story = {
    args: {
        name: "Secret Project",
        messagePreview: "Bob invited you",
        notification: {
            hasAnyNotificationOrActivity: true,
            isUnsentMessage: false,
            invited: true,
            isMention: false,
            isActivityNotification: false,
            isNotification: false,
            hasUnreadCount: false,
            count: 0,
            muted: false,
        },
    },
};

export const UnsentMessage: Story = {
    args: {
        messagePreview: "Failed to send message",
        notification: {
            hasAnyNotificationOrActivity: true,
            isUnsentMessage: true,
            invited: false,
            isMention: false,
            isActivityNotification: false,
            isNotification: false,
            hasUnreadCount: false,
            count: 0,
            muted: false,
        },
    },
};

export const NoMessagePreview: Story = {
    args: {
        messagePreview: undefined,
    },
};

export const WithHoverMenu: Story = {
    args: {
        showMoreOptionsMenu: true,
    },
};

export const WithoutHoverMenu: Story = {
    args: {
        showMoreOptionsMenu: false,
    },
};

export const WithLargeFont: Story = {
    args: {
        isSelected: true,
    },
    // Render the story in an iframe to avoid affecting other story
    parameters: {
        docs: {
            story: {
                inline: false,
                iframeHeight: 170,
            },
        },
    },
    decorators: [
        (Story) => {
            useEffect(() => {
                const originalFontSize = getComputedStyle(document.documentElement).fontSize;
                document.documentElement.style.setProperty("font-size", "36px");
                return () => {
                    document.documentElement.style.setProperty("font-size", originalFontSize);
                };
            }, []);
            return <Story />;
        },
    ],
};

export const WithZoom: Story = {
    args: {
        isSelected: true,
    },
    decorators: [
        (Story, context) => (
            <div style={{ zoom: 2 }}>
                <Story />
            </div>
        ),
    ],
};

export const FirstItem: Story = {
    args: {
        isFirstItem: true,
        isSelected: true,
    },
};

export const LastItem: Story = {
    args: {
        isLastItem: true,
        isSelected: true,
    },
};

export const SectionDisabled: Story = {
    args: {
        areSectionsEnabled: false,
    },
};

export const WithUserStatus: Story = {
    args: {
        userStatus: {
            emoji: "🌭",
            text: "Hot",
        },
    },
};

/** Live participants are indented directly beneath their voice channel. */
export const DesktopVoiceParticipants: Story = {
    args: {
        channelKind: "voice",
        callParticipants: [
            { userId: "@alice:example.org", name: "Alice" },
            { userId: "@bob:example.org", name: "Bob" },
        ],
        onViewCallParticipant: fn(),
    },
};

/** An occupied voice channel gets a filled icon and shows how long people have been in it. */
export const DesktopVoiceChannelOccupied: Story = {
    args: {
        channelKind: "voice",
        callParticipants: [
            { userId: "@alice:example.org", name: "Alice" },
            { userId: "@bob:example.org", name: "Bob" },
        ],
        callStartedAt: Date.now() - (12 * 60 + 34) * 1000,
        notification: { ...defaultSnapshot.notification, hasAnyNotificationOrActivity: true, callType: "voice" },
        onViewCallParticipant: fn(),
    },
};

/** A channel with a room avatar shows it as its custom icon. */
export const DesktopChannelWithIcon: Story = {
    args: {
        channelKind: "text",
        channelIconUrl:
            "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20'><rect width='20' height='20' fill='%238ed8ea'/></svg>",
    },
};

/** A participant who is talking gets an activity ring and soft pulse around their avatar. */
export const DesktopVoiceParticipantSpeaking: Story = {
    args: {
        channelKind: "voice",
        callParticipants: [
            { userId: "@alice:example.org", name: "Alice", isSpeaking: true },
            { userId: "@bob:example.org", name: "Bob" },
        ],
        onViewCallParticipant: fn(),
    },
};

/** Nobody in the call is talking, so no avatar has a ring. */
export const DesktopVoiceParticipantsSilent: Story = {
    args: {
        channelKind: "voice",
        callParticipants: [
            { userId: "@alice:example.org", name: "Alice", isSpeaking: false },
            { userId: "@bob:example.org", name: "Bob", isSpeaking: false },
        ],
        onViewCallParticipant: fn(),
    },
};

/** Muted and deafened icons appear together when both statuses are active. */
export const DesktopVoiceParticipantsMutedAndDeafened: Story = {
    args: {
        channelKind: "voice",
        callParticipants: [
            { userId: "@alice:example.org", name: "Alice", isSpeaking: true },
            { userId: "@bob:example.org", name: "Bob", isMuted: true },
            { userId: "@charlie:example.org", name: "Charlie", isMuted: true, isDeafened: true },
        ],
        onViewCallParticipant: fn(),
    },
};

/** Several participants talking over each other each show their own ring. */
export const DesktopVoiceParticipantsMultipleSpeaking: Story = {
    args: {
        channelKind: "voice",
        callParticipants: [
            { userId: "@alice:example.org", name: "Alice", isSpeaking: true },
            { userId: "@bob:example.org", name: "Bob" },
            { userId: "@charlie:example.org", name: "Charlie", isSpeaking: true },
        ],
        onViewCallParticipant: fn(),
    },
};
