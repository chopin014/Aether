/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { EventType, type IMinimalEvent, type MatrixEvent } from "matrix-js-sdk/src/matrix";
import { type MSC3575RoomData, type SlidingSyncSnapshot } from "matrix-js-sdk/src/sliding-sync";

import { logger } from "matrix-js-sdk/src/logger";

import { type SavedLedger, trimSavedLedger } from "./notification-counts/RoomCountLedger";

type RoomEventJson = NonNullable<MSC3575RoomData["timeline"]>[number];

/** What is kept of one room, merged from every response that described it. */
interface CachedRoom {
    roomId: string;
    summary: Partial<
        Pick<
            MSC3575RoomData,
            | "name"
            | "heroes"
            | "joined_count"
            | "invited_count"
            | "notification_count"
            | "highlight_count"
            | "bump_stamp"
            | "is_dm"
        >
    >;
    /** The room's current state, by type and state key. */
    state: Record<string, RoomEventJson>;
    /** The newest events, oldest first. */
    timeline: RoomEventJson[];
    /** The token for history before `timeline`, when `timeline` starts where a server response started. */
    prevBatch: string | null;
    /** Room account data, by type. */
    accountData: Record<string, IMinimalEvent>;
    /** The user's own receipts: receipt type and thread, then the event and timestamp. */
    receipts: Record<string, { eventId: string; type: string; threadId?: string; ts: number }>;
    /** What the room's notification counts were worked out from, when they are worked out on this device. */
    counts?: SavedLedger;
}

/**
 * Gives a room's notification count ledger to save: undefined when there is none, "pending" while its counts are
 * being worked out, and "unfinished" when they never will be, such as once sync stopped half way through a response.
 * A room is never written with a ledger that does not match it: its last written record stands instead.
 */
export type CountsSource = (roomId: string) => SavedLedger | undefined | "pending" | "unfinished";

const SCHEMA_VERSION = 1;
const DATABASE_PREFIX = "aether-sliding-sync:";
const ROOMS = "rooms";
const META = "meta";

/** Events kept per room. Enough to open it showing a screenful while the session starts. */
const TIMELINE_LIMIT = 30;
/** Rooms beyond this many, by recent activity, keep only their latest event: enough for the room list. */
const ROOMS_WITH_HISTORY = 300;
/** Events of a quiet room's notification count ledger that are kept. */
const QUIET_ROOM_COUNT_EVENTS = 30;
/** How long changes are held before being written together. */
const WRITE_DELAY_MS = 1500;

function stateKeyOf(event: RoomEventJson): string | undefined {
    return "state_key" in event && typeof event.state_key === "string"
        ? `${event.type}\u0000${event.state_key}`
        : undefined;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = (): void => resolve(request.result);
        request.onerror = (): void => reject(request.error);
    });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = (): void => resolve();
        transaction.onabort = (): void => reject(transaction.error);
        transaction.onerror = (): void => reject(transaction.error);
    });
}

/**
 * Keeps, on this device, what sliding sync last told us about each room and the account, so the next start can
 * show the rooms straight away and only then ask the server what changed.
 *
 * It keeps what a regular sync's cache keeps: room state, the newest events exactly as the server sent them
 * (encrypted events stay encrypted), unread counts, account data and the user's own receipts. Rooms the user leaves
 * are dropped. The data lives in one IndexedDB database per session, deleted with the session's other stores on
 * logout ({@link deleteAll}).
 */
export class SlidingSyncCache {
    /** Caches in use in this window, so deleting the saved data can stop them first. */
    private static readonly live = new Set<SlidingSyncCache>();
    /** A deletion under way, which caches created meanwhile wait for. */
    private static deletion?: Promise<void>;

