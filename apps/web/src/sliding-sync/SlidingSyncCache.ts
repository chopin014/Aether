/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { EventType, type IMinimalEvent, type MatrixEvent } from "matrix-js-sdk/src/matrix";
import { type MSC3575RoomData, type SlidingSyncSnapshot } from "matrix-js-sdk/src/sliding-sync";

import { logger } from "matrix-js-sdk/src/logger";

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
            | "invite_state"
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
}

const SCHEMA_VERSION = 1;
const DATABASE_PREFIX = "aether-sliding-sync:";
const ROOMS = "rooms";
const META = "meta";

/** Events kept per room. Enough to open it showing a screenful while the session starts. */
const TIMELINE_LIMIT = 30;
/** Rooms beyond this many, by recent activity, keep only their latest event: enough for the room list. */
const ROOMS_WITH_HISTORY = 300;
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
    private readonly rooms = new Map<string, CachedRoom>();
    private readonly accountData = new Map<string, IMinimalEvent>();
    private readonly dirtyRooms = new Set<string>();
    private readonly removedRooms = new Set<string>();
    private accountDataDirty = false;
    private database?: Promise<IDBDatabase | null>;
    private writeTimer?: ReturnType<typeof setTimeout>;
    private writing: Promise<void> = Promise.resolve();
    private loadedRoomIds: ReadonlySet<string> = new Set();
    private disposed = false;

    /**
     * @param userId - Whose session this is.
     * @param deviceId - The session's device.
     */
    public constructor(
        private readonly userId: string,
        private readonly deviceId: string,
    ) {}

    /** The database name for a session. */
    public static databaseName(userId: string, deviceId: string): string {
        return `${DATABASE_PREFIX}${userId}:${deviceId}`;
    }

    /** Delete every session's saved sliding sync data, such as on logout. */
    public static async deleteAll(): Promise<void> {
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
            if (rooms.length === 0) return null;
            return this.snapshot(rooms);
        } catch (error) {
            logger.warn("SlidingSyncCache: could not read saved rooms", error);
            return null;
        }
    }

    /** The rooms {@link load} found saved. */
    public get restoredRoomIds(): ReadonlySet<string> {
        return this.loadedRoomIds;
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
            room.summary.invite_state = data.invite_state;
        } else if ((data.required_state?.length ?? 0) > 0 || timeline.length > 0) {
            // A room the user has joined since it was an invite.
            delete room.summary.invite_state;
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
            this.removedRooms.add(roomId);
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
        const database = await this.database;
        database?.close();
    }

    private snapshot(rooms: CachedRoom[]): SlidingSyncSnapshot {
        const snapshot: Required<SlidingSyncSnapshot> = {
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
            if (room.timeline.length <= 1) continue;
            room.timeline = room.timeline.slice(-1);
            room.prevBatch = null;
            this.dirtyRooms.add(room.roomId);
        }
    }

    private async write(): Promise<void> {
        if (this.disposed) return;
        if (this.dirtyRooms.size === 0 && this.removedRooms.size === 0 && !this.accountDataDirty) return;
        const database = await this.open();
        if (!database) return;
        this.trimQuietRooms();
        const dirty = [...this.dirtyRooms];
        const removed = [...this.removedRooms];
        const accountDataDirty = this.accountDataDirty;
        this.dirtyRooms.clear();
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
            await transactionDone(transaction);
        } catch (error) {
            // Writing again later would hit the same problem; the next session starts from the server instead.
            logger.warn("SlidingSyncCache: could not save rooms", error);
        }
    }

    private open(): Promise<IDBDatabase | null> {
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
                // Let logout delete the database, or a newer schema replace it, without waiting for this session.
                database.onversionchange = (): void => {
                    database.close();
                    this.database = undefined;
                };
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
