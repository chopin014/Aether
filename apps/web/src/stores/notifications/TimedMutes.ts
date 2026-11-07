/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    ClientEvent,
    EventType,
    type MatrixClient,
    type MatrixEvent,
    type Room,
    RoomEvent,
    TypedEventEmitter,
} from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";

import { getRoomNotifsState, RoomNotifState, setRoomNotifsState } from "../../RoomNotifs";
import defaultDispatcher from "../../dispatcher/dispatcher";
import { Action } from "../../dispatcher/actions";
import { type ActionPayload } from "../../dispatcher/payloads";

/**
 * How a room was muted, in its room account data, so that the mute ends on every device and gives back the level the
 * room had before: `{ v: 1, until?: number, restore: RoomNotifState, by: "channel" | "category" | "server" }`.
 * `until` is in milliseconds since the epoch; without it the mute lasts until the person turns it off.
 */
export const MUTE_ACCOUNT_DATA_TYPE = "io.aether.mute";

/** What muted a room: the room itself, its category or its whole server. */
export type MuteSource = "channel" | "category" | "server";

/** A timer can't wait longer than this; a later mute is checked again when this one fires. */
const MAX_TIMER = 2 ** 31 - 1;

/** How long to wait before trying again to end a mute that couldn't be ended. */
const RETRY_DELAY = 60_000;

const RESTORABLE = new Set<string>([
    RoomNotifState.AllMessages,
    RoomNotifState.AllMessagesLoud,
    RoomNotifState.MentionsOnly,
]);

export enum TimedMutesEvent {
    /** A room's mute started, ended or changed. Passes the room id. */
    Changed = "changed",
}

type EventHandlerMap = { [TimedMutesEvent.Changed]: (roomId: string) => void };

interface MuteRecord {
    until?: number;
    restore: RoomNotifState;
    by: MuteSource;
}

/** A mute record from account data content, if it is a valid one. */
function parseRecord(content: Record<string, unknown> | undefined): MuteRecord | undefined {
    if (!content || typeof content !== "object" || !RESTORABLE.has(content.restore as string)) return undefined;
    const until = typeof content.until === "number" && Number.isFinite(content.until) ? content.until : undefined;
    const by: MuteSource = content.by === "category" || content.by === "server" ? content.by : "channel";
    return { until, restore: content.restore as RoomNotifState, by };
}

const sameRecord = (a?: MuteRecord, b?: MuteRecord): boolean =>
    a?.until === b?.until && a?.restore === b?.restore && a?.by === b?.by;

/** Thrown into work queued for a client that has since stopped being followed. */
class StoppedError extends Error {}

/**
 * Mutes rooms for a while, as Discord does, and ends those mutes when their time is up. Matrix push rules have no
 * expiry, so the room is muted as usual and the end time is kept in the room's account data; whichever of the
 * person's clients is running when it passes turns the room back to its previous level.
 *
 * Every change is a request this class waits for: a room's record is only cleared once its level is back, so a failed
 * request leaves the record for the next attempt instead of a mute that never ends. Changes to one room run one after
 * another, and what this client wrote counts as written until the sync brings it back.
 */
export class TimedMutes extends TypedEventEmitter<TimedMutesEvent, EventHandlerMap> {
    private static internalInstance?: TimedMutes;

    public static get instance(): TimedMutes {
        TimedMutes.internalInstance ??= new TimedMutes();
        return TimedMutes.internalInstance;
    }

    private client?: MatrixClient;
    private timer?: ReturnType<typeof setTimeout>;
    /** Which client the work belongs to, changing whenever another client takes over or the person logs out. */
    private generation = 0;
    /** Rooms whose ended mute is being cleared, until their account data says so. */
    private readonly ending = new Set<string>();
    /** The last change queued for each room, so that the next one waits for it. */
    private readonly queues = new Map<string, Promise<unknown>>();
    /** Levels the server accepted from this client, until its push rules come back with them. */
    private readonly levels = new Map<string, RoomNotifState>();
    /** Records the server accepted from this client (null for a cleared one), until the sync brings them back. */
    private readonly records = new Map<string, MuteRecord | null>();
    private dispatcherRef?: string;

