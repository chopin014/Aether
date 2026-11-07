/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import React, { type JSX, memo, type ReactNode } from "react";
import { Text, Tooltip } from "@vector-im/compound-web";
import classNames from "classnames";
import { LockSolidIcon, VolumeOnIcon, VolumeOnSolidIcon } from "@vector-im/compound-design-tokens/assets/web/icons";

import { Flex } from "../../../../core/utils/Flex";
import { useViewModel } from "../../../../core/viewmodel";
import { TextChannelIcon } from "../../../../desktop/TextChannelIcon";
import { NotificationDecoration, type NotificationDecorationData } from "./NotificationDecoration";
import { ChannelRowActions } from "./ChannelRowActions";
import { RoomListItemHoverMenu } from "./RoomListItemHoverMenu";
import { type Room, type RoomListItemViewModel } from "./RoomListItemView";
import styles from "./RoomListItemView.module.css";
import { VoiceChannelDuration } from "./VoiceChannelDuration";

/**
 * Props for {@link RoomListItemContent}.
 */
export interface RoomListItemContentProps {
    /** The room item view model */
    vm: RoomListItemViewModel;
    /** Function to render the room avatar */
    renderAvatar: (room: Room) => ReactNode;
    /** Whether the item is being dragged */
    isDragging?: boolean;
}

/**
 * The inner content of a room list item: avatar, room name, message preview,
 * hover menu and notification decoration. Used both inside the full
 * {@link RoomListItemView} and inside the drag overlay.
 */
export const RoomListItemContent = memo(function RoomListItemContent({
    vm,
    renderAvatar,
    isDragging = false,
}: RoomListItemContentProps): JSX.Element {
    const item = useViewModel(vm);
    const isChannel = !!item.channelKind;
    // An occupied voice channel stands out from empty ones, and shows how long it has been occupied.
    const occupied = item.channelKind === "voice" && !!item.callParticipants?.length;
    // A channel shows what Discord shows: a mention count, an unsent message or a call. Plain unread activity is
    // the bold name and the marker at the row's edge, and a muted text channel is dimmed rather than marked with a
    // bell. Voice channels aren't dimmed: their notifications are about messages nobody sends there, so being muted
    // says nothing about the call.
    const notification = isChannel ? channelNotification(item.notification, occupied) : item.notification;
    const mentionCount = isChannel && item.notification.isMention ? (item.mentionCount ?? 1) : 0;
    const showsDuration = occupied && item.callStartedAt !== undefined;
    const hasDecoration = mentionCount > 0 || notification.isUnsentMessage || !!notification.callType || showsDuration;

    return (
        <Flex
            className={classNames(styles.container, {
                [styles.dragging]: isDragging,
                [styles.channel]: isChannel,
                [styles.mutedChannel]: item.channelKind === "text" && item.notification.muted,
            })}
            gap="var(--cpd-space-3x)"
            align="center"
        >
            {isChannel && item.isBold && <span className={styles.unreadMarker} data-testid="channel-unread" />}
            {item.channelKind ? (
                // The kind symbol stays when the channel has a custom icon, because any image can be used for
                // either kind and would not say whether clicking joins a call.
                <span className={styles.channelSymbols}>
                    <span
                        className={classNames(styles.channelSymbol, { [styles.privateChannel]: item.isPrivateChannel })}
                    >
                        {occupied ? (
                            <VolumeOnSolidIcon
                                className={classNames(styles.channelIcon, styles.occupied)}
                                data-testid="channel-kind-voice"
                                aria-hidden
                            />
                        ) : item.channelKind === "voice" ? (
                            <VolumeOnIcon className={styles.channelIcon} data-testid="channel-kind-voice" aria-hidden />
                        ) : (
                            <TextChannelIcon
                                className={styles.channelIcon}
                                data-testid="channel-kind-text"
                                aria-hidden
                            />
                        )}
                        {item.isPrivateChannel && (
                            <LockSolidIcon className={styles.channelLock} data-testid="channel-private" aria-hidden />
                        )}
                    </span>
                    {item.channelIconUrl && <img className={styles.channelImage} src={item.channelIconUrl} alt="" />}
                </span>
            ) : (
                renderAvatar(item.room)
            )}
            <Flex className={styles.content} gap="var(--cpd-space-2x)" align="center" justify="space-between">
                {/* We truncate the room name when too long. Title here is to show the full name on hover */}
                <div className={styles.ellipsis}>
                    <div className={styles.roomName} title={item.name} data-testid="room-name">
                        {item.name}
                        {item.userStatus && (
                            <Tooltip description={item.userStatus.text} maxWidth="30ch" maxLines={1}>
                                <Text as="span" className={styles.userStatusEmoji}>
                                    {item.userStatus.emoji}
                                </Text>
                            </Tooltip>
                        )}
                    </div>

                    {item.messagePreview && !isChannel && (
                        <Text as="div" size="sm" className={styles.ellipsis} title={item.messagePreview}>
                            {item.messagePreview}
                        </Text>
                    )}
                </div>
                {!isDragging && isChannel && <ChannelRowActions vm={vm} hasDecoration={hasDecoration} />}
                {!isDragging && !isChannel && (item.showMoreOptionsMenu || item.showNotificationMenu) && (
                    <RoomListItemHoverMenu
                        showMoreOptionsMenu={item.showMoreOptionsMenu}
                        showNotificationMenu={item.showNotificationMenu}
                        vm={vm}
                    />
                )}

                {/* aria-hidden because we summarise the unread count/notification status in a11yLabel */}
                <div className={styles.notificationDecoration} aria-hidden={true}>
                    {occupied && item.callStartedAt !== undefined && (
                        <VoiceChannelDuration since={item.callStartedAt} />
                    )}
                    <NotificationDecoration {...notification} />
                    {mentionCount > 0 && (
                        <span className={styles.mentionBadge} data-testid="channel-mentions">
                            {mentionCount > 99 ? "99+" : mentionCount}
                        </span>
                    )}
                </div>
            </Flex>
        </Flex>
    );
});

/**
 * The part of a room's notification state a desktop channel row draws as icons: an unsent message, and a call that
 * an occupied voice channel does not already show. Mentions get the channel's own count badge instead.
 */
function channelNotification(notification: NotificationDecorationData, occupied: boolean): NotificationDecorationData {
    const callType = occupied ? undefined : notification.callType;
    return {
        ...notification,
        hasAnyNotificationOrActivity: notification.isUnsentMessage || !!callType,
        invited: false,
        isMention: false,
        isNotification: false,
        isActivityNotification: false,
        hasUnreadCount: false,
        muted: false,
        callType,
    };
}
