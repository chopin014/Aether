/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import "fake-indexeddb/auto";

import { afterEach, describe, expect, it, vi } from "vitest";
import { EventType, MatrixEvent } from "matrix-js-sdk/src/matrix";
import { type MSC3575RoomData } from "matrix-js-sdk/src/sliding-sync";

import { SlidingSyncCache } from "./SlidingSyncCache";
import { type SavedEvent, type SavedLedger } from "./notification-counts/RoomCountLedger";

const userId = "@alice:example.org";
const deviceId = "DEVICE";
const roomId = "!room:example.org";

type TimelineEvent = NonNullable<MSC3575RoomData["timeline"]>[number];

const message = (id: string, ts = 1): TimelineEvent => ({
    type: EventType.RoomMessage,
    event_id: id,
    sender: "@bob:example.org",
    origin_server_ts: ts,
    content: { msgtype: "m.text", body: id },
});

const member = (membership: string): TimelineEvent => ({
    type: EventType.RoomMember,
    state_key: userId,
    event_id: `$member-${membership}`,
    sender: userId,
    origin_server_ts: 1,
    content: { membership },
});

const roomName = (name: string, id = `$name-${name}`): TimelineEvent => ({
    type: EventType.RoomName,
    state_key: "",
    event_id: id,
    sender: userId,
    origin_server_ts: 1,
    content: { name },
});

const data = (fields: Partial<MSC3575RoomData>): MSC3575RoomData =>
    ({ name: "Room", required_state: [], timeline: [], ...fields }) as MSC3575RoomData;

/** Write the first cache, then read it back with a second one, as the next start would. */
async function reopen(cache: SlidingSyncCache): Promise<SlidingSyncCache> {
    await cache.flush();
    await cache.dispose();
    return new SlidingSyncCache(userId, deviceId);
}