    /** Follow a client's mutes. Safe to call again with the same client. */
    public watch(client: MatrixClient): void {
        if (this.client === client) return;
        this.stop();
        this.client = client;
        client.on(RoomEvent.AccountData, this.onRoomAccountData);
        client.on(ClientEvent.AccountData, this.onAccountData);
        this.dispatcherRef = defaultDispatcher.register(this.onAction);
        this.schedule();
    }

    /** Stop following the client; its timers and queued work go with it. */
    public stop(): void {
        this.generation++;
        this.client?.off(RoomEvent.AccountData, this.onRoomAccountData);
        this.client?.off(ClientEvent.AccountData, this.onAccountData);
        this.client = undefined;
        if (this.dispatcherRef) defaultDispatcher.unregister(this.dispatcherRef);
        this.dispatcherRef = undefined;
        clearTimeout(this.timer);
        this.timer = undefined;
        this.ending.clear();
        this.queues.clear();
        this.levels.clear();
        this.records.clear();
    }

    /** A room's level, counting what the server accepted from this client but hasn't synced back yet. */
    private level(room: Room): RoomNotifState | null {
        return this.levels.get(room.roomId) ?? getRoomNotifsState(room.client, room.roomId);
    }

    /** A room's mute record, counting what this client wrote but hasn't synced back yet. */
    private record(room: Room): MuteRecord | undefined {
        const written = this.records.get(room.roomId);
        if (written !== undefined) return written ?? undefined;
        return parseRecord(room.getAccountData(MUTE_ACCOUNT_DATA_TYPE)?.getContent());
    }

    /** When a room's mute ends, or undefined if it isn't muted for a while. */
    public mutedUntil(room: Room): number | undefined {
        if (!this.isMuted(room)) return undefined;
        const until = this.record(room)?.until;
        return until !== undefined && until > Date.now() ? until : undefined;
    }

    /** What muted a room, if the person muted it through this. */
    public mutedBy(room: Room): MuteSource | undefined {
        return this.isMuted(room) ? this.record(room)?.by : undefined;
    }

    /** Whether a room is muted. */
    public isMuted(room: Room): boolean {
        return this.level(room) === RoomNotifState.Mute;
    }

    /**
     * Mute rooms, for `duration` milliseconds or until they are turned back on when it is null. A category or server
     * mute leaves out rooms that were already muted on their own, so turning it off later won't unmute them.
     * @throws what the server returned when it refused a room's mute.
     */
    public async mute(rooms: Room[], duration: number | null, by: MuteSource = "channel"): Promise<void> {
        const until = duration === null ? undefined : Date.now() + duration;
        await this.forEach(rooms, (room, generation) => this.muteRoom(room, until, by, generation));
    }

    /**
     * Turn rooms back to the level they had before they were muted. With `by`, only the rooms that a category or
     * server mute silenced are turned back on.
     * @throws what the server returned when it refused a room's level; that room's record stays for another attempt.
     */
    public async unmute(rooms: Room[], by?: MuteSource): Promise<void> {
        await this.forEach(rooms, (room, generation) => this.unmuteRoom(room, by, generation));
    }

