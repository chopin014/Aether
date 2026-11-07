/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    ClientEvent,
    EventType,
    type IPushRules,
    type MatrixClient,
    type MatrixEvent,
    type Room,
    RoomEvent,
    TypedEventEmitter,
} from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";
import { isEqual } from "lodash";

import { getRoomNotifsState, RoomNotifState, setRoomNotifsState } from "../../RoomNotifs";
import { CATCH_UP_DELAYS, fetchPushRules, fetchRoomAccountData } from "./serverCopy";
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

/** How many rooms are changed at once, so that a large server doesn't flood its homeserver. */
const MAX_CONCURRENT_CHANGES = 8;

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

/** A mute record, if the content is a valid one. */
function parseRecord(content: Record<string, unknown> | undefined): MuteRecord | undefined {
    if (!content || typeof content !== "object" || typeof content.restore !== "string") return undefined;
    if (!RESTORABLE.has(content.restore)) return undefined;
    const until = typeof content.until === "number" && Number.isFinite(content.until) ? content.until : undefined;
    const by: MuteSource = content.by === "category" || content.by === "server" ? content.by : "channel";
    return { until, restore: content.restore as RoomNotifState, by };
}

/** A room's mute record, as synced, if it is a valid one. */
const readRecord = (room: Room): MuteRecord | undefined =>
    parseRecord(room.getAccountData(MUTE_ACCOUNT_DATA_TYPE)?.getContent());

const sameRecord = (a?: MuteRecord, b?: MuteRecord): boolean =>
    a?.until === b?.until && a?.restore === b?.restore && a?.by === b?.by;

/** Work cancelled because the person logged out or another client took over. */
export class StoppedError extends Error {
    public constructor() {
        super("Stopped");
    }
}

const dataKey = (roomId: string, type: string): string => `${roomId}\u0000${type}`;

/**
 * How long this client's write is expected in the server's copy. Only a copy showing it confirms it, since a synced
 * value can't tell an old write from a new one; past this, a worker would have caught up long ago.
 */
const EXPECTATION_LIFETIME = 60_000;

/** A write the server accepted, and when. */
interface Expectation<T> {
    value: T;
    written: number;
}

/** The expectation under a key, unless it has lived too long. */
function expectation<T>(expectations: Map<string, Expectation<T>>, key: string): Expectation<T> | undefined {
    const entry = expectations.get(key);
    if (entry && Date.now() - entry.written < EXPECTATION_LIFETIME) return entry;
    expectations.delete(key);
    return undefined;
}

/** A promise that fails with {@link StoppedError} once `stop` is called. */
function stopSignal(): { promise: Promise<never>; stop: () => void } {
    let stop!: () => void;
    const promise = new Promise<never>((_resolve, reject) => (stop = () => reject(new StoppedError())));
    promise.catch(() => {});
    return { promise, stop };
}

/** Lets at most `max` tasks run at once; each waits for a place, and gives it back with the function it receives. */
function concurrencyLimit(max: number): () => Promise<() => void> {
    let running = 0;
    const waiting: Array<() => void> = [];
    return async () => {
        // A place given back goes straight to the next task waiting, so the count only changes when nobody waits.
        if (running < max) running++;
        else await new Promise<void>((resolve) => waiting.push(resolve));
        let released = false;
        return () => {
            if (released) return;
            released = true;
            const next = waiting.shift();
            if (next) next();
            else running--;
        };
    };
}

