/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    BaseViewModel,
    type UnreadConversation,
    type UnreadConversationsViewActions,
    type UnreadConversationsViewSnapshot,
} from "@element-hq/web-shared-components";
import {
    ClientEvent,
    KnownMembership,
    type MatrixClient,
    NotificationCountType,
    type Room,
    RoomEvent,
    RoomStateEvent,
} from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";

import { avatarUrlForRoom } from "../../Avatar";
import defaultDispatcher from "../../dispatcher/dispatcher";
import { Action } from "../../dispatcher/actions";
import { type ViewRoomPayload } from "../../dispatcher/payloads/ViewRoomPayload";
import { NotificationStateEvents } from "../../stores/notifications/NotificationState";
import { type RoomNotificationState } from "../../stores/notifications/RoomNotificationState";
import { RoomNotificationStateStore } from "../../stores/notifications/RoomNotificationStateStore";
import { getRoomNotifsState, getUnreadNotificationCount, RoomNotifState } from "../../RoomNotifs";
import { TimedMutes, TimedMutesEvent } from "../../stores/notifications/TimedMutes";
import { MetaSpace } from "../../stores/spaces";
import type SpaceStore from "../../stores/spaces/SpaceStore";
import DMRoomMap from "../../utils/DMRoomMap";
import { clearRoomNotification } from "../../utils/notifications";
import { keepIfSame } from "../../utils/keepIfSame";

/**
 * The most people a group conversation may have and still show every unread message on the rail: Discord's limit
 * for a group direct message. A larger room outside any server, such as a public community, shows only when it
 * mentions the person, so the rail stays about the people writing to them.
 */
export const SMALL_GROUP_SIZE = 10;

/** How long to wait for a burst of changes, such as one sync, to settle before working the list out again. */
const SETTLE_MS = 50;

interface Props {
    client: MatrixClient;
    spaceStore: SpaceStore;
}

/**
 * The direct messages and group conversations outside any server that are waiting to be read, for the server rail
 * under Home, newest first, as Discord shows them. A muted conversation is left out, as is a room whose unread
 * messages don't notify the person, and an invitation, which Home counts instead.
 */
