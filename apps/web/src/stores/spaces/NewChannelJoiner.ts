/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { logger } from "matrix-js-sdk/src/logger";
import {
    ClientEvent,
    EventType,
    KnownMembership,
    type IContent,
    type MatrixClient,
    MatrixError,
    type MatrixEvent,
    type Room,
    RoomEvent,
    RoomStateEvent,
    SyncState,
} from "matrix-js-sdk/src/matrix";

import SettingsStore from "../../settings/SettingsStore";
import { listJoinableChannels } from "../../utils/servers/serverChannels";
import { readJoinableHint } from "./joinableChild";

/**
 * The channels of one server this person has already been offered, in the Space's room account data so that every
 * device agrees: `{ v: 1, since: number, rooms: string[] }`. A channel added to the server later, after `since`, is
 * joined once; one that is listed was already joined, skipped or left, and is never joined again on its own.
 */
export const KNOWN_CHANNELS_ACCOUNT_DATA_TYPE = "io.aether.space.known_channels";

/** Past this many known channels, the ones no longer in the server are forgotten. */
const MAX_KNOWN_CHANNELS = 1000;
/** More new channels than this at once is not something an admin does by hand, so none of them are joined. */
const MAX_NEW_CHANNELS = 50;
/** Joins sent at once, so that many new channels don't flood the homeserver. */
const JOIN_CONCURRENCY = 4;
/** Further attempts at a join that failed for a passing reason, such as the network or a busy server. */
const JOIN_RETRIES = 2;

interface KnownChannels {
    /** Child events no newer than this were already there when the server was first seen. */
    since: number;
    rooms: Set<string>;
}

/** A new channel to join. */
interface NewChannel {
    roomId: string;
    via: string[];
    /** Whether the child event says that the Space's members can join it. */
    joinable?: boolean;
}

function parseKnownChannels(content: IContent | undefined): KnownChannels | undefined {
    if (!content || typeof content.since !== "number" || !Array.isArray(content.rooms)) return undefined;
    return {
        since: content.since,
        rooms: new Set(content.rooms.filter((room: unknown): room is string => typeof room === "string")),
    };
}

/** Everything either record knows, which is never more than what this person was already offered. */
function mergeKnownChannels(a?: KnownChannels, b?: KnownChannels): KnownChannels | undefined {
    if (!a || !b) return a ?? b;
    return { since: Math.max(a.since, b.since), rooms: new Set([...a.rooms, ...b.rooms]) };
}

/** The child events of a Space that add a room to it; one without servers to join through removes it. */
function childEvents(space: Room): MatrixEvent[] {
    return space.currentState.getStateEvents(EventType.SpaceChild).filter((event) => {
        const via = event.getContent().via;
        return !!event.getStateKey() && Array.isArray(via) && via.length > 0;
    });
}

/** Whether the user is, was or is asked to be a member of a room: joined, invited, banned, knocking or left. */
function hasMembership(client: MatrixClient, roomId: string): boolean {
    const room = client.getRoom(roomId);
    if (!room) return false;
    if (room.getMyMembership() !== KnownMembership.Leave) return true;
    // A room the client knows but was never in, such as one being previewed, also reads as left.
    return !!room.currentState.getStateEvents(EventType.RoomMember, client.getSafeUserId());
}

function isPassingFailure(error: unknown): boolean {
    if (!(error instanceof MatrixError)) return true; // the request never reached the server
    return error.httpStatus === 429 || (error.httpStatus ?? 0) >= 500;
}

/**
 * Joins the channels added to the user's servers while they are in them, as on Discord, where a new channel shows
 * for every member the moment it is created. Its place in the sidebar comes from the server's shared layout, which
 * every member already has.
 *
 * Only channels added after this person was first seen in the server are joined, and each one only once: a channel
 * they left, on any device, stays left. The channels a server already has when they join it are left to the join
 * flow, which joins a small server's channels and offers a large one's.
 */
export class NewChannelJoiner {
    private static internalInstance?: NewChannelJoiner;

    public static get instance(): NewChannelJoiner {
        NewChannelJoiner.internalInstance ??= new NewChannelJoiner();
        return NewChannelJoiner.internalInstance;
    }

    private client?: MatrixClient;
    /** Changes with every client, so that work still running for the previous one stops. */
    private generation = 0;
    /** What this device knows of each server's known channels, including writes the server hasn't echoed yet. */
    private readonly known = new Map<string, KnownChannels>();
    /** Servers whose channels may have changed since the last sync. */
    private readonly changed = new Set<string>();
    /** Whether every server needs reading at the next sync, as when the client starts. */
    private readAll = true;
    /** Rooms the user is joining, whose channels at the time are the join flow's to offer rather than new. */
    private readonly joiningServers = new Set<string>();
    private readonly unsaved = new Set<string>();
    private saving = false;
    /** New channels waiting to be joined, by server. */
    private readonly queued = new Map<string, Map<string, NewChannel>>();
    private readonly joiningIn = new Set<string>();

