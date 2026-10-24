/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it, vi } from "vitest";
import { MatrixEvent, type IEvent, type MatrixClient } from "matrix-js-sdk/src/matrix";

import { BrowseSearchSource, TextSearchSource } from "./searchSources";

const message = (id: string, room: string, ts: number, extra: Record<string, unknown> = {}): MatrixEvent =>
    new MatrixEvent({
        event_id: id,
        room_id: room,
        sender: "@a:x",
        type: "m.room.message",
        origin_server_ts: ts,
        content: { msgtype: "m.text", body: id, ...extra },
    });

describe("TextSearchSource", () => {
    const result = (events: MatrixEvent[], next?: string) =>
        ({
            results: events.map((event) => ({ context: { getEvent: () => event } })),
            next_batch: next,
            count: 7,
            highlights: ["w"],
        }) as any;

    it("searches first and paginates afterwards, returning only the new events each time", async () => {
        const a = message("$a", "!r:x", 3);
        const b = message("$b", "!r:x", 2);
        const first = result([a], "n1");
        const search = vi.fn().mockResolvedValue(first);
        const paginate = vi.fn().mockImplementation(async (_client, results) => {
            results.results.push(...result([b]).results);
            results.next_batch = undefined;
            return results;
        });
        const client = {} as MatrixClient;
        const signal = new AbortController().signal;
        const source = new TextSearchSource({
            client,
            term: "w",
            roomId: "!r:x",
            options: {},
            signal,
            search,
            paginate,
        });

        const one = await source.next();
        expect(search).toHaveBeenCalledWith(client, "w", "!r:x", signal, {});
        expect(one).toMatchObject({ events: [a], hasMore: true, count: 7, highlights: ["w"] });

        const two = await source.next();
        expect(paginate).toHaveBeenCalledOnce();
        expect(two.events).toEqual([b]);
        expect(two.hasMore).toBe(false);
    });
});

