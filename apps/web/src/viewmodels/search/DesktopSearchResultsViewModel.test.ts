/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MatrixEvent, type MatrixClient, SearchOrderBy } from "matrix-js-sdk/src/matrix";

import { DesktopSearchResultsViewModel, type DesktopSearchResultsDeps } from "./DesktopSearchResultsViewModel";
import { type ActiveDesktopSearch } from "../../stores/DesktopMessageSearchStore";
import { parseQuery } from "../../utils/desktopSearch/query";
import defaultDispatcher from "../../dispatcher/dispatcher";
import { Action } from "../../dispatcher/actions";
import { type SearchSourcePage } from "./searchSources";

const message = (id: string, room: string, ts: number, content: Record<string, unknown> = {}): MatrixEvent =>
    new MatrixEvent({
        event_id: id,
        room_id: room,
        sender: "@alice:x",
        type: "m.room.message",
        origin_server_ts: ts,
        content: { msgtype: "m.text", body: `message ${id}`, ...content },
    });

const resultsOf = (events: MatrixEvent[], extra: Record<string, unknown> = {}) =>
    ({
        results: events.map((event) => ({ context: { getEvent: () => event } })),
        highlights: ["message"],
        count: events.length,
        ...extra,
    }) as any;

function makeClient(encrypted: string[] = []): MatrixClient {
    const rooms: Record<string, any> = {
        "!gen:x": {
            name: "general",
            getMember: () => ({ name: "Alice" }),
            currentState: { getStateEvents: () => undefined },
        },
        "!dev:x": { name: "dev", getMember: () => undefined, currentState: { getStateEvents: () => undefined } },
    };
    return {
        getRoom: (id: string) => rooms[id] ?? null,
        isRoomEncrypted: (id: string) => encrypted.includes(id),
        getSafeUserId: () => "@me:x",
    } as unknown as MatrixClient;
}

function search(text: string, roomIds = ["!gen:x", "!dev:x"], kind: "space" | "room" = "space"): ActiveDesktopSearch {
    return { id: 1, query: parseQuery(text), scope: { kind, roomIds } };
}

const flush = async (): Promise<void> => {
    for (let i = 0; i < 100; i++) await Promise.resolve();
};