    private readonly rooms = new Map<string, CachedRoom>();
    private readonly accountData = new Map<string, IMinimalEvent>();
    private readonly dirtyRooms = new Set<string>();
    private readonly removedRooms = new Set<string>();
    /**
     * Rooms changed by the sync response being applied. They are written once it all is, so a saved room never has
     * a response's events without its receipts and counts; until then the room's last written record stands.
     */
    private readonly heldRooms = new Set<string>();
    private inResponse = false;
    private countsSource?: CountsSource;
    private loadedCounts: ReadonlyMap<string, SavedLedger> = new Map();
    private accountDataDirty = false;
    private database?: Promise<IDBDatabase | null>;
    // The database once open, so a write can be started in the calling task.
    private openDatabase?: IDBDatabase;
    private writeTimer?: ReturnType<typeof setTimeout>;
    private writing: Promise<void> = Promise.resolve();
    private loadedRoomIds: ReadonlySet<string> = new Set();
    // The snapshot handed to the SDK. It applies some rooms in the background, reading each at its turn, so a room
    // dropped from here before then is never shown.
    private loadedSnapshot?: SlidingSyncSnapshot;
    private disposed = false;
    // The deletion under way when this cache was created, which it waits for before opening its database. Caches
    // that exist when a deletion starts are stopped by it instead, so they never wait for it.
    private deletionUnderWay?: Promise<void>;

    /**
     * @param userId - Whose session this is.
     * @param deviceId - The session's device.
     */
    public constructor(
        private readonly userId: string,
        private readonly deviceId: string,
    ) {
        SlidingSyncCache.live.add(this);
        this.deletionUnderWay = SlidingSyncCache.deletion;
    }

    /** The database name for a session. */
    public static databaseName(userId: string, deviceId: string): string {
        return `${DATABASE_PREFIX}${userId}:${deviceId}`;
    }

    /**
     * Delete every session's saved sliding sync data, such as on logout. Caches in use stop first and drop what they
     * had yet to write, so nothing is written back afterwards. Caches in other windows stop when their database is
     * deleted.
     */
    public static deleteAll(): Promise<void> {
        // The caches in use stop at once, so none writes again. Deletions follow one another, and caches created
        // from now on wait for this one before opening their database.
        const stopping = Promise.all([...SlidingSyncCache.live].map((cache) => cache.invalidate()));
        const deletion = (SlidingSyncCache.deletion ?? Promise.resolve()).then(async () => {
            await stopping;
            await SlidingSyncCache.deleteDatabases();
        });
        const finished = deletion.catch(() => undefined);
        SlidingSyncCache.deletion = finished;
        void finished.then(() => {
            if (SlidingSyncCache.deletion === finished) SlidingSyncCache.deletion = undefined;
        });
        return deletion;
    }

    private static async deleteDatabases(): Promise<void> {
        if (typeof indexedDB === "undefined" || typeof indexedDB.databases !== "function") return;
        const databases = await indexedDB.databases();
        await Promise.all(
            databases
                .filter((database) => database.name?.startsWith(DATABASE_PREFIX))
                .map((database) => requestToPromise(indexedDB.deleteDatabase(database.name!)).catch(() => undefined)),
        );
    }

    /**
     * Read what the last session saved, in the form the SDK restores before its first sliding sync request.
     * @returns The saved rooms and account data, or null when nothing usable is saved.
     */
    public async load(): Promise<SlidingSyncSnapshot | null> {
        const database = await this.open();
        if (!database || this.disposed) return null;
        try {
            const transaction = database.transaction([ROOMS, META], "readonly");
            const [rooms, meta] = await Promise.all([
                requestToPromise(transaction.objectStore(ROOMS).getAll() as IDBRequest<CachedRoom[]>),
                requestToPromise(transaction.objectStore(META).get("accountData") as IDBRequest<IMinimalEvent[]>),
            ]);
            for (const room of rooms) if (!this.rooms.has(room.roomId)) this.rooms.set(room.roomId, room);
            for (const event of meta ?? [])
                if (!this.accountData.has(event.type)) this.accountData.set(event.type, event);
            this.loadedRoomIds = new Set(rooms.map((room) => room.roomId));
            this.loadedCounts = new Map(
                rooms.filter((room) => room.counts).map((room) => [room.roomId, room.counts!] as const),
            );
            if (rooms.length === 0) return null;
            this.loadedSnapshot = this.snapshot(rooms);
            return this.loadedSnapshot;
        } catch (error) {
            logger.warn("SlidingSyncCache: could not read saved rooms", error);
            return null;
        }
    }