describe("BrowseSearchSource", () => {
    function clientFor(rooms: Record<string, MatrixEvent[][]>) {
        const calls: Array<{ roomId: string; token: string | null; filter: any }> = [];
        const cursor: Record<string, number> = {};
        const client = {
            getSafeUserId: () => "@me:x",
            isRoomEncrypted: () => false,
            getEventMapper: () => (raw: Partial<IEvent>) => new MatrixEvent(raw),
            decryptEventIfNeeded: vi.fn().mockResolvedValue(undefined),
            createMessagesRequest: vi.fn(async (roomId: string, token: string | null, _limit, _dir, filter) => {
                calls.push({ roomId, token, filter: filter.getRoomTimelineFilterComponent().toJSON() });
                const pages = rooms[roomId];
                const index = (cursor[roomId] = (cursor[roomId] ?? -1) + 1);
                const chunk = (pages[index] ?? []).map((event) => event.event);
                return { chunk, end: index + 1 < pages.length ? `t${index + 1}` : undefined };
            }),
        } as unknown as MatrixClient;
        return { client, calls };
    }

    it("sends the server-side filter and merges rooms newest first", async () => {
        const { client, calls } = clientFor({
            "!a:x": [[message("$a1", "!a:x", 50), message("$a2", "!a:x", 10)]],
            "!b:x": [[message("$b1", "!b:x", 40), message("$b2", "!b:x", 30)]],
        });
        const source = new BrowseSearchSource(client, ["!a:x", "!b:x"], { senders: ["@a:x"], contains_url: true }, 3);

        const page = await source.next();
        expect(page.events.map((e) => e.getId())).toEqual(["$a1", "$b1", "$b2"]);
        expect(page.hasMore).toBe(true);
        expect(calls[0].filter).toMatchObject({ senders: ["@a:x"], contains_url: true, types: ["m.room.message"] });

        const last = await source.next();
        expect(last.events.map((e) => e.getId())).toEqual(["$a2"]);
        expect(last.hasMore).toBe(false);
    });

    it("keeps paging a room whose chunks come back empty because the filter dropped everything", async () => {
        const { client } = clientFor({ "!a:x": [[], [], [message("$late", "!a:x", 5)]] });
        const source = new BrowseSearchSource(client, ["!a:x"], {}, 5);
        const page = await source.next();
        expect(page.events.map((e) => e.getId())).toEqual(["$late"]);
        expect(page.hasMore).toBe(false);
    });

    it("continues each room from its own token", async () => {
        const { client, calls } = clientFor({
            "!a:x": [[message("$1", "!a:x", 9)], [message("$2", "!a:x", 8)]],
        });
        const source = new BrowseSearchSource(client, ["!a:x"], {}, 1);
        await source.next();
        await source.next();
        expect(calls.map((call) => call.token)).toEqual([null, "t1"]);
    });

    it("decrypts encrypted history locally without server attachment filtering", async () => {
        const encrypted = new MatrixEvent({ event_id: "$encrypted", type: "m.room.encrypted", content: {} });
        const { client, calls } = clientFor({ "!a:x": [[encrypted]] });
        vi.spyOn(client, "isRoomEncrypted").mockReturnValue(true);
        vi.mocked(client.decryptEventIfNeeded).mockImplementation(async (event) => {
            event["setClearData"]({
                clearEvent: { type: "m.room.message", content: { msgtype: "m.image", body: "photo.png" } },
            });
        });
        const source = new BrowseSearchSource(client, ["!a:x"], { contains_url: true, senders: ["@a:x"] });
        const page = await source.next();
        expect(calls[0].filter).toMatchObject({ types: ["m.room.message", "m.room.encrypted"], senders: ["@a:x"] });
        expect(calls[0].filter.contains_url).toBeUndefined();
        expect(page.events[0].getContent()).toMatchObject({ msgtype: "m.image", body: "photo.png" });
        expect(page.events[0].getRoomId()).toBe("!a:x");
        expect(page.decryptionFailed).toBe(false);
        expect(client.decryptEventIfNeeded).toHaveBeenCalledWith(page.events[0], { emit: false });
    });

    it("keeps readable results when an encrypted event cannot be decrypted", async () => {
        const unreadable = new MatrixEvent({ event_id: "$bad", type: "m.room.encrypted", content: {} });
        const { client } = clientFor({ "!a:x": [[unreadable, message("$good", "!a:x", 2)]] });
        vi.spyOn(client, "isRoomEncrypted").mockReturnValue(true);
        vi.mocked(client.decryptEventIfNeeded).mockRejectedValue(new Error("Missing key"));
        const page = await new BrowseSearchSource(client, ["!a:x"], {}).next();
        expect(page.events.map((event) => event.getId())).toEqual(["$good"]);
        expect(page.decryptionFailed).toBe(true);
    });

    it("omits SDK decryption-failure placeholders even when decryption resolves", async () => {
        const encrypted = new MatrixEvent({ event_id: "$bad", type: "m.room.encrypted", content: {} });
        const { client } = clientFor({ "!a:x": [[encrypted]] });
        vi.spyOn(client, "isRoomEncrypted").mockReturnValue(true);
        vi.mocked(client.decryptEventIfNeeded).mockImplementation(async (event) => {
            // The SDK reports missing keys through a placeholder rather than a rejected promise.
            event["setClearDataForDecryptionFailure"]("Missing room key");
            vi.spyOn(event, "isDecryptionFailure").mockReturnValue(true);
        });
        expect(await new BrowseSearchSource(client, ["!a:x"], {}).next()).toMatchObject({
            events: [],
            hasMore: false,
            decryptionFailed: true,
        });
    });

    it("discards a response if the search is cancelled while fetching", async () => {
        const { client } = clientFor({ "!a:x": [[message("$1", "!a:x", 9)]] });
        const abort = new AbortController();
        const request = vi.mocked(client.createMessagesRequest).getMockImplementation()!;
        vi.mocked(client.createMessagesRequest).mockImplementation(async (...args) => {
            const response = await request(...args);
            abort.abort();
            return response;
        });
        const page = await new BrowseSearchSource(client, ["!a:x"], {}, 5, abort.signal).next();
        expect(page.events).toEqual([]);
    });

    it("retains pagination after a bounded run of empty pages instead of claiming history is exhausted", async () => {
        const { client } = clientFor({
            "!a:x": [...Array.from({ length: 20 }, () => []), [message("$old", "!a:x", 1)]],
        });
        const source = new BrowseSearchSource(client, ["!a:x"], {});
        expect(await source.next()).toMatchObject({ events: [], hasMore: true });
        expect((await source.next()).events.map((event) => event.getId())).toEqual(["$old"]);
    });

    it("stops fetching once aborted", async () => {
        const { client } = clientFor({ "!a:x": [[message("$1", "!a:x", 9)]] });
        const abort = new AbortController();
        abort.abort();
        const source = new BrowseSearchSource(client, ["!a:x"], {}, 5, abort.signal);
        expect((await source.next()).events).toEqual([]);
        expect(client.createMessagesRequest).not.toHaveBeenCalled();
    });
});
