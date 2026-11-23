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
import { logger } from "matrix-js-sdk/src/logger";
import { KnownMembership, type MatrixClient } from "matrix-js-sdk/src/matrix";

import dispatcher from "../../dispatcher/dispatcher";
import { Action } from "../../dispatcher/actions";
import type { ViewRoomPayload } from "../../dispatcher/payloads/ViewRoomPayload";
import { mediaFromMxc } from "../../customisations/Media";
import { SDKContextClass } from "../../contexts/SDKContextClass";
import { type ServerChannel } from "../../utils/servers/serverChannels";
import { waitForRoom } from "../../utils/room/waitForRoom";
import { PreviewRoomAvatarData } from "./PreviewRoomAvatarData";

export interface UnjoinedChannelItemProps {
    client: MatrixClient;
    /** The channel, as its server lists it. */
    channel: ServerChannel;
    /**
     * The server the channel is in, when the user is not in that server either: a channel open to a server's members
     * can only be joined once the user is in the server.
     */
    serverToJoin?: { roomId: string; via: string[] };
}

/** How long to wait for a joined voice channel to arrive before giving up on joining its call. */
const JOINED_ROOM_TIMEOUT_MS = 10_000;

/**
 * View model for a channel of the open server that the user is not in. It looks like any other channel, as on
 * Discord, where every channel of a server is listed; opening it joins it. The menus are hidden until then.
 */
export class UnjoinedChannelItemViewModel
    extends BaseViewModel<RoomListItemViewSnapshot, UnjoinedChannelItemProps>
    implements RoomListItemViewActions
{
    private joining = false;

    public constructor(props: UnjoinedChannelItemProps) {
        super(props, UnjoinedChannelItemViewModel.generateSnapshot(props.channel));
    }

    /** The id of the channel's room. */
    public get roomId(): string {
        return this.props.channel.roomId;
    }

    private static generateSnapshot(channel: ServerChannel): RoomListItemViewSnapshot {
        const { roomId, name, avatarUrl, roomType, kind } = channel;
        return {
            id: roomId,
            room: new PreviewRoomAvatarData(roomId, name, avatarUrl, roomType),
            name,
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
            showMoreOptionsMenu: false,
            showNotificationMenu: false,
            isFavourite: false,
            isLowPriority: false,
            isDm: false,
            channelKind: kind,
            channelIconUrl: avatarUrl
                ? (mediaFromMxc(avatarUrl).getThumbnailOfSourceHttp(40, 40, "crop") ?? undefined)
                : undefined,
            canInvite: false,
            canCopyRoomLink: false,
            canMarkAsRead: false,
            canMarkAsUnread: false,
            roomNotifState: RoomNotifState.AllMessages,
            sections: [],
            areSectionsEnabled: false,
            canChangeSection: false,
        };
    }

    public onOpenRoom = (): void => {
        void this.open();
    };

    private async open(): Promise<void> {
        if (this.joining) return;
        if (this.props.serverToJoin && !(await this.joinServer(this.props.serverToJoin))) return;
        if (this.props.channel.kind === "voice") {
            await this.joinVoiceChannel();
            return;
        }
        this.viewAndJoin();
    }

    /** Join the server the channel is in, unless the user is in it already. Says whether the user is in it now. */
    private async joinServer(server: { roomId: string; via: string[] }): Promise<boolean> {
        const { client } = this.props;
        if (client.getRoom(server.roomId)?.getMyMembership() === KnownMembership.Join) return true;
        this.joining = true;
        try {
            await client.joinRoom(server.roomId, { viaServers: server.via });
            return true;
        } catch (error) {
            // The channel may still be open to people outside the server, so try it anyway.
            logger.warn(`Could not join the server ${server.roomId} before its channel`, error);
            return true;
        } finally {
            this.joining = false;
        }
    }

    /** Open the channel and join it there, which shows the join in progress and any error. */
    private viewAndJoin(): void {
        const { roomId, via } = this.props.channel;
        dispatcher.dispatch<ViewRoomPayload>({
            action: Action.ViewRoom,
            room_id: roomId,
            auto_join: true,
            via_servers: via,
            metricsTrigger: "RoomList",
        });
    }

    /**
     * Join a voice channel, then its call where the user is, as a click on a voice channel they are in does. If the
     * join fails, the channel opens to say why.
     */
    private async joinVoiceChannel(): Promise<void> {
        this.joining = true;
        const { client, channel } = this.props;
        try {
            await client.joinRoom(channel.roomId, { viaServers: channel.via });
        } catch (error) {
            logger.warn(`Could not join the voice channel ${channel.roomId}`, error);
            this.joining = false;
            this.viewAndJoin();
            return;
        }
        const room = await waitForRoom(
            client,
            channel.roomId,
            (candidate) => candidate.getMyMembership() === KnownMembership.Join,
            JOINED_ROOM_TIMEOUT_MS,
        );
        this.joining = false;
        if (!room) return;
        if (SDKContextClass.instance.roomViewStore.joinVoiceChannel(room)) return;
        dispatcher.dispatch<ViewRoomPayload>({
            action: Action.ViewRoom,
            room_id: room.roomId,
            metricsTrigger: "RoomList",
        });
    }

    // The menus calling these actions are hidden until the channel is joined.
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