    /** Whether this cache has stopped, such as because its saved data was deleted at logout. */
    public get isClosed(): boolean {
        return this.disposed;
    }

    /** The rooms {@link load} found saved. */
    public get restoredRoomIds(): ReadonlySet<string> {
        return this.loadedRoomIds;
    }

    /** The notification count ledgers {@link load} found saved, by room. */
    public get restoredCounts(): ReadonlyMap<string, SavedLedger> {
        return this.loadedCounts;
    }

    /** Where to read each room's notification count ledger from when saving it. */
    public setCountsSource(source: CountsSource | undefined): void {
        this.countsSource = source;
    }

    /**
     * Save a room's notification count ledger again, read from the {@link setCountsSource} when written.
     * @param roomId - The room.
     */
    public observeCounts(roomId: string): void {
        if (this.disposed || !this.rooms.has(roomId)) return;
        this.markRoom(roomId);
    }

    /** A sync response is being applied: the rooms it changes wait for {@link endResponse}. */
    public beginResponse(): void {
        this.inResponse = true;
    }

    /** The sync response is applied, receipts included: the rooms it changed can be written. */
    public endResponse(): void {
        this.inResponse = false;
        if (this.heldRooms.size === 0) return;
        this.heldRooms.clear();
        this.scheduleWrite();
    }

    /**
     * Merge what a response said about a room.
     * @param roomId - The room.
     * @param data - The room's data in the response.
     */
    public observeRoomData(roomId: string, data: MSC3575RoomData): void {
        if (this.disposed) return;
        const room: CachedRoom = this.rooms.get(roomId) ?? {
            roomId,
            summary: {},
            state: {},
            timeline: [],
            prevBatch: null,
            accountData: {},
            receipts: {},
        };
        for (const key of [
            "name",
            "heroes",
            "joined_count",
            "invited_count",
            "notification_count",
            "highlight_count",
            "bump_stamp",
            "is_dm",
        ] as const) {
            if (data[key] !== undefined) (room.summary as Record<string, unknown>)[key] = data[key];
        }
        const timeline = data.timeline ?? [];
        if (data.invite_state) {
            // Invites are not kept: the server sends them at once, and one declined elsewhere must not linger.
            this.forgetRooms([roomId]);
            return;
        }
        for (const event of [...(data.required_state ?? []), ...timeline]) {
            const key = stateKeyOf(event);
            if (key) room.state[key] = event;
        }

        if (timeline.length > 0) {
            if (data.limited || data.initial || data.expanded_timeline || data.unstable_expanded_timeline) {
                // A fresh view of the room's newest events: it replaces what was kept.
                room.timeline = timeline.slice(-TIMELINE_LIMIT);
                room.prevBatch = timeline.length <= TIMELINE_LIMIT ? (data.prev_batch ?? null) : null;
            } else {
                const known = new Set(room.timeline.map((event) => event.event_id));
                room.timeline.push(...timeline.filter((event) => !known.has(event.event_id)));
                if (room.timeline.length > TIMELINE_LIMIT) {
                    // History before the kept events is no longer where the token points.
                    room.timeline = room.timeline.slice(-TIMELINE_LIMIT);
                    room.prevBatch = null;
                }
            }
        }

        if (this.hasLeft(room)) {
            this.forgetRooms([roomId]);
            return;
        }
        this.rooms.set(roomId, room);
        this.markRoom(roomId);
    }