    private async forEach(rooms: Room[], change: (room: Room, generation: number) => Promise<void>): Promise<void> {
        const results = await Promise.allSettled(rooms.map((room) => this.inOrder(room, change)));
        this.schedule();
        const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failure && !(failure.reason instanceof StoppedError)) throw failure.reason;
    }

    /** Run a change to a room after the ones already queued for it, unless the client stops being followed first. */
    private inOrder(room: Room, change: (room: Room, generation: number) => Promise<void>): Promise<void> {
        const generation = this.generation;
        const previous = this.queues.get(room.roomId) ?? Promise.resolve();
        const next = previous
            .catch(() => {})
            .then(() => {
                if (generation !== this.generation) throw new StoppedError();
                return change(room, generation);
            });
        this.queues.set(room.roomId, next);
        void next
            .catch(() => {})
            .finally(() => {
                if (this.queues.get(room.roomId) === next) this.queues.delete(room.roomId);
            });
        return next;
    }

    /** Set a room's level and remember it until the server's push rules say the same. */
    private async setLevel(room: Room, state: RoomNotifState, generation: number): Promise<void> {
        await setRoomNotifsState(room.client, room.roomId, state);
        if (generation !== this.generation) throw new StoppedError();
        this.levels.set(room.roomId, state);
        this.emit(TimedMutesEvent.Changed, room.roomId);
    }

    /** Write a room's record (null clears it) and remember it until the sync brings it back. */
    private async setRecord(room: Room, record: MuteRecord | null, generation: number): Promise<void> {
        const content = record
            ? {
                  v: 1,
                  restore: record.restore,
                  by: record.by,
                  ...(record.until === undefined ? {} : { until: record.until }),
              }
            : {};
        await room.client.setRoomAccountData(room.roomId, MUTE_ACCOUNT_DATA_TYPE, content);
        if (generation !== this.generation) throw new StoppedError();
        this.records.set(room.roomId, record);
        this.emit(TimedMutesEvent.Changed, room.roomId);
    }

    private async muteRoom(room: Room, until: number | undefined, by: MuteSource, generation: number): Promise<void> {
        const muted = this.isMuted(room);
        const record = this.record(room);
        // A room the person muted on its own stays theirs to unmute.
        if (muted && by !== "channel" && record?.by !== by) return;
        const current = this.level(room);
        const restore =
            muted || !current || !RESTORABLE.has(current) ? (record?.restore ?? RoomNotifState.AllMessages) : current;
        // The record goes first, so that whatever happens next, it knows how to end the mute.
        await this.setRecord(room, { until, restore, by }, generation);
        if (!muted) await this.setLevel(room, RoomNotifState.Mute, generation);
    }

    private async unmuteRoom(room: Room, by: MuteSource | undefined, generation: number): Promise<void> {
        const record = this.record(room);
        if (by && record?.by !== by) return;
        if (this.isMuted(room)) await this.setLevel(room, record?.restore ?? RoomNotifState.AllMessages, generation);
        // The level is back, so the record has done its job, unless a newer mute replaced it meanwhile.
        if (record && sameRecord(this.record(room), record)) await this.setRecord(room, null, generation);
    }

    /** Wake up when the next mute ends, ending every mute whose time has passed. */
    private schedule(): void {
        clearTimeout(this.timer);
        this.timer = undefined;
        const client = this.client;
        if (!client) return;

        const now = Date.now();
        let next: number | undefined;
        const ended: Room[] = [];
        for (const room of client.getRooms()) {
            const until = this.record(room)?.until;
            if (until === undefined || this.ending.has(room.roomId)) continue;
            if (until <= now) ended.push(room);
            else next = Math.min(next ?? until, until);
        }
        for (const room of ended) {
            this.ending.add(room.roomId);
            this.inOrder(room, (target, generation) => this.unmuteRoom(target, undefined, generation))
                .then(() => this.ending.delete(room.roomId))
                .catch((error) => {
                    if (error instanceof StoppedError) return;
                    logger.warn(`Failed to end the timed mute of ${room.roomId}`, error);
                    this.ending.delete(room.roomId);
                    // Try again a little later rather than at once.
                    clearTimeout(this.timer);
                    this.timer = setTimeout(() => this.schedule(), RETRY_DELAY);
                });
        }
        if (next !== undefined) this.timer = setTimeout(() => this.schedule(), Math.min(next - now, MAX_TIMER));
    }

    /** The sync brought a room's record back: from now on, it is the one to read. */
    private readonly onRoomAccountData = (event: MatrixEvent, room: Room): void => {
        if (event.getType() !== MUTE_ACCOUNT_DATA_TYPE) return;
        this.records.delete(room.roomId);
        this.emit(TimedMutesEvent.Changed, room.roomId);
        this.schedule();
    };

    /** The push rules came back: they say each room's level from now on. */
    private readonly onAccountData = (event: MatrixEvent): void => {
        if (event.getType() !== EventType.PushRules || this.levels.size === 0) return;
        const roomIds = [...this.levels.keys()];
        this.levels.clear();
        for (const roomId of roomIds) this.emit(TimedMutesEvent.Changed, roomId);
    };

    private readonly onAction = (payload: ActionPayload): void => {
        if (payload.action === Action.OnLoggedOut) this.stop();
    };
}