/**
 * Mutes rooms for a while, as Discord does, and ends those mutes when their time is up. Matrix push rules have no
 * expiry, so the room is muted as usual and the end time is kept in the room's account data; whichever of the
 * person's clients is running when it passes turns the room back to its previous level.
 *
 * Changes to a room run one after another, and each reads the room's push rules and record from the server before
 * deciding anything, so it sees the changes before it even when the sync hasn't brought them back yet. A server with
 * workers may serve a copy that doesn't show this client's last write yet, so a copy without it is read again a few
 * times before it is taken as someone else's newer change. A room's record is only cleared once its level is back, so
 * a failure leaves it for the next attempt instead of a mute that never ends.
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
    /** Rooms whose ended mute is being ended now. */
    private readonly ending = new Set<string>();
    /** When to try again to end each mute that couldn't be ended. */
    private readonly retries = new Map<string, number>();
    /** The last change queued for each room, so that the next one waits for it. */
    private readonly queues = new Map<string, Promise<unknown>>();
    private dispatcherRef?: string;
    /** Counts the level writes that finished, to tell whether a fetch of the push rules started after a room's. */
    private writes = 0;
    /** The count of finished level writes when each room's last one finished. */
    private readonly lastWrite = new Map<string, number>();
    /** The fetch of the push rules being made, shared by the rooms whose last write it started after. */
    private rulesFetch?: { started: number; rules: Promise<IPushRules> };
    /** The level this client last gave each room, until the server's copy shows it. */
    private readonly expectedLevels = new Map<string, Expectation<RoomNotifState>>();
    /** The room account data this client last wrote, by room id and type, until the server's copy shows it. */
    private readonly expectedData = new Map<string, Expectation<Record<string, unknown>>>();
    private stopped = stopSignal();
    private limit = concurrencyLimit(MAX_CONCURRENT_CHANGES);

    /** The current generation, for work outside this class that must stop with it. */
    public get currentGeneration(): number {
        return this.generation;
    }

    /**
     * Fails with {@link StoppedError} once the work of the current generation stops, so that whoever waits for that
     * work can stop waiting even while a request of it is still on its way.
     */
    public get untilStopped(): Promise<never> {
        return this.stopped.promise;
    }

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
        this.stopped.stop();
        this.stopped = stopSignal();
        this.limit = concurrencyLimit(MAX_CONCURRENT_CHANGES);
        this.expectedLevels.clear();
        this.expectedData.clear();
        this.client?.off(RoomEvent.AccountData, this.onRoomAccountData);
        this.client?.off(ClientEvent.AccountData, this.onAccountData);
        this.client = undefined;
        if (this.dispatcherRef) defaultDispatcher.unregister(this.dispatcherRef);
        this.dispatcherRef = undefined;
        clearTimeout(this.timer);
        this.timer = undefined;
        this.ending.clear();
        this.retries.clear();
        this.queues.clear();
        this.lastWrite.clear();
        this.rulesFetch = undefined;
    }

    /** When a room's mute ends, or undefined if it isn't muted for a while. */
    public mutedUntil(room: Room): number | undefined {
        if (!this.isMuted(room)) return undefined;
        const until = readRecord(room)?.until;
        return until !== undefined && until > Date.now() ? until : undefined;
    }

    /** What muted a room, if the person muted it through this. */
    public mutedBy(room: Room): MuteSource | undefined {
        return this.isMuted(room) ? readRecord(room)?.by : undefined;
    }

    /** Whether a room is muted. */
    public isMuted(room: Room): boolean {
        return getRoomNotifsState(room.client, room.roomId) === RoomNotifState.Mute;
    }

    /**
     * Mute rooms, for `duration` milliseconds or until they are turned back on when it is null. A category or server
     * mute leaves out rooms that were already muted on their own, so turning it off later won't unmute them.
     * @throws what went wrong with the first room that failed, or {@link StoppedError}.
     */
    public async mute(rooms: Room[], duration: number | null, by: MuteSource = "channel"): Promise<void> {
        const until = duration === null ? undefined : Date.now() + duration;
        await this.forEach(rooms, (room, generation) => this.muteRoom(room, until, by, generation));
    }

    /**
     * Turn rooms back to the level they had before they were muted. With `by`, only the rooms that a category or
     * server mute silenced are turned back on.
     * @throws what went wrong with the first room that failed, whose record stays for another attempt.
     */
    public async unmute(rooms: Room[], by?: MuteSource): Promise<void> {
        await this.forEach(rooms, (room, generation) => this.unmuteRoom(room, by, false, generation));
    }

    /**
     * Set a room's level, as the person chose in its notification settings. Any level but muted ends a timed mute
     * there, so that it won't come back to change the level again.
     */
    public async setLevel(room: Room, state: RoomNotifState): Promise<void> {
        await this.forEach([room], async (target, generation) => {
            const [{ rules }, record] = await Promise.all([
                this.fetchLevel(target, generation),
                this.fetchRecord(target, generation),
            ]);
            await this.writeLevel(target, state, rules, generation);
            if (state !== RoomNotifState.Mute && record) await this.writeRecord(target, null, generation);
        });
    }

    /**
     * Move rooms from one level to another, leaving the ones at any other level as they are, such as a server's
     * channels that follow its level. Each room is looked at when its turn comes, after its earlier changes.
     */
    public async moveLevel(rooms: Room[], from: RoomNotifState, to: RoomNotifState): Promise<void> {
        await this.forEach(rooms, async (room, generation) => {
            const { rules, level } = await this.fetchLevel(room, generation);
            const current = level ?? RoomNotifState.AllMessages;
            if (current === from && current !== to) await this.writeLevel(room, to, rules, generation);
        });
    }

    private async forEach(rooms: Room[], change: (room: Room, generation: number) => Promise<void>): Promise<void> {
        const results = await Promise.allSettled(rooms.map((room) => this.inOrder(room, change)));
        this.schedule();
        const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failure) throw failure.reason;
    }

    /**
     * Change a room's account data, and expect it in the server's copy from then on. For changes queued with this
     * class's, to stop with them.
     */
    public async writeAccountData(
        room: Room,
        type: string,
        content: Record<string, unknown>,
        generation: number,
    ): Promise<void> {
        const key = dataKey(room.roomId, type);
        // Nothing of a client that stopped being followed goes out any more.
        this.checkGeneration(generation);
        try {
            await room.client.setRoomAccountData(room.roomId, type as never, content as never);
        } catch (error) {
            // The server may or may not have taken it, so the next read takes the server's copy as it is.
            if (generation === this.generation) this.expectedData.delete(key);
            throw error;
        }
        this.checkGeneration(generation);
        this.expectedData.set(key, { value: content, written: Date.now() });
    }

    /**
     * A room's account data as the server holds it, once its copy shows this client's last write there or, after a
     * few reads, is taken as someone else's newer change.
     */
    public async readAccountData(room: Room, type: string, generation: number): Promise<Record<string, unknown>> {
        const key = dataKey(room.roomId, type);
        const expected = expectation(this.expectedData, key);
        let content = await fetchRoomAccountData(room.client, room.roomId, type);
        this.checkGeneration(generation);
        for (const delay of CATCH_UP_DELAYS) {
            if (expected === undefined || isEqual(content, expected.value)) break;
            await this.sleep(delay, generation);
            content = await fetchRoomAccountData(room.client, room.roomId, type);
            this.checkGeneration(generation);
        }
        if (this.expectedData.get(key) === expected) this.expectedData.delete(key);
        return content;
    }

    private async sleep(delay: number, generation: number): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, delay));
        this.checkGeneration(generation);
    }

    /** Run a change to a room after the ones already queued for it, unless the client stops being followed first. */
    private inOrder(room: Room, change: (room: Room, generation: number) => Promise<void>): Promise<void> {
        const generation = this.generation;
        const previous = this.queues.get(room.roomId) ?? Promise.resolve();
        const limit = this.limit;
        const run = async (): Promise<void> => {
            this.checkGeneration(generation);
            const release = await limit();
            try {
                this.checkGeneration(generation);
                await change(room, generation);
            } finally {
                release();
            }
        };
        const stopped = this.stopped.promise;
        const next = previous.catch(() => {}).then(() => Promise.race([run(), stopped]));
        this.queues.set(room.roomId, next);
        void next
            .catch(() => {})
            .finally(() => {
                if (this.queues.get(room.roomId) === next) this.queues.delete(room.roomId);
            });
        return next;
    }

    private checkGeneration(generation: number): void {
        if (generation !== this.generation) throw new StoppedError();
    }

    /**
     * A room's level and the push rules it comes from, as the server holds them, once its copy shows the level this
     * client last gave the room or, after a few reads, is taken as someone else's newer change. Rooms changed together
     * share one fetch, as long as it started after the room's own last write.
     */
    private async fetchLevel(
        room: Room,
        generation: number,
    ): Promise<{ rules: IPushRules; level: RoomNotifState | null }> {
        const expected = expectation(this.expectedLevels, room.roomId);
        let rules = await this.sharedRules(room, generation);
        let level = getRoomNotifsState(room.client, room.roomId, rules);
        for (const delay of CATCH_UP_DELAYS) {
            if (expected === undefined || level === expected.value) break;
            await this.sleep(delay, generation);
            rules = await fetchPushRules(room.client);
            this.checkGeneration(generation);
            level = getRoomNotifsState(room.client, room.roomId, rules);
        }
        if (this.expectedLevels.get(room.roomId) === expected) this.expectedLevels.delete(room.roomId);
        return { rules, level };
    }

    /** The push rules, from a fetch shared with other rooms if it started after this room's last write. */
    private async sharedRules(room: Room, generation: number): Promise<IPushRules> {
        let fetch = this.rulesFetch;
        if (!fetch || fetch.started < (this.lastWrite.get(room.roomId) ?? 0)) {
            const current = { started: this.writes, rules: fetchPushRules(room.client) };
            this.rulesFetch = fetch = current;
            const forget = (): void => {
                if (this.rulesFetch === current) this.rulesFetch = undefined;
            };
            current.rules.then(forget, forget);
        }
        const rules = await fetch.rules;
        this.checkGeneration(generation);
        return rules;
    }

    /** A room's mute record, as {@link readAccountData} reads it. */
    private async fetchRecord(room: Room, generation: number): Promise<MuteRecord | undefined> {
        return parseRecord(await this.readAccountData(room, MUTE_ACCOUNT_DATA_TYPE, generation));
    }

    /** Change a room's level from the push rules just read. */
    private async writeLevel(room: Room, state: RoomNotifState, rules: IPushRules, generation: number): Promise<void> {
        // Nothing of a client that stopped being followed goes out any more.
        this.checkGeneration(generation);
        try {
            await setRoomNotifsState(room.client, room.roomId, state, rules);
        } catch (error) {
            // Some of the rules may have changed, so the next read takes the server's copy as it is.
            if (generation === this.generation) this.expectedLevels.delete(room.roomId);
            throw error;
        } finally {
            // A fetch started before this write doesn't show it.
            if (generation === this.generation) this.lastWrite.set(room.roomId, ++this.writes);
        }
        // A request that outlived its client must leave the next client's expectations alone.
        this.checkGeneration(generation);
        this.expectedLevels.set(room.roomId, { value: state, written: Date.now() });
    }

    /** Write a room's record; null clears it. */
    private async writeRecord(room: Room, record: MuteRecord | null, generation: number): Promise<void> {
        const content = record
            ? {
                  v: 1,
                  restore: record.restore,
                  by: record.by,
                  ...(record.until === undefined ? {} : { until: record.until }),
              }
            : {};
        await this.writeAccountData(room, MUTE_ACCOUNT_DATA_TYPE, content, generation);
    }

    private async muteRoom(room: Room, until: number | undefined, by: MuteSource, generation: number): Promise<void> {
        const [{ rules, level }, record] = await Promise.all([
            this.fetchLevel(room, generation),
            this.fetchRecord(room, generation),
        ]);
        const muted = level === RoomNotifState.Mute;
        // A room the person muted on its own stays theirs to unmute.
        if (muted && by !== "channel" && record?.by !== by) return;
        const restore =
            muted || !level || !RESTORABLE.has(level) ? (record?.restore ?? RoomNotifState.AllMessages) : level;
        // The record goes first, so that whatever happens next, it knows how to end the mute.
        await this.writeRecord(room, { until, restore, by }, generation);
        if (!muted) await this.writeLevel(room, RoomNotifState.Mute, rules, generation);
        this.emit(TimedMutesEvent.Changed, room.roomId);
    }

    private async unmuteRoom(
        room: Room,
        by: MuteSource | undefined,
        onlyIfEnded: boolean,
        generation: number,
    ): Promise<void> {
        const [{ rules, level }, record] = await Promise.all([
            this.fetchLevel(room, generation),
            this.fetchRecord(room, generation),
        ]);
        // A mute extended while this waited its turn isn't over any more.
        if (onlyIfEnded && (record?.until === undefined || record.until > Date.now())) return;
        if (by && record?.by !== by) return;
        if (level === RoomNotifState.Mute) {
            await this.writeLevel(room, record?.restore ?? RoomNotifState.AllMessages, rules, generation);
        }
        // The level is back, so the record has done its job, unless another device muted the room again meanwhile.
        if (record && sameRecord(await this.fetchRecord(room, generation), record)) {
            await this.writeRecord(room, null, generation);
        }
        this.emit(TimedMutesEvent.Changed, room.roomId);
    }

    /** Wake up when the next mute ends or the next failed one is due another try, ending every mute that is over. */
    private schedule(): void {
        clearTimeout(this.timer);
        this.timer = undefined;
        const client = this.client;
        if (!client) return;

        const now = Date.now();
        let next: number | undefined;
        for (const room of client.getRooms()) {
            const until = readRecord(room)?.until;
            if (until === undefined || this.ending.has(room.roomId)) continue;
            const due = Math.max(until, this.retries.get(room.roomId) ?? 0);
            if (due > now) {
                next = Math.min(next ?? due, due);
                continue;
            }
            this.endMute(room);
        }
        if (next !== undefined) this.timer = setTimeout(() => this.schedule(), Math.min(next - now, MAX_TIMER));
    }

    private endMute(room: Room): void {
        this.ending.add(room.roomId);
        this.retries.delete(room.roomId);
        this.inOrder(room, (target, generation) => this.unmuteRoom(target, undefined, true, generation))
            .then(() => {
                // Until the sync brings the cleared record, the mute still looks over, so wait for it to come
                // rather than end it again and again.
                this.retries.set(room.roomId, Date.now() + RETRY_DELAY);
            })
            .catch((error) => {
                if (error instanceof StoppedError) return;
                logger.warn(`Failed to end the timed mute of ${room.roomId}`, error);
                this.retries.set(room.roomId, Date.now() + RETRY_DELAY);
            })
            .finally(() => {
                this.ending.delete(room.roomId);
                this.schedule();
            });
    }

    private readonly onRoomAccountData = (event: MatrixEvent, room: Room): void => {
        if (event.getType() !== MUTE_ACCOUNT_DATA_TYPE) return;
        // A record that changed is checked again from now on.
        this.retries.delete(room.roomId);
        this.emit(TimedMutesEvent.Changed, room.roomId);
        this.schedule();
    };

    private readonly onAccountData = (event: MatrixEvent): void => {
        if (event.getType() !== EventType.PushRules || !this.client) return;
        // Mutes show through the push rules, so any room's might have started or ended.
        for (const room of this.client.getRooms()) {
            if (readRecord(room)) this.emit(TimedMutesEvent.Changed, room.roomId);
        }
    };

    private readonly onAction = (payload: ActionPayload): void => {
        if (payload.action === Action.OnLoggedOut) this.stop();
    };
}