    /**
     * Keep a global account data event.
     * @param event - The event.
     */
    public observeAccountData(event: MatrixEvent): void {
        if (this.disposed) return;
        this.accountData.set(event.getType(), { type: event.getType(), content: event.getContent() });
        this.accountDataDirty = true;
        this.scheduleWrite();
    }

    /**
     * Keep a room account data event, such as the fully-read marker or a manual unread flag.
     * @param roomId - The room.
     * @param event - The event.
     */
    public observeRoomAccountData(roomId: string, event: MatrixEvent): void {
        const room = this.rooms.get(roomId);
        if (this.disposed || !room) return;
        room.accountData[event.getType()] = { type: event.getType(), content: event.getContent() };
        this.markRoom(roomId);
    }

    /**
     * Keep the user's own receipts from a receipt event, so restored rooms show the right unread state.
     * @param roomId - The room.
     * @param event - An `m.receipt` event.
     */
    public observeReceipt(roomId: string, event: MatrixEvent): void {
        const room = this.rooms.get(roomId);
        if (this.disposed || !room || event.getType() !== EventType.Receipt) return;
        let changed = false;
        const content =
            event.getContent<Record<string, Record<string, Record<string, { ts?: number; thread_id?: string }>>>>();
        for (const [eventId, byType] of Object.entries(content)) {
            for (const [type, byUser] of Object.entries(byType ?? {})) {
                const mine = byUser?.[this.userId];
                if (!mine) continue;
                const key = `${type}\u0000${mine.thread_id ?? ""}`;
                const ts = mine.ts ?? 0;
                if ((room.receipts[key]?.ts ?? -1) > ts) continue;
                room.receipts[key] = { eventId, type, threadId: mine.thread_id, ts };
                changed = true;
            }
        }
        if (changed) this.markRoom(roomId);
    }

    /**
     * Drop rooms, such as ones the server no longer lists for the user.
     * @param roomIds - The rooms.
     */
    public forgetRooms(roomIds: Iterable<string>): void {
        for (const roomId of roomIds) {
            this.rooms.delete(roomId);
            this.dirtyRooms.delete(roomId);
            this.heldRooms.delete(roomId);
            this.removedRooms.add(roomId);
            delete this.loadedSnapshot?.rooms[roomId];
        }
        this.scheduleWrite();
    }

    /** Write pending changes now. */
    public async flush(): Promise<void> {
        if (this.writeTimer !== undefined) clearTimeout(this.writeTimer);
        this.writeTimer = undefined;
        this.writing = this.writing.then(() => this.write());
        return this.writing;
    }

    /** Write pending changes, then stop accepting more. */
    public async dispose(): Promise<void> {
        if (this.disposed) return;
        await this.flush();
        this.disposed = true;
        SlidingSyncCache.live.delete(this);
        const database = await this.database;
        database?.close();
    }

    /**
     * Stop for good without writing anything more: the saved data is being deleted. Pending changes are dropped and
     * a write already under way is waited for, so it cannot land after the deletion.
     */
    private async invalidate(): Promise<void> {
        this.disposed = true;
        SlidingSyncCache.live.delete(this);
        if (this.writeTimer !== undefined) clearTimeout(this.writeTimer);
        this.writeTimer = undefined;
        this.dirtyRooms.clear();
        this.removedRooms.clear();
        this.heldRooms.clear();
        this.accountDataDirty = false;
        this.rooms.clear();
        this.accountData.clear();
        await this.writing.catch(() => undefined);
        const database = await this.database;
        database?.close();
    }