    /** Follow a client from before its first sync. Safe to call again with the same client. */
    public start(client: MatrixClient): void {
        if (this.client === client) return;
        this.stop();
        this.client = client;
        client.on(ClientEvent.Sync, this.onSync);
        client.on(ClientEvent.Room, this.onRoom);
        client.on(RoomStateEvent.Events, this.onStateEvent);
        client.on(RoomEvent.MyMembership, this.onMyMembership);
    }

    public stop(): void {
        this.generation++;
        this.client?.off(ClientEvent.Sync, this.onSync);
        this.client?.off(ClientEvent.Room, this.onRoom);
        this.client?.off(RoomStateEvent.Events, this.onStateEvent);
        this.client?.off(RoomEvent.MyMembership, this.onMyMembership);
        this.client = undefined;
        this.known.clear();
        this.changed.clear();
        this.readAll = true;
        this.joiningServers.clear();
        this.unsaved.clear();
        this.saving = false;
        this.queued.clear();
        this.joiningIn.clear();
    }

    /**
     * Note that the user is about to join a room that may be a server. Call it before the join is sent, so that the
     * channels the server has when the join arrives are treated as already there, even on a server they were in
     * before, rather than as new ones.
     */
    public expectJoin(roomId: string): void {
        this.joiningServers.add(roomId);
    }

    private readonly onRoom = (room: Room): void => {
        this.changed.add(room.roomId);
    };

    private readonly onStateEvent = (event: MatrixEvent): void => {
        if (event.getType() === EventType.SpaceChild) this.changed.add(event.getRoomId()!);
    };

    private readonly onMyMembership = (room: Room, membership: string): void => {
        if (membership === KnownMembership.Join) this.changed.add(room.roomId);
    };

    /** Read the servers that changed once a sync response has been applied, when every room and membership is in. */
    private readonly onSync = (state: SyncState): void => {
        if (state !== SyncState.Prepared && state !== SyncState.Syncing) return;
        const client = this.client;
        if (!client) return;
        if (!SettingsStore.getValue("feature_desktop_shell")) {
            this.changed.clear();
            this.readAll = true;
            return;
        }
        const rooms = this.readAll
            ? client.getRooms()
            : [...this.changed].map((roomId) => client.getRoom(roomId)).filter((room) => !!room);
        this.readAll = false;
        this.changed.clear();
        for (const room of rooms) this.readServer(client, room);
    };

    private readServer(client: MatrixClient, space: Room): void {
        if (space.getMyMembership() !== KnownMembership.Join || !space.isSpaceRoom()) return;
        const spaceId = space.roomId;
        const children = childEvents(space);
        const known = mergeKnownChannels(
            this.known.get(spaceId),
            parseKnownChannels(space.getAccountData(KNOWN_CHANNELS_ACCOUNT_DATA_TYPE)?.getContent()),
        );

        // The first time the person is seen in the server, or just after they join it, its channels are the
        // baseline. Joining those is the join flow's job, and some may be channels they left long ago. Nothing added
        // before they joined is new to them either, even if the sync brings it later.
        const justJoined = this.joiningServers.delete(spaceId);
        if (!known || justJoined) {
            const joinedAt = space.currentState.getStateEvents(EventType.RoomMember, client.getSafeUserId())?.getTs();
            const since = Math.max(known?.since ?? 0, joinedAt ?? 0, ...children.map((event) => event.getTs()));
            const rooms = new Set([...(known?.rooms ?? []), ...children.map((event) => event.getStateKey()!)]);
            this.remember(spaceId, { since, rooms }, children);
            return;
        }

        const unseen = children.filter((event) => !known.rooms.has(event.getStateKey()!));
        if (unseen.length === 0) {
            this.known.set(spaceId, known);
            return;
        }
        // Whatever happens next, each of these is offered once.
        const rooms = new Set([...known.rooms, ...unseen.map((event) => event.getStateKey()!)]);
        this.remember(spaceId, { since: known.since, rooms }, children);
        if (!SettingsStore.getValue("Spaces.joinAllChannels")) return;

        const userId = client.getSafeUserId();
        const fresh = unseen.filter(
            (event) =>
                event.getTs() > known.since &&
                // The user's own channels: they are in them already, even if the sync hasn't said so yet.
                event.getSender() !== userId &&
                !hasMembership(client, event.getStateKey()!) &&
                readJoinableHint(event.getContent()) !== false,
        );
        if (fresh.length === 0) return;
        if (fresh.length > MAX_NEW_CHANNELS) {
            logger.warn(`Not joining ${fresh.length} channels added to ${spaceId} at once`);
            return;
        }
        const queue = this.queued.get(spaceId) ?? new Map<string, NewChannel>();
        this.queued.set(spaceId, queue);
        for (const event of fresh) {
            const content = event.getContent();
            queue.set(event.getStateKey()!, {
                roomId: event.getStateKey()!,
                via: content.via.filter((server: unknown) => typeof server === "string"),
                joinable: readJoinableHint(content),
            });
        }
        void this.joinQueued(client, spaceId);
    }

