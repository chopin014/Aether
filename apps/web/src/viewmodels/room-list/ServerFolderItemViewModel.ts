/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    BaseViewModel,
    RoomNotifState,
    type RoomListItemViewActions,
    type RoomListItemViewSnapshot,
} from "@element-hq/web-shared-components";
import { NotificationCountType, type Room } from "matrix-js-sdk/src/matrix";
import { throttle } from "lodash";

import { mediaFromMxc } from "../../customisations/Media";
import { getUnreadNotificationCount } from "../../RoomNotifs";
import { RoomNotificationStateStore } from "../../stores/notifications/RoomNotificationStateStore";
import { NotificationStateEvents } from "../../stores/notifications/NotificationState";
import { type RoomNotificationState } from "../../stores/notifications/RoomNotificationState";
import { PreviewRoomAvatarData } from "./PreviewRoomAvatarData";

/** A server nested in the open one, as its folder shows it. */
export interface ServerFolder {
    /** The nested server's room id. */
    roomId: string;
    name: string;
    /** The mxc:// URL of the server's avatar. */
    avatarUrl?: string;
}

export interface ServerFolderItemProps {
    folder: ServerFolder;
    /** Whether the server's channels show beneath the folder. */
    expanded: boolean;
    /** Whether the server's channels can show beneath the folder, rather than only in the server itself. */
    canExpand: boolean;
    /** Whether the person may move the folder in the open server's layout. */
    canMove: boolean;
    /** Show or hide the server's channels beneath the folder. */
    onToggle: () => void;
    /** Open the server itself. */
    onOpen: () => void;
}

/**
 * View model for a server nested in the open one, shown as a folder of its channels. The folder reads like a channel:
 * bold with a marker when one of the channels inside has something new, with a count of the mentions inside. Clicking
 * it shows or hides the channels; its button opens the server itself.
 */
export class ServerFolderItemViewModel
    extends BaseViewModel<RoomListItemViewSnapshot, ServerFolderItemProps>
    implements RoomListItemViewActions
{
    private states = new Set<RoomNotificationState>();

    public constructor(props: ServerFolderItemProps) {
        super(props, ServerFolderItemViewModel.generateSnapshot(props));
    }

    /** The nested server's room id. */
    public get roomId(): string {
        return this.props.folder.roomId;
    }

    private static generateSnapshot({
        folder,
        expanded,
        canExpand,
        canMove,
    }: ServerFolderItemProps): RoomListItemViewSnapshot {
        return {
            id: folder.roomId,
            room: new PreviewRoomAvatarData(folder.roomId, folder.name, folder.avatarUrl),
            name: folder.name,
            isBold: false,
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
            folder: {
                expanded: canExpand && expanded,
                canExpand,
                avatarUrl: folder.avatarUrl
                    ? (mediaFromMxc(folder.avatarUrl).getThumbnailOfSourceHttp(24, 24, "crop") ?? undefined)
                    : undefined,
            },
            showMoreOptionsMenu: false,
            showNotificationMenu: false,
            isFavourite: false,
            isLowPriority: false,
            isDm: false,
            canInvite: false,
            canCopyRoomLink: false,
            canMarkAsRead: false,
            canMarkAsUnread: false,
            roomNotifState: RoomNotifState.AllMessages,
            sections: [],
            areSectionsEnabled: false,
            canChangeSection: canMove,
        };
    }

    /** Follow the folder's state as the room list works it out again. */
    public update(props: Pick<ServerFolderItemProps, "folder" | "expanded" | "canExpand" | "canMove">): void {
        Object.assign(this.props, props);
        const { folder, isBold, notification, mentionCount } = this.snapshot.current;
        const next = ServerFolderItemViewModel.generateSnapshot(this.props);
        this.snapshot.merge({
            name: next.name,
            room: next.room,
            canChangeSection: next.canChangeSection,
            folder: sameFolder(folder, next.folder) ? folder : next.folder,
            isBold,
            notification,
            mentionCount,
        });
    }

    /**
     * The rooms the user is in inside the folder, at any depth, whose news the folder shows. Only subscribes to rooms
     * it was not following already.
     */
    public setRooms(rooms: Room[]): void {
        const next = new Set(rooms.map((room) => RoomNotificationStateStore.instance.getRoomState(room)));
        for (const state of this.states) {
            if (!next.has(state)) state.off(NotificationStateEvents.Update, this.updateNotifications);
        }
        for (const state of next) {
            if (!this.states.has(state)) state.on(NotificationStateEvents.Update, this.updateNotifications);
        }
        this.states = next;
        this.updateNotifications();
    }

    /**
     * Throttled because a folder can hold many rooms, each updating once per incoming event while the client catches
     * up.
     */
    private updateNotifications = throttle(
        (): void => {
            let isBold = false;
            let mentions = 0;
            for (const state of this.states) {
                // A muted channel's news doesn't count, as it doesn't for a channel row; its mentions still do, counted
                // as each channel's badge counts them.
                if (state.isMention && state.room) {
                    mentions += Math.max(
                        1,
                        getUnreadNotificationCount(state.room, NotificationCountType.Highlight, true),
                    );
                }
                if (state.hasAnyNotificationOrActivity && !state.muted) isBold = true;
            }
            this.snapshot.merge({
                isBold: isBold || mentions > 0,
                mentionCount: mentions > 0 ? mentions : undefined,
                notification: { ...this.snapshot.current.notification, isMention: mentions > 0 },
            });
        },
        200,
        { leading: true, trailing: true },
    );

    public onOpenRoom = (): void => {
        if (this.props.canExpand) this.props.onToggle();
        else this.props.onOpen();
    };

    public onOpenFolder = (): void => this.props.onOpen();

    public dispose(): void {
        this.updateNotifications.cancel();
        for (const state of this.states) state.off(NotificationStateEvents.Update, this.updateNotifications);
        this.states.clear();
        super.dispose();
    }

    // A folder has no menus of its own.
    public onMarkAsRead = (): void => {};
    public onMarkAsUnread = (): void => {};
    public onToggleFavorite = (): void => {};
    public onToggleLowPriority = (): void => {};
    public onInvite = (): void => {};
    public onCopyRoomLink = (): void => {};
    public onLeaveRoom = (): void => {};
    public onSetRoomNotifState = (): void => {};
    public onCreateSection = (): void => {};
    public onToggleSection = (): void => {};
    public onRemoveFromSection = (): void => {};
}

function sameFolder(a: RoomListItemViewSnapshot["folder"], b: RoomListItemViewSnapshot["folder"]): boolean {
    return a?.expanded === b?.expanded && a?.canExpand === b?.canExpand && a?.avatarUrl === b?.avatarUrl;
}