    private snapshot(rooms: CachedRoom[]): SlidingSyncSnapshot {
        const snapshot: Required<Omit<SlidingSyncSnapshot, "priorityRoomIds">> = {
            rooms: {},
            accountData: [...this.accountData.values()],
            roomAccountData: {},
            receipts: {},
        };
        for (const room of rooms) {
            const prevBatch = room.prevBatch ?? undefined;
            snapshot.rooms[room.roomId] = {
                ...room.summary,
                // Without a token the timeline is shown without older history until the server's first response
                // reaches back to it, which brings a token.
                limited: prevBatch !== undefined,
                prev_batch: prevBatch,
                required_state: Object.values(room.state),
                timeline: room.timeline,
            } as MSC3575RoomData;
            const accountData = Object.values(room.accountData);
            if (accountData.length > 0) snapshot.roomAccountData[room.roomId] = accountData;
            const receipts = Object.values(room.receipts);
            if (receipts.length > 0) {
                const content: Record<string, Record<string, Record<string, { ts: number; thread_id?: string }>>> = {};
                for (const { eventId, type, threadId, ts } of receipts) {
                    ((content[eventId] ??= {})[type] ??= {})[this.userId] = {
                        ts,
                        ...(threadId ? { thread_id: threadId } : {}),
                    };
                }
                snapshot.receipts[room.roomId] = { type: EventType.Receipt, content };
            }
        }
        return snapshot;
    }

    private hasLeft(room: CachedRoom): boolean {
        const membership = room.state[`${EventType.RoomMember}\u0000${this.userId}`]?.content?.membership;
        return membership === "leave" || membership === "ban";
    }

    private markRoom(roomId: string): void {
        this.removedRooms.delete(roomId);
        this.dirtyRooms.add(roomId);
        if (this.inResponse) this.heldRooms.add(roomId);
        this.scheduleWrite();
    }

    private scheduleWrite(): void {
        if (this.disposed || this.writeTimer !== undefined) return;
        this.writeTimer = setTimeout(() => {
            this.writeTimer = undefined;
            void this.flush();
        }, WRITE_DELAY_MS);
    }

    /** Keep the history of the most recently active rooms only, so the cache stays small on big accounts. */
    private trimQuietRooms(): void {
        if (this.rooms.size <= ROOMS_WITH_HISTORY) return;
        const byActivity = [...this.rooms.values()].sort(
            (a, b) => (b.summary.bump_stamp ?? 0) - (a.summary.bump_stamp ?? 0),
        );
        for (const room of byActivity.slice(ROOMS_WITH_HISTORY)) {
            if (room.counts) room.counts = trimSavedLedger(room.counts, QUIET_ROOM_COUNT_EVENTS);
            if (room.timeline.length <= 1) continue;
            room.timeline = room.timeline.slice(-1);
            room.prevBatch = null;
            if (!this.dirtyRooms.has(room.roomId)) {
                this.dirtyRooms.add(room.roomId);
                this.scheduleWrite();
            }
        }
    }

    /**
     * Write pending changes in the calling task, as when the page is being closed: a write that starts later, after
     * another task has run, may never happen. Before the database is open, this is {@link flush}.
     */
    public flushNow(): void {
        if (this.writeTimer !== undefined) clearTimeout(this.writeTimer);
        this.writeTimer = undefined;
        const database = this.openDatabase;
        if (!database || this.disposed) {
            void this.flush();
            return;
        }
        // Write transactions on the same stores commit in the order they are created, so this lands after any write
        // already under way, which took the changes before these.
        const written = this.writePending(database);
        this.writing = this.writing.then(() => written);
    }

    private async write(): Promise<void> {
        if (this.disposed) return;
        if (!this.hasPendingWrites()) return;
        const database = await this.open();
        // Stopped while the database opened, such as by a logout deleting it.
        if (!database || this.disposed) return;
        await this.writePending(database);
    }