    /** Join a server's new channels, one batch at a time, picking up channels that arrive meanwhile. */
    private async joinQueued(client: MatrixClient, spaceId: string): Promise<void> {
        if (this.joiningIn.has(spaceId)) return;
        this.joiningIn.add(spaceId);
        const generation = this.generation;
        try {
            for (let batch = this.queued.get(spaceId); batch?.size; batch = this.queued.get(spaceId)) {
                this.queued.delete(spaceId);
                await this.joinBatch(client, spaceId, [...batch.values()], generation);
                if (generation !== this.generation) return;
            }
        } finally {
            if (generation === this.generation) this.joiningIn.delete(spaceId);
        }
    }

    private async joinBatch(
        client: MatrixClient,
        spaceId: string,
        channels: NewChannel[],
        generation: number,
    ): Promise<void> {
        // A channel Aether made says the members can join it, so it is joined straight away. Any other is first
        // looked up, so that a nested server or a channel the user can't join is left alone.
        const direct = channels.filter((channel) => channel.joinable === true);
        const unknown = channels.filter((channel) => channel.joinable === undefined);
        const queue = [...direct];
        let lookup: Promise<void> | undefined;
        if (unknown.length > 0) {
            lookup = listJoinableChannels(client, spaceId).then(
                (joinable) => {
                    const ids = new Set(joinable.map((channel) => channel.roomId));
                    queue.push(...unknown.filter((channel) => ids.has(channel.roomId)));
                },
                (error) => logger.warn(`Could not look up the new channels of ${spaceId}`, error),
            );
        }

        const worker = async (): Promise<void> => {
            for (;;) {
                const channel = queue.shift();
                if (channel) {
                    await this.join(client, channel, generation);
                } else if (lookup) {
                    await lookup;
                    lookup = undefined;
                } else {
                    return;
                }
                if (generation !== this.generation) return;
            }
        };
        await Promise.all(Array.from({ length: JOIN_CONCURRENCY }, worker));
    }

    private async join(client: MatrixClient, channel: NewChannel, generation: number): Promise<void> {
        for (let attempt = 0; ; attempt++) {
            try {
                await client.joinRoom(channel.roomId, { viaServers: channel.via });
                return;
            } catch (error) {
                if (attempt >= JOIN_RETRIES || !isPassingFailure(error) || generation !== this.generation) {
                    logger.warn(`Could not join the new channel ${channel.roomId}`, error);
                    return;
                }
                const retryAfter = error instanceof MatrixError ? error.getRetryAfterMs() : null;
                await new Promise((resolve) => setTimeout(resolve, retryAfter ?? 1000 * 3 ** attempt));
                if (generation !== this.generation) return;
            }
        }
    }

    /** Keep a server's known channels and save them to its account data in the background. */
    private remember(spaceId: string, known: KnownChannels, children: MatrixEvent[]): void {
        if (known.rooms.size > MAX_KNOWN_CHANNELS) {
            known = { since: known.since, rooms: new Set(children.map((event) => event.getStateKey()!)) };
        }
        this.known.set(spaceId, known);
        this.unsaved.add(spaceId);
        void this.save();
    }

    /** Write the known channels one server at a time, each with its latest value. */
    private async save(): Promise<void> {
        const client = this.client;
        if (this.saving || !client) return;
        this.saving = true;
        const generation = this.generation;
        try {
            for (const spaceId of this.unsaved) {
                this.unsaved.delete(spaceId);
                const known = this.known.get(spaceId);
                if (!known) continue;
                try {
                    await client.setRoomAccountData(spaceId, KNOWN_CHANNELS_ACCOUNT_DATA_TYPE, {
                        v: 1,
                        since: known.since,
                        rooms: [...known.rooms],
                    });
                } catch (error) {
                    // This device still knows them; the next change in the server saves them again.
                    logger.warn(`Could not save the known channels of ${spaceId}`, error);
                }
                if (generation !== this.generation) return;
            }
        } finally {
            if (generation === this.generation) this.saving = false;
        }
    }
}