describe("DesktopSearchResultsViewModel", () => {
    let deps: DesktopSearchResultsDeps & { search: any; paginate: any };
    let dispatched: any[];
    beforeEach(() => {
        deps = {
            search: vi.fn().mockResolvedValue(resultsOf([])),
            paginate: vi.fn(),
            hasEventIndex: () => false,
            createBrowseSource: vi.fn(),
        };
        dispatched = [];
        vi.spyOn(defaultDispatcher, "dispatch").mockImplementation((payload: any) => void dispatched.push(payload));
    });
    afterEach(() => vi.restoreAllMocks());

    const make = (active: ActiveDesktopSearch, client = makeClient(), onClose = vi.fn()) =>
        new DesktopSearchResultsViewModel({ client, search: active, onClose, deps });

    it("searches the scope's rooms with the server-side filters through Element's search", async () => {
        deps.search.mockResolvedValue(resultsOf([message("$1", "!gen:x", 2), message("$2", "!dev:x", 1)]));
        const vm = make(search("from:@alice:x has:image budget"));
        await flush();

        const [, term, roomId, signal, options] = deps.search.mock.calls[0];
        expect(term).toBe("budget");
        expect(roomId).toBeUndefined();
        expect(signal).toBeInstanceOf(AbortSignal);
        expect(options).toEqual({
            filter: { senders: ["@alice:x"], contains_url: true },
            orderBy: SearchOrderBy.Recent,
            roomIds: ["!gen:x", "!dev:x"],
        });
        vm.dispose();
    });

    it("uses the single-room route for a one-room scope", async () => {
        const vm = make(search("budget", ["!gen:x"], "room"));
        await flush();
        expect(deps.search.mock.calls[0][2]).toBe("!gen:x");
        vm.dispose();
    });

    it("counts the returned matches when the server estimate includes excluded senders", async () => {
        deps.search.mockResolvedValue(resultsOf([message("$1", "!gen:x", 2)], { count: 3 }));
        const vm = make(search("from:@alice:x budget"));
        await flush();
        expect(vm.getSnapshot().resultCount).toBe(1);
        expect(vm.getSnapshot().countIsLowerBound).toBe(false);
        vm.dispose();
    });

    it("shows a lower bound for a filtered search while more pages remain", async () => {
        deps.search.mockResolvedValue(resultsOf([message("$1", "!gen:x", 2)], { count: 3, next_batch: "more" }));
        const vm = make(search("from:@alice:x budget"));
        await flush();
        expect(vm.getSnapshot().resultCount).toBe(1);
        expect(vm.getSnapshot().countIsLowerBound).toBe(true);
        vm.dispose();
    });

    it("groups results by channel, with highlighted text and sender names", async () => {
        deps.search.mockResolvedValue(
            resultsOf([message("$1", "!gen:x", 3), message("$2", "!dev:x", 2), message("$3", "!gen:x", 1)]),
        );
        const vm = make(search("message"));
        await flush();
        const snapshot = vm.getSnapshot();
        expect(snapshot.status).toBe("ready");
        expect(snapshot.groups.map((group) => [group.roomName, group.rows.length])).toEqual([
            ["general", 2],
            ["dev", 1],
        ]);
        const row = snapshot.groups[0].rows[0];
        expect(row.senderName).toBe("Alice");
        expect(row.segments[0]).toEqual({ text: "message", match: true });
        expect(snapshot.resultCount).toBe(3);
        vm.dispose();
    });

    it("applies client-side filters, paging further until a page has enough matches", async () => {
        const link = (n: number) => message(`$l${n}`, "!gen:x", 100 - n, { body: "https://x.y" });
        const plain = (n: number) => message(`$p${n}`, "!gen:x", 50 - n);
        deps.search.mockResolvedValue(resultsOf([plain(1), plain(2), link(1)], { next_batch: "n1" }));
        deps.paginate.mockImplementation(async (_client: unknown, results: any) => {
            results.results.push(...resultsOf([plain(3), ...Array.from({ length: 9 }, (_, i) => link(i + 2))]).results);
            results.next_batch = undefined;
            return results;
        });
        const vm = make(search("has:link message"));
        await flush();

        expect(deps.paginate).toHaveBeenCalledOnce();
        const snapshot = vm.getSnapshot();
        expect(snapshot.groups.flatMap((g) => g.rows).every((row) => row.id.startsWith("$l"))).toBe(true);
        expect(snapshot.resultCount).toBe(10);
        expect(snapshot.approximate).toBe(true);
        expect(snapshot.hasMore).toBe(false);
        vm.dispose();
    });

    it("pages on request, appending without duplicates", async () => {
        deps.search.mockResolvedValue(resultsOf([message("$1", "!gen:x", 3)], { next_batch: "n1" }));
        deps.paginate.mockImplementation(async (_client: unknown, results: any) => {
            results.results.push(...resultsOf([message("$1", "!gen:x", 3), message("$2", "!gen:x", 2)]).results);
            results.next_batch = undefined;
            return results;
        });
        const vm = make(search("message"));
        await flush();
        expect(vm.getSnapshot().hasMore).toBe(true);

        vm.loadMore();
        expect(vm.getSnapshot().loadingMore).toBe(true);
        await flush();
        const snapshot = vm.getSnapshot();
        expect(snapshot.groups[0].rows.map((row) => row.id)).toEqual(["$1", "$2"]);
        expect(snapshot.hasMore).toBe(false);
        expect(snapshot.loadingMore).toBe(false);
        vm.dispose();
    });

    it("reports a lower bound while more may exist and the filters are client-side", async () => {
        deps.search.mockResolvedValue(
            resultsOf([message("$1", "!gen:x", 3, { body: "a.com http://a.com" })], { next_batch: "n" }),
        );
        deps.paginate.mockResolvedValue(
            resultsOf([message("$1", "!gen:x", 3, { body: "http://a.com" })], { next_batch: "n" }),
        );
        const vm = make(search("has:link message"));
        await flush();
        expect(vm.getSnapshot().countIsLowerBound).toBe(true);
        vm.dispose();
    });

    it("ignores the answer of a search that was replaced", async () => {
        let resolveFirst: (value: unknown) => void = () => {};
        deps.search
            .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
            .mockResolvedValueOnce(resultsOf([message("$new", "!gen:x", 1)]));
        const vm = make(search("message"));
        vm.setSort("relevance");
        await flush();
        resolveFirst(resultsOf([message("$stale", "!gen:x", 9)]));
        await flush();

        const ids = vm.getSnapshot().groups.flatMap((group) => group.rows.map((row) => row.id));
        expect(ids).toEqual(["$new"]);
        expect(deps.search.mock.calls[1][4].orderBy).toBe(SearchOrderBy.Rank);
        expect(deps.search.mock.calls[0][3].aborted).toBe(true);
        vm.dispose();
    });

    it("aborts the running search when disposed", async () => {
        deps.search.mockReturnValue(new Promise(() => {}));
        const vm = make(search("message"));
        await flush();
        vm.dispose();
        expect(deps.search.mock.calls[0][3].aborted).toBe(true);
    });

    it("shows an error and can retry", async () => {
        deps.search
            .mockRejectedValueOnce(new Error("boom"))
            .mockResolvedValueOnce(resultsOf([message("$1", "!gen:x", 1)]));
        const vm = make(search("message"));
        await flush();
        expect(vm.getSnapshot().status).toBe("error");
        vm.retry();
        await flush();
        expect(vm.getSnapshot().status).toBe("ready");
        expect(vm.getSnapshot().groups).toHaveLength(1);
        vm.dispose();
    });

    describe("encrypted rooms", () => {
        it("skips them and says so when the event index is off", async () => {
            const vm = make(search("message"), makeClient(["!dev:x"]));
            await flush();
            expect(vm.getSnapshot().encryptedSkipped).toBe(true);
            expect(deps.search.mock.calls[0][4].roomIds).toEqual(["!gen:x"]);
            expect(deps.search.mock.calls[0][2]).toBe("!gen:x");
            vm.dispose();
        });

        it("does not search at all when every room is encrypted", async () => {
            const vm = make(search("message", ["!dev:x"], "room"), makeClient(["!dev:x"]));
            await flush();
            expect(deps.search).not.toHaveBeenCalled();
            expect(vm.getSnapshot()).toMatchObject({ status: "ready", encryptedSkipped: true, groups: [] });
            vm.dispose();
        });

        it("includes them without a notice when the event index is on", async () => {
            deps.hasEventIndex = () => true;
            const vm = make(search("message"), makeClient(["!dev:x"]));
            await flush();
            expect(vm.getSnapshot().encryptedSkipped).toBe(false);
            expect(deps.search).toHaveBeenCalled();
            expect(deps.search.mock.calls[0][4].roomIds).toEqual(["!gen:x"]);
            vm.dispose();
        });

        it("filters local results to the scope's rooms", async () => {
            deps.hasEventIndex = () => true;
            deps.search.mockResolvedValue(resultsOf([message("$in", "!gen:x", 2), message("$out", "!other:x", 1)]));
            const vm = make(search("message"));
            await flush();
            expect(vm.getSnapshot().groups.flatMap((g) => g.rows.map((r) => r.id))).toEqual(["$in"]);
            vm.dispose();
        });
    });

    describe("filters only", () => {
        const page = (events: MatrixEvent[], hasMore = false): SearchSourcePage => ({
            events,
            hasMore,
            highlights: [],
        });

        it("browses encrypted and unencrypted rooms, with only the newest sort", async () => {
            const next = vi
                .fn()
                .mockResolvedValue(page([message("$f", "!gen:x", 1, { msgtype: "m.file", body: "doc.pdf" })]));
            (deps.createBrowseSource as any).mockReturnValue({ next });
            const vm = make(search("has:file"), makeClient(["!dev:x"]));
            await flush();

            expect(deps.search).not.toHaveBeenCalled();
            expect((deps.createBrowseSource as any).mock.calls[0][1]).toEqual(["!gen:x", "!dev:x"]);
            const snapshot = vm.getSnapshot();
            expect(snapshot.sorts).toEqual(["recent"]);
            expect(snapshot.encryptedSkipped).toBe(false);
            expect(snapshot.groups[0].rows[0].attachmentName).toBe("doc.pdf");
            vm.dispose();
        });

        it("surfaces missing keys without dropping readable results", async () => {
            vi.mocked(deps.createBrowseSource).mockReturnValue({
                next: vi.fn().mockResolvedValue({
                    ...page([message("$image", "!dev:x", 1, { msgtype: "m.image", body: "photo.png" })]),
                    decryptionFailed: true,
                }),
            });
            const vm = make(search("has:image", ["!dev:x"], "room"), makeClient(["!dev:x"]));
            await flush();
            expect(vm.getSnapshot()).toMatchObject({ decryptionFailed: true, resultCount: 1, encryptedSkipped: false });
            vm.dispose();
        });

        it("keeps only the files for has:file", async () => {
            const next = vi
                .fn()
                .mockResolvedValue(
                    page([
                        message("$text", "!gen:x", 3),
                        message("$file", "!gen:x", 2, { msgtype: "m.file", body: "a.pdf" }),
                        message("$img", "!gen:x", 1, { msgtype: "m.image", body: "b.png" }),
                    ]),
                );
            (deps.createBrowseSource as any).mockReturnValue({ next });
            const vm = make(search("has:file"));
            await flush();
            expect(vm.getSnapshot().groups[0].rows.map((row) => row.id)).toEqual(["$file", "$img"]);
            vm.dispose();
        });
    });

    it("pinned: checks the room's pinned events", async () => {
        const client = makeClient();
        (client.getRoom("!gen:x") as any).currentState.getStateEvents = () => ({
            getContent: () => ({ pinned: ["$pinned"] }),
        });
        deps.search.mockResolvedValue(resultsOf([message("$pinned", "!gen:x", 2), message("$other", "!gen:x", 1)]));
        const vm = make(search("pinned:true message"), client);
        await flush();
        expect(vm.getSnapshot().groups[0].rows.map((row) => row.id)).toEqual(["$pinned"]);
        vm.dispose();
    });

    it("jumps to a result in its room, highlighted, and keeps the results open", async () => {
        deps.search.mockResolvedValue(resultsOf([message("$1", "!dev:x", 1)]));
        const onClose = vi.fn();
        const vm = make(search("message"), makeClient(), onClose);
        await flush();
        vm.openResult("$1");
        expect(dispatched).toContainEqual(
            expect.objectContaining({
                action: Action.ViewRoom,
                room_id: "!dev:x",
                event_id: "$1",
                highlighted: true,
            }),
        );
        expect(onClose).not.toHaveBeenCalled();
        expect(vm.getSnapshot().activeId).toBe("$1");
        expect(vm.getEvent("$1")).toBeDefined();
        vm.dispose();
    });

    it("opens Security settings from the encrypted notice and closes through the owner", async () => {
        const onClose = vi.fn();
        const vm = make(search("message"), makeClient(), onClose);
        vm.openSecuritySettings();
        expect(dispatched).toContainEqual({ action: Action.ViewUserSettings, initialTabId: "USER_SECURITY_TAB" });
        vm.close();
        expect(onClose).toHaveBeenCalledOnce();
        vm.dispose();
    });
});