    /** Put the pending changes in a transaction straight away, and wait for it to finish. */
    private async writePending(database: IDBDatabase): Promise<void> {
        if (!this.hasPendingWrites()) return;
        const dirty = this.readyRooms();
        // After the ledgers are read, so those written are trimmed too. Rooms this trims are written next time.
        this.trimQuietRooms();
        const removed = [...this.removedRooms];
        const accountDataDirty = this.accountDataDirty;
        this.removedRooms.clear();
        this.accountDataDirty = false;
        try {
            const transaction = database.transaction([ROOMS, META], "readwrite");
            const rooms = transaction.objectStore(ROOMS);
            for (const roomId of dirty) {
                const room = this.rooms.get(roomId);
                if (room) rooms.put(room);
            }
            for (const roomId of removed) rooms.delete(roomId);
            if (accountDataDirty) transaction.objectStore(META).put([...this.accountData.values()], "accountData");
            // Nothing more is added, so it can commit now rather than at the end of the task.
            transaction.commit?.();
            await transactionDone(transaction);
        } catch (error) {
            // Writing again later would hit the same problem; the next session starts from the server instead.
            logger.warn("SlidingSyncCache: could not save rooms", error);
        }
    }

    private hasPendingWrites(): boolean {
        return this.dirtyRooms.size > 0 || this.removedRooms.size > 0 || this.accountDataDirty;
    }

    /**
     * The changed rooms that can be written now, each with its notification count ledger as last published. One
     * changed by a response still being applied, or whose counts are being worked out, waits: its last written
     * record stands until then.
     */
    private readyRooms(): string[] {
        const ready: string[] = [];
        let waiting = false;
        const unfinished: string[] = [];
        for (const roomId of this.dirtyRooms) {
            if (this.heldRooms.has(roomId)) continue;
            const saved = this.countsSource?.(roomId);
            if (saved === "pending") {
                waiting = true;
                continue;
            }
            if (saved === "unfinished") {
                unfinished.push(roomId);
                continue;
            }
            const room = this.rooms.get(roomId);
            // A room not counted yet, such as one still to be restored, keeps the ledger saved with it.
            if (room && saved) room.counts = saved;
            ready.push(roomId);
        }
        for (const roomId of [...ready, ...unfinished]) this.dirtyRooms.delete(roomId);
        if (waiting) this.scheduleWrite();
        return ready;
    }

    private open(): Promise<IDBDatabase | null> {
        // A stopped cache never opens, or reopens, the database: that would recreate deleted data.
        if (this.disposed) return Promise.resolve(null);
        // A cache created during a deletion opens once it has finished, so it never reads deleted data. Only the
        // open request itself is kept, so a later deletion stopping this cache never waits for itself.
        const deletion = this.deletionUnderWay;
        if (deletion) {
            return deletion.then(() => {
                this.deletionUnderWay = undefined;
                return this.open();
            });
        }
        this.database ??= new Promise<IDBDatabase | null>((resolve) => {
            if (typeof indexedDB === "undefined") {
                resolve(null);
                return;
            }
            let request: IDBOpenDBRequest;
            try {
                request = indexedDB.open(SlidingSyncCache.databaseName(this.userId, this.deviceId), SCHEMA_VERSION);
            } catch (error) {
                logger.warn("SlidingSyncCache: storage unavailable", error);
                resolve(null);
                return;
            }
            request.onupgradeneeded = (): void => {
                const database = request.result;
                for (const name of Array.from(database.objectStoreNames)) database.deleteObjectStore(name);
                database.createObjectStore(ROOMS, { keyPath: "roomId" });
                database.createObjectStore(META);
            };
            request.onsuccess = (): void => {
                const database = request.result;
                // Another window is deleting the database (a logout) or replacing its schema: stop, without writing
                // anything more, so the data is not recreated.
                database.onversionchange = (): void => {
                    database.close();
                    this.openDatabase = undefined;
                    void this.invalidate();
                };
                this.openDatabase = database;
                resolve(database);
            };
            request.onerror = (): void => {
                logger.warn("SlidingSyncCache: storage unavailable", request.error);
                resolve(null);
            };
        });
        return this.database;
    }
}