export class UnreadConversationsViewModel
    extends BaseViewModel<UnreadConversationsViewSnapshot, Props>
    implements UnreadConversationsViewActions
{
    private settleTimer?: ReturnType<typeof setTimeout>;
    /** The notification state of each conversation in Home, which this listens to for its unread changes. */
    private readonly watched = new Map<RoomNotificationState, () => void>();

    public constructor(props: Props) {
        const { conversations, homeRooms } = UnreadConversationsViewModel.compute(props.client, props.spaceStore);
        super(props, { conversations });
        this.watch(homeRooms);

        const { client, spaceStore } = props;
        // Which rooms Home holds.
        this.disposables.trackListener(spaceStore, MetaSpace.Home, this.schedule);
        // Each conversation's unread messages, including those decryption turns into mentions.
        this.disposables.track(() => this.watch([]));
        // A room's name, picture, members and newest message, which order and draw the rail.
        this.disposables.trackListener(client, RoomEvent.Timeline, this.schedule);
        this.disposables.trackListener(client, RoomEvent.Name, this.schedule);
        this.disposables.trackListener(client, RoomEvent.MyMembership, this.schedule);
        this.disposables.trackListener(client, RoomStateEvent.Members, this.schedule);
        this.disposables.trackListener(client, ClientEvent.Room, this.schedule);
        this.disposables.trackListener(client, ClientEvent.DeleteRoom, this.schedule);
        // Muting and push rules change whether a room notifies.
        this.disposables.trackListener(client, ClientEvent.AccountData, this.schedule);
        this.disposables.trackListener(TimedMutes.instance, TimedMutesEvent.Changed, this.schedule);
        this.disposables.track(() => clearTimeout(this.settleTimer));
    }

    /**
     * Whether a conversation in Home belongs on the rail, and with what. The count is of messages others sent that
     * notify the person, as Element counts them: a message of the person's own that failed to send neither puts a
     * conversation on the rail nor hides how many messages wait in it.
     */
    private static entry(room: Room): UnreadConversation | undefined {
        // Invitations are counted on Home itself, as Discord counts friend requests.
        if (room.getMyMembership() !== KnownMembership.Join) return undefined;
        if (getRoomNotifsState(room.client, room.roomId) === RoomNotifState.Mute) return undefined;
        const mentions = getUnreadNotificationCount(room, NotificationCountType.Highlight, false);
        const count = getUnreadNotificationCount(room, NotificationCountType.Total, false) || mentions;
        if (count <= 0) return undefined;
        const isDirect = !!DMRoomMap.shared()?.getUserIdForRoomId(room.roomId);
        if (!isDirect && mentions === 0 && room.getJoinedMemberCount() > SMALL_GROUP_SIZE) return undefined;
        return {
            id: room.roomId,
            name: room.name,
            avatarUrl: avatarUrlForRoom(room, 96, 96, "crop") ?? undefined,
            count,
        };
    }

    private static compute(
        client: MatrixClient,
        spaceStore: SpaceStore,
    ): { conversations: UnreadConversation[]; homeRooms: Room[] } {
        const found: { entry: UnreadConversation; at: number }[] = [];
        const homeRooms: Room[] = [];
        for (const room of client.getVisibleRooms()) {
            if (room.isSpaceRoom() || !spaceStore.isRoomInSpace(MetaSpace.Home, room.roomId)) continue;
            homeRooms.push(room);
            const entry = UnreadConversationsViewModel.entry(room);
            if (entry) found.push({ entry, at: room.getLastActiveTimestamp() });
        }
        return { conversations: found.sort((a, b) => b.at - a.at).map(({ entry }) => entry), homeRooms };
    }

    /** Listen to the notification state of exactly these rooms. */
    private watch(rooms: Room[]): void {
        const states = new Set(rooms.map((room) => RoomNotificationStateStore.instance.getRoomState(room)));
        for (const [state, stop] of this.watched) {
            if (states.has(state)) continue;
            stop();
            this.watched.delete(state);
        }
        for (const state of states) {
            if (this.watched.has(state)) continue;
            state.on(NotificationStateEvents.Update, this.schedule);
            this.watched.set(state, () => state.off(NotificationStateEvents.Update, this.schedule));
        }
    }

    private readonly schedule = (): void => {
        if (this.settleTimer !== undefined) return;
        this.settleTimer = setTimeout(this.refresh, SETTLE_MS);
    };

    private readonly refresh = (): void => {
        this.settleTimer = undefined;
        if (this.isDisposed) return;
        const { conversations, homeRooms } = UnreadConversationsViewModel.compute(
            this.props.client,
            this.props.spaceStore,
        );
        this.watch(homeRooms);
        this.snapshot.merge({ conversations: keepIfSame(this.snapshot.current.conversations, conversations) });
    };

    public openConversation = (id: string): void => {
        // The conversation lives in Home, so Home opens with it, wherever the person was.
        this.props.spaceStore.setActiveSpace(MetaSpace.Home, false);
        defaultDispatcher.dispatch<ViewRoomPayload>({
            action: Action.ViewRoom,
            room_id: id,
            metricsTrigger: undefined,
        });
    };

    public markAsRead = (id: string): void => {
        const room = this.props.client.getRoom(id);
        if (!room) return;
        clearRoomNotification(room, this.props.client).catch((error) =>
            logger.warn("Failed to mark a conversation as read", error),
        );
    };

    public mute = (id: string, duration: number | null): void => {
        const room = this.props.client.getRoom(id);
        if (!room) return;
        TimedMutes.instance
            .mute([room], duration)
            .catch((error) => logger.warn("Failed to mute a conversation", error));
    };
}
