/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import React, { type JSX, memo, type ReactNode } from "react";
import { Text, Tooltip } from "@vector-im/compound-web";
import classNames from "classnames";
import { VolumeOnIcon, VolumeOnSolidIcon } from "@vector-im/compound-design-tokens/assets/web/icons";

import { Flex } from "../../../../core/utils/Flex";
import { useViewModel } from "../../../../core/viewmodel";
import { TextChannelIcon } from "../../../../desktop/TextChannelIcon";
import { NotificationDecoration } from "./NotificationDecoration";
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
    // An occupied voice channel stands out from empty ones, and shows how long it has been occupied.
    const occupied = item.channelKind === "voice" && !!item.callParticipants?.length;

    return (
        <Flex
            className={classNames(styles.container, {
                [styles.dragging]: isDragging,
                [styles.channel]: !!item.channelKind,
            })}
            gap="var(--cpd-space-3x)"
            align="center"
        >
            {item.channelKind ? (
                // The kind symbol stays when the channel has a custom icon, because any image can be used for
                // either kind and would not say whether clicking joins a call.
                <span className={styles.channelSymbols}>
                    {occupied ? (
                        <VolumeOnSolidIcon
                            className={classNames(styles.channelIcon, styles.occupied)}
                            data-testid="channel-kind-voice"
                            aria-hidden
                        />
                    ) : item.channelKind === "voice" ? (
                        <VolumeOnIcon className={styles.channelIcon} data-testid="channel-kind-voice" aria-hidden />
                    ) : (
                        <TextChannelIcon className={styles.channelIcon} data-testid="channel-kind-text" aria-hidden />
                    )}
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

                    {item.messagePreview && !item.channelKind && (
                        <Text as="div" size="sm" className={styles.ellipsis} title={item.messagePreview}>
                            {item.messagePreview}
                        </Text>
                    )}
                </div>
                {!isDragging && (item.showMoreOptionsMenu || item.showNotificationMenu) && (
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
                    {/* The occupied channel's own icon already says there is a call in it. */}
                    <NotificationDecoration
                        {...item.notification}
                        callType={occupied ? undefined : item.notification.callType}
                    />
                </div>
            </Flex>
        </Flex>
    );
});
