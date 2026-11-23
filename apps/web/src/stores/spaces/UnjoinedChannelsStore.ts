/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { logger } from "matrix-js-sdk/src/logger";
import {
    EventType,
    KnownMembership,
    type MatrixClient,
    type MatrixEvent,
    type Room,
    RoomEvent,
    RoomStateEvent,
    TypedEventEmitter,
} from "matrix-js-sdk/src/matrix";

import { listJoinableChannels, type ServerChannel } from "../../utils/servers/serverChannels";

export enum UnjoinedChannelsStoreEvent {
    /** The channels a server lists that the user is not in may have changed. Passes the server's room id. */
    Changed = "changed",
}

type EventHandlerMap = { [UnjoinedChannelsStoreEvent.Changed]: (spaceId: string) => void };

/** How long a server's list is trusted without a change to its channels. */
const FRESH_FOR_MS = 5 * 60_000;
/** Changes to a server's channels arriving together are looked up once. */
const REFRESH_DELAY_MS = 300;

interface Entry {
    channels: ServerChannel[];
    fetchedAt: number;
}

/**
 * The channels of each server that the user could join but has not, so the sidebar can list every channel of a
 * server as Discord does and join one when it is opened. Joining every channel up front isn't possible: homeservers
 * only let a user join a few rooms at a time.
 *
 * Lists come from the server's room hierarchy, fetched when its channel list is shown and again when its channels
 * change or the user leaves one of them.
 */
export class UnjoinedChannelsStore extends TypedEventEmitter<UnjoinedChannelsStoreEvent, EventHandlerMap> {
    private static internalInstance?: UnjoinedChannelsStore;

    public static get instance(): UnjoinedChannelsStore {
        UnjoinedChannelsStore.internalInstance ??= new UnjoinedChannelsStore();
        return UnjoinedChannelsStore.internalInstance;
    }

    private client?: MatrixClient;
    /** Changes with every client, so that a lookup still running for the previous one is dropped. */
    private generation = 0;
    private readonly entries = new Map<string, Entry>();
    private readonly fetching = new Map<string, Promise<void>>();
    private readonly refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

    /** Follow a client's changes to servers' channels. Safe to call again with the same client. */
    public watch(client: MatrixClient): void {
        if (this.client === client) return;
        this.generation++;
        this.client?.off(RoomStateEvent.Events, this.onStateEvent);
        this.client?.off(RoomEvent.MyMembership, this.onMyMembership);
        for (const timer of this.refreshTimers.values()) clearTimeout(timer);
        this.refreshTimers.clear();
        this.entries.clear();
        this.fetching.clear();
        this.client = client;
        client.on(RoomStateEvent.Events, this.onStateEvent);
        client.on(RoomEvent.MyMembership, this.onMyMembership);
    }

    /**
     * The channels of a server the user was not in when they were last looked up, in the server's order, less any
     * they were banned from since. Ones joined since are still there: the room list, which has them, leaves them out,
     * so that a channel being joined keeps its row. Looks the channels up in the background when they are missing or
     * old, and emits {@link UnjoinedChannelsStoreEvent.Changed} when they arrive.
     */
    public getChannels(spaceId: string): ServerChannel[] {
        const entry = this.entries.get(spaceId);
        if (!entry || Date.now() - entry.fetchedAt > FRESH_FOR_MS) void this.fetch(spaceId);
        if (!entry || !this.client) return [];
        const client = this.client;
        return entry.channels.filter((channel) => !isBannedFrom(client, channel.roomId));
    }

    private fetch(spaceId: string): Promise<void> {
        const running = this.fetching.get(spaceId);
        if (running) return running;
        const client = this.client;
        if (!client) return Promise.resolve();
        const generation = this.generation;
        const fetching = listJoinableChannels(client, spaceId)
            .then(
                (channels) => {
                    if (generation !== this.generation) return;
                    this.entries.set(spaceId, { channels, fetchedAt: Date.now() });
                    this.emit(UnjoinedChannelsStoreEvent.Changed, spaceId);
                },
                (error) => {
                    if (generation !== this.generation) return;
                    logger.warn(`Could not list the channels of ${spaceId}`, error);
                    // Keep what was known, and try again only after a while rather than on every render.
                    const known = this.entries.get(spaceId)?.channels ?? [];
                    this.entries.set(spaceId, { channels: known, fetchedAt: Date.now() });
                },
            )
            .finally(() => {
                if (this.fetching.get(spaceId) === fetching) this.fetching.delete(spaceId);
            });
        this.fetching.set(spaceId, fetching);
        return fetching;
    }

    /** Look a server's channels up again soon, if its list was ever shown. */
    private scheduleRefresh(spaceId: string): void {
        if (!this.entries.has(spaceId) || this.refreshTimers.has(spaceId)) return;
        const generation = this.generation;
        this.refreshTimers.set(
            spaceId,
            setTimeout(() => {
                this.refreshTimers.delete(spaceId);
                if (generation === this.generation) void this.fetch(spaceId);
            }, REFRESH_DELAY_MS),
        );
    }

    private readonly onStateEvent = (event: MatrixEvent): void => {
        if (event.getType() === EventType.SpaceChild) this.scheduleRefresh(event.getRoomId()!);
    };

    private readonly onMyMembership = (room: Room, membership: string, previous?: string): void => {
        // A channel joined drops out of its servers' lists at once. One left was never in them, as the hierarchy
        // leaves out joined rooms, so those servers are looked up again.
        for (const [spaceId, entry] of this.entries) {
            const listed = entry.channels.some((channel) => channel.roomId === room.roomId);
            if (listed) this.emit(UnjoinedChannelsStoreEvent.Changed, spaceId);
            else if (membership === KnownMembership.Leave && previous === KnownMembership.Join) {
                if (isChildOf(this.client, spaceId, room.roomId)) this.scheduleRefresh(spaceId);
            }
        }
    };
}

/** Whether the user was banned from a room, which they then can't join. */
function isBannedFrom(client: MatrixClient, roomId: string): boolean {
    return client.getRoom(roomId)?.getMyMembership() === KnownMembership.Ban;
}

function isChildOf(client: MatrixClient | undefined, spaceId: string, roomId: string): boolean {
    return !!client?.getRoom(spaceId)?.currentState.getStateEvents(EventType.SpaceChild, roomId);
}