describe("SlidingSyncCache", () => {
    afterEach(async () => {
        await SlidingSyncCache.deleteAll();
    });

    it("has nothing to show before anything was saved", async () => {
        const cache = new SlidingSyncCache(userId, deviceId);
        await expect(cache.load()).resolves.toBeNull();
        expect(cache.restoredRoomIds.size).toBe(0);
        await cache.dispose();
    });

    it("saves what the server said about a room and returns it as the SDK restores it", async () => {
        const cache = new SlidingSyncCache(userId, deviceId);
        cache.observeRoomData(
            roomId,
            data({
                name: "General",
                initial: true,
                limited: true,
                prev_batch: "token",
                notification_count: 3,
                bump_stamp: 7,
                required_state: [member("join") as never, roomName("General") as never],
                timeline: [message("$a"), message("$b")],
            }),
        );
        // A later incremental update appends, and a renaming state event in the timeline updates the state.
        cache.observeRoomData(
            roomId,
            data({ timeline: [message("$b"), message("$c"), roomName("Lounge", "$rename")] }),
        );

        const next = await reopen(cache);
        const snapshot = (await next.load())!;
        const room = snapshot.rooms[roomId];
        expect(room.timeline.map((event) => event.event_id)).toEqual(["$a", "$b", "$c", "$rename"]);
        expect(room.prev_batch).toBe("token");
        expect(room.limited).toBe(true);
        expect(room.notification_count).toBe(3);
        expect(room.bump_stamp).toBe(7);
        const names = room.required_state.filter((event) => event.type === EventType.RoomName);
        expect(names.map((event) => event.content.name)).toEqual(["Lounge"]);
        expect(next.restoredRoomIds).toEqual(new Set([roomId]));
    });

    it("replaces the kept events with a fresh view, and forgets the token when it no longer points before them", async () => {
        const cache = new SlidingSyncCache(userId, deviceId);
        cache.observeRoomData(roomId, data({ limited: true, prev_batch: "old", timeline: [message("$a")] }));
        cache.observeRoomData(roomId, data({ limited: true, prev_batch: "new", timeline: [message("$x")] }));
        let snapshot = (await (await reopen(cache)).load())!;
        expect(snapshot.rooms[roomId].timeline.map((event) => event.event_id)).toEqual(["$x"]);
        expect(snapshot.rooms[roomId].prev_batch).toBe("new");

        const busy = new SlidingSyncCache(userId, deviceId);
        await busy.load();
        busy.observeRoomData(roomId, data({ timeline: Array.from({ length: 40 }, (_, i) => message(`$m${i}`)) }));
        snapshot = (await (await reopen(busy)).load())!;
        expect(snapshot.rooms[roomId].timeline).toHaveLength(30);
        expect(snapshot.rooms[roomId].timeline.at(-1)?.event_id).toBe("$m39");
        expect(snapshot.rooms[roomId].prev_batch).toBeUndefined();
        expect(snapshot.rooms[roomId].limited).toBe(false);
    });

    it("keeps no invites, keeps a room once it is joined, and drops rooms the user left", async () => {
        const cache = new SlidingSyncCache(userId, deviceId);
        cache.observeRoomData(roomId, data({ invite_state: [member("invite") as never] }));
        cache.observeRoomData("!left:example.org", data({ required_state: [member("join") as never] }));
        cache.observeRoomData("!left:example.org", data({ timeline: [member("leave")] }));
        let next = await reopen(cache);
        await expect(next.load()).resolves.toBeNull();

        next.observeRoomData(roomId, data({ required_state: [member("join") as never], timeline: [message("$a")] }));
        next = await reopen(next);
        const snapshot = (await next.load())!;
        expect(Object.keys(snapshot.rooms)).toEqual([roomId]);
        await next.dispose();
    });

    it("keeps account data and only the user's own receipts", async () => {
        const cache = new SlidingSyncCache(userId, deviceId);
        cache.observeRoomData(roomId, data({ timeline: [message("$a")] }));
        cache.observeAccountData(
            new MatrixEvent({ type: EventType.Direct, content: { "@bob:example.org": [roomId] } }),
        );
        cache.observeRoomAccountData(
            roomId,
            new MatrixEvent({ type: EventType.FullyRead, content: { event_id: "$a" }, room_id: roomId }),
        );
        cache.observeReceipt(
            roomId,
            new MatrixEvent({
                type: EventType.Receipt,
                content: {
                    $a: {
                        "m.read": { [userId]: { ts: 5 }, "@bob:example.org": { ts: 6 } },
                    },
                },
            }),
        );
        // An older receipt does not replace a newer one.
        cache.observeReceipt(
            roomId,
            new MatrixEvent({ type: EventType.Receipt, content: { $older: { "m.read": { [userId]: { ts: 1 } } } } }),
        );

        const snapshot = (await (await reopen(cache)).load())!;
        expect(snapshot.accountData).toEqual([{ type: EventType.Direct, content: { "@bob:example.org": [roomId] } }]);
        expect(snapshot.roomAccountData?.[roomId]).toEqual([
            { type: EventType.FullyRead, content: { event_id: "$a" } },
        ]);
        expect(snapshot.receipts?.[roomId]).toEqual({
            type: EventType.Receipt,
            content: { $a: { "m.read": { [userId]: { ts: 5 } } } },
        });
    });

    it("keeps only the latest event of quiet rooms on big accounts", async () => {
        const cache = new SlidingSyncCache(userId, deviceId);
        for (let i = 0; i < 302; i++) {
            cache.observeRoomData(
                `!r${i}:example.org`,
                data({
                    bump_stamp: i,
                    limited: true,
                    prev_batch: `t${i}`,
                    timeline: [message(`$${i}a`), message(`$${i}b`)],
                }),
            );
        }
        const snapshot = (await (await reopen(cache)).load())!;
        expect(snapshot.rooms["!r301:example.org"].timeline).toHaveLength(2);
        expect(snapshot.rooms["!r0:example.org"].timeline.map((event) => event.event_id)).toEqual(["$0b"]);
        expect(snapshot.rooms["!r0:example.org"].prev_batch).toBeUndefined();
    });

    it("saves each room's notification count ledger with it, and not the room while its counts are pending", async () => {
        const cache = new SlidingSyncCache(userId, deviceId);
        const ledger: SavedLedger = {
            version: 1,
            segments: [[["$a", 8 | 16 | 64]]],
            receipts: { main: { public: { best: "$z" } } },
            receiptsComplete: true,
        };
        let saved: SavedLedger | "pending" = ledger;
        cache.setCountsSource((id) => (id === roomId ? saved : undefined));
        cache.observeRoomData(roomId, data({ initial: true, timeline: [message("$a")] }));
        cache.observeCounts(roomId);
        await cache.flush();

        // New events arrive while their counts are worked out: the room's record stays as it was.
        saved = "pending";
        cache.observeRoomData(roomId, data({ timeline: [message("$b")] }));
        await cache.flush();
        let next = await reopen(cache);
        let snapshot = (await next.load())!;
        expect(snapshot.rooms[roomId].timeline.map((event) => event.event_id)).toEqual(["$a"]);
        expect(next.restoredCounts).toEqual(new Map([[roomId, ledger]]));

        // Once they are worked out, both are written.
        const later: SavedLedger = {
            ...ledger,
            segments: [
                [
                    ["$a", 8],
                    ["$b", 8 | 16 | 64],
                ],
            ],
        };
        saved = later;
        next.setCountsSource(() => later);
        next.observeRoomData(roomId, data({ timeline: [message("$b")] }));
        next = await reopen(next);
        snapshot = (await next.load())!;
        expect(snapshot.rooms[roomId].timeline.map((event) => event.event_id)).toEqual(["$a", "$b"]);
        expect(next.restoredCounts).toEqual(new Map([[roomId, later]]));
        // A room the cache does not keep has no ledger saved either.
        next.observeCounts("!unknown:example.org");
        await next.dispose();
    });

    it("writes a room a sync response changed only once the whole response is applied", async () => {
        const cache = new SlidingSyncCache(userId, deviceId);
        cache.observeRoomData(roomId, data({ initial: true, timeline: [message("$a")] }));
        await cache.flush();

        cache.beginResponse();
        cache.observeRoomData(roomId, data({ timeline: [message("$b")] }));
        // Not even when the page closes half way: the room keeps its last whole record.
        cache.flushNow();
        await cache.flush();
        const reader = new SlidingSyncCache(userId, deviceId);
        expect((await reader.load())!.rooms[roomId].timeline.map((event) => event.event_id)).toEqual(["$a"]);
        await reader.dispose();

        cache.endResponse();
        const next = await reopen(cache);
        expect((await next.load())!.rooms[roomId].timeline.map((event) => event.event_id)).toEqual(["$a", "$b"]);
        await next.dispose();
    });

    it("keeps only the newest events of a quiet room's notification count ledger", async () => {
        const cache = new SlidingSyncCache(userId, deviceId);
        const events = Array.from({ length: 50 }, (_, i): SavedEvent => [`$e${i}`, 0]);
        cache.setCountsSource(() => ({ version: 1, segments: [events], receipts: {}, receiptsComplete: true }));
        for (let i = 0; i < 302; i++) {
            const id = `!r${i}:example.org`;
            cache.observeRoomData(id, data({ bump_stamp: i, timeline: [message(`$${i}a`)] }));
            cache.observeCounts(id);
        }
        const next = await reopen(cache);
        await next.load();

        expect(next.restoredCounts.get("!r301:example.org")?.segments[0]).toHaveLength(50);
        expect(next.restoredCounts.get("!r0:example.org")?.segments[0].map(([id]) => id)).toEqual(
            events.slice(-30).map(([id]) => id),
        );
        await next.dispose();
    });

    it("forgets rooms on request, and keeps sessions apart", async () => {
        const cache = new SlidingSyncCache(userId, deviceId);
        cache.observeRoomData(roomId, data({ timeline: [message("$a")] }));
        cache.observeRoomData("!other:example.org", data({ timeline: [message("$b")] }));
        cache.forgetRooms([roomId]);
        const snapshot = (await (await reopen(cache)).load())!;
        expect(Object.keys(snapshot.rooms)).toEqual(["!other:example.org"]);

        const otherSession = new SlidingSyncCache(userId, "OTHER");
        await expect(otherSession.load()).resolves.toBeNull();
        await otherSession.dispose();
    });

    it("drops a forgotten room from the snapshot it handed out, so a room restored later is not shown", async () => {
        const cache = new SlidingSyncCache(userId, deviceId);
        cache.observeRoomData(roomId, data({ timeline: [message("$a")] }));
        cache.observeRoomData("!other:example.org", data({ timeline: [message("$b")] }));
        const reopened = await reopen(cache);
        const snapshot = (await reopened.load())!;
        reopened.forgetRooms([roomId]);
        expect(Object.keys(snapshot.rooms)).toEqual(["!other:example.org"]);
        await reopened.dispose();
    });

    it("starts writing in the calling task when the page closes, so the write is not lost", async () => {
        const cache = new SlidingSyncCache(userId, deviceId);
        // The database is open once anything has been read or written.
        await cache.load();
        cache.observeRoomData(roomId, data({ timeline: [message("$a")] }));
        const transaction = vi.spyOn(IDBDatabase.prototype, "transaction");
        cache.flushNow();
        // Created before any other task or microtask could run.
        expect(transaction).toHaveBeenCalledWith(["rooms", "meta"], "readwrite");
        transaction.mockRestore();
        const snapshot = (await (await reopen(cache)).load())!;
        expect(snapshot.rooms[roomId].timeline.map((event) => event.event_id)).toEqual(["$a"]);
    });

    it("still writes when the page closes before the database has opened", async () => {
        const cache = new SlidingSyncCache(userId, deviceId);
        cache.observeRoomData(roomId, data({ timeline: [message("$a")] }));
        cache.flushNow();
        const snapshot = (await (await reopen(cache)).load())!;
        expect(Object.keys(snapshot.rooms)).toEqual([roomId]);
    });

    it("keeps the newest data when a closing write follows one already under way", async () => {
        const cache = new SlidingSyncCache(userId, deviceId);
        await cache.load();
        cache.observeRoomData(roomId, data({ name: "First", timeline: [message("$a")] }));
        const earlier = cache.flush();
        cache.observeRoomData(roomId, data({ name: "Second", timeline: [message("$b")] }));
        cache.flushNow();
        await earlier;
        const snapshot = (await (await reopen(cache)).load())!;
        expect(snapshot.rooms[roomId].name).toBe("Second");
        expect(snapshot.rooms[roomId].timeline.map((event) => event.event_id)).toEqual(["$a", "$b"]);
    });

    it("writes nothing more once its saved data has been deleted, such as at logout", async () => {
        const cache = new SlidingSyncCache(userId, deviceId);
        await cache.load();
        cache.observeRoomData(roomId, data({ timeline: [message("$private")] }));
        await SlidingSyncCache.deleteAll();
        // Pending writes, later changes and page-hide flushes must not recreate the data.
        cache.observeRoomData(roomId, data({ timeline: [message("$later")] }));
        await cache.flush();
        await new Promise((resolve) => setTimeout(resolve, 1600));
        const next = new SlidingSyncCache(userId, deviceId);
        await expect(next.load()).resolves.toBeNull();
        await next.dispose();
    });

    it("stops writing when another window deletes the saved data", async () => {
        const cache = new SlidingSyncCache(userId, deviceId);
        cache.observeRoomData(roomId, data({ timeline: [message("$a")] }));
        await cache.flush();
        cache.observeRoomData(roomId, data({ timeline: [message("$b")] }));
        // Another window deletes the database directly, without this window's cache knowing.
        await new Promise<void>((resolve, reject) => {
            const request = indexedDB.deleteDatabase(SlidingSyncCache.databaseName(userId, deviceId));
            request.onsuccess = (): void => resolve();
            request.onerror = (): void => reject(request.error);
        });
        await cache.flush();
        const next = new SlidingSyncCache(userId, deviceId);
        await expect(next.load()).resolves.toBeNull();
        await next.dispose();
    });

    it("shows nothing a deletion under way removes to a cache opened meanwhile, which then keeps working", async () => {
        const cache = new SlidingSyncCache(userId, deviceId);
        cache.observeRoomData(roomId, data({ timeline: [message("$a")] }));
        await cache.flush();
        // A write is under way when the deletion starts, and the next session's cache reads during it.
        cache.observeRoomData(roomId, data({ timeline: [message("$b")] }));
        const writing = cache.flush();
        const deletion = SlidingSyncCache.deleteAll();
        const next = new SlidingSyncCache(userId, deviceId);
        const loaded = next.load();
        await Promise.all([writing, deletion]);
        await expect(loaded).resolves.toBeNull();
        expect(next.isClosed).toBe(false);
        next.observeRoomData("!next:example.org", data({ timeline: [message("$c")] }));
        await next.flush();
        await next.dispose();
        const after = new SlidingSyncCache(userId, deviceId);
        expect(Object.keys((await after.load())?.rooms ?? {})).toEqual(["!next:example.org"]);
        await after.dispose();
    });

    it("finishes deletions that overlap, while a cache waits for them to open", async () => {
        const cache = new SlidingSyncCache(userId, deviceId);
        cache.observeRoomData(roomId, data({ timeline: [message("$a")] }));
        await cache.flush();
        const first = SlidingSyncCache.deleteAll();
        const waiting = new SlidingSyncCache(userId, deviceId);
        const loaded = waiting.load();
        // The second deletion stops the waiting cache, which must not wait for the deletion in turn.
        const second = SlidingSyncCache.deleteAll();
        await Promise.all([first, second]);
        await expect(loaded).resolves.toBeNull();
        expect(waiting.isClosed).toBe(true);
    });

    it("deletes every session's saved data", async () => {
        const cache = new SlidingSyncCache(userId, deviceId);
        cache.observeRoomData(roomId, data({ timeline: [message("$a")] }));
        await cache.dispose();
        await SlidingSyncCache.deleteAll();
        const next = new SlidingSyncCache(userId, deviceId);
        await expect(next.load()).resolves.toBeNull();
        await next.dispose();
    });
});
