/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it, vi } from "vitest";
import { MatrixEvent, type MatrixClient } from "matrix-js-sdk/src/matrix";

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
            getEventMapper: () => (raw: any) => raw,
            createMessagesRequest: vi.fn(async (roomId: string, token: string | null, _limit, _dir, filter) => {
                calls.push({ roomId, token, filter: filter.getRoomTimelineFilterComponent().toJSON() });
                const pages = rooms[roomId];
                const index = (cursor[roomId] = (cursor[roomId] ?? -1) + 1);
                const chunk = pages[index] ?? [];
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

    it("stops fetching once aborted", async () => {
        const { client } = clientFor({ "!a:x": [[message("$1", "!a:x", 9)]] });
        const abort = new AbortController();
        abort.abort();
        const source = new BrowseSearchSource(client, ["!a:x"], {}, 5, abort.signal);
        expect((await source.next()).events).toEqual([]);
        expect(client.createMessagesRequest).not.toHaveBeenCalled();
    });
});
