/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
    EventTimeline,
    EventType,
    type IRoomEvent,
    type MatrixClient,
    MatrixError,
    type MatrixEvent,
    Room,
} from "matrix-js-sdk/src/matrix";

import { createClientWithCreds } from "../../utils/createMatrixClient";
import { CountRecovery, type CountRecoveryHost } from "./CountRecovery";

const me = "@alice:example.org";

function raw(roomId: string, id: string): IRoomEvent {
    return {
        type: EventType.RoomMessage,
        sender: "@bob:example.org",
        room_id: roomId,
        event_id: id,
        origin_server_ts: 1,
        content: { msgtype: "m.text", body: id },
    } as IRoomEvent;
}

/** A room whose live timeline starts at `first`, with a token for the history before it. */
function roomWith(client: MatrixClient, roomId: string, first: string, token: string | null = "before"): Room {
    const room = new Room(roomId, client, me);
    room.updateMyMembership("join");
    client.store.storeRoom(room);
    room.getLiveTimeline().setPaginationToken(token, EventTimeline.BACKWARDS);
    void room.addLiveEvents([client.getEventMapper()(raw(roomId, first))], { addToState: false });
    return room;
}

/** A host whose rooms each have a gap until a given event arrives. */
function hostFor(filledBy: Map<string, string>): CountRecoveryHost & { pages: Map<string, string[][]> } {
    const anchors = new Map<string, string>();
    const pages = new Map<string, string[][]>();
    return {
        pages,
        recoveryAnchor: (roomId) => anchors.get(roomId) || undefined,
        addHistory: (room, events, anchor) => {
            const ids = events.map((event: MatrixEvent) => event.getId()!);
            pages.set(room.roomId, [...(pages.get(room.roomId) ?? []), ids]);
            // The page joins the newest segment: its oldest event starts it now, unless it reached the receipt.
            anchors.set(room.roomId, ids.includes(filledBy.get(room.roomId)!) ? "" : ids[0]);
            if (anchors.get(room.roomId) === "") anchors.delete(room.roomId);
            void anchor;
        },
        // Lets tests set where a room's gap starts.
        set: (roomId: string, anchor: string) => anchors.set(roomId, anchor),
    } as CountRecoveryHost & { pages: Map<string, string[][]>; set: (roomId: string, anchor: string) => void };
}

describe("CountRecovery", () => {
    afterEach(() => vi.restoreAllMocks());

    function setup() {
        const client = createClientWithCreds({ homeserverUrl: "https://example.org", userId: me, accessToken: "t" });
        return { client };
    }

    it("fetches history just before the gap and hands it over oldest first, until the gap is filled", async () => {
        const { client } = setup();
        const room = roomWith(client, "!r:example.org", "$d");
        const request = vi.spyOn(client, "createMessagesRequest").mockResolvedValueOnce({
            chunk: [raw(room.roomId, "$c"), raw(room.roomId, "$b")],
            start: "before",
            end: "older",
        });
        const host = hostFor(new Map([[room.roomId, "$b"]])) as ReturnType<typeof hostFor> & {
            set: (roomId: string, anchor: string) => void;
        };
        host.set(room.roomId, "$d");
        const recovery = new CountRecovery(client, host);
        recovery.allow();

        recovery.request(room, "$d");
        await vi.waitFor(() => expect(host.pages.get(room.roomId)).toEqual([["$b", "$c"]]));

        expect(request).toHaveBeenCalledTimes(1);
        expect(request).toHaveBeenCalledWith(room.roomId, "before", 50, "b");
        // Filled: asking again for a gap that no longer exists fetches nothing.
        recovery.request(room, "$d");
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(request).toHaveBeenCalledTimes(1);
    });

    it("carries on for a few pages while the gap remains, then gives up on that gap", async () => {
        const { client } = setup();
        const room = roomWith(client, "!r:example.org", "$z");
        let page = 0;
        const request = vi.spyOn(client, "createMessagesRequest").mockImplementation(async () => {
            page++;
            return { chunk: [raw(room.roomId, `$p${page}`)], start: `t${page - 1}`, end: `t${page}` };
        });
        const host = hostFor(new Map([[room.roomId, "$never"]])) as ReturnType<typeof hostFor> & {
            set: (roomId: string, anchor: string) => void;
        };
        host.set(room.roomId, "$z");
        const recovery = new CountRecovery(client, host, { pagesPerGap: 2 });
        recovery.allow();

        recovery.request(room, "$z");
        await vi.waitFor(() => expect(host.pages.get(room.roomId)).toHaveLength(2));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(request).toHaveBeenCalledTimes(2);
        expect(request.mock.calls[1][1]).toBe("t1");
        // The same gap is not asked for again.
        recovery.request(room, "$p2");
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(request).toHaveBeenCalledTimes(2);
    });

    it("runs a limited number of requests at once, and stops at the session's budget", async () => {
        const { client } = setup();
        const rooms = [1, 2, 3, 4].map((i) => roomWith(client, `!r${i}:example.org`, `$d${i}`));
        const pending: Array<() => void> = [];
        let inFlight = 0;
        let most = 0;
        const request = vi.spyOn(client, "createMessagesRequest").mockImplementation(async (roomId) => {
            inFlight++;
            most = Math.max(most, inFlight);
            await new Promise<void>((resolve) => pending.push(resolve));
            inFlight--;
            return { chunk: [raw(roomId, `$old-${roomId}`)], start: "before" };
        });
        const host = hostFor(new Map(rooms.map((room) => [room.roomId, `$old-${room.roomId}`]))) as ReturnType<
            typeof hostFor
        > & { set: (roomId: string, anchor: string) => void };
        for (const room of rooms) host.set(room.roomId, room.getLiveTimeline().getEvents()[0].getId()!);
        const recovery = new CountRecovery(client, host, { concurrent: 2, sessionPages: 3 });
        recovery.allow();

        for (const room of rooms) recovery.request(room, room.getLiveTimeline().getEvents()[0].getId()!);
        await vi.waitFor(() => expect(pending).toHaveLength(2));
        while (pending.length > 0) {
            pending.shift()!();
            await new Promise((resolve) => setTimeout(resolve, 0));
        }

        expect(most).toBe(2);
        expect(request).toHaveBeenCalledTimes(3);
    });

    it("waits when the server asks it to slow down, then tries again", async () => {
        vi.useFakeTimers();
        try {
            const { client } = setup();
            const room = roomWith(client, "!r:example.org", "$d");
            const limited = new MatrixError(
                { errcode: "M_LIMIT_EXCEEDED", error: "Too many requests" },
                429,
                undefined,
                undefined,
                new Headers({ "Retry-After": "2" }),
            );
            const request = vi
                .spyOn(client, "createMessagesRequest")
                .mockRejectedValueOnce(limited)
                .mockResolvedValueOnce({ chunk: [raw(room.roomId, "$c")], start: "before" });
            const host = hostFor(new Map([[room.roomId, "$c"]])) as ReturnType<typeof hostFor> & {
                set: (roomId: string, anchor: string) => void;
            };
            host.set(room.roomId, "$d");
            const recovery = new CountRecovery(client, host);
            recovery.allow();

            recovery.request(room, "$d");
            await vi.advanceTimersByTimeAsync(1000);
            expect(request).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(1500);

            expect(request).toHaveBeenCalledTimes(2);
            expect(host.pages.get(room.roomId)).toEqual([["$c"]]);
        } finally {
            vi.useRealTimers();
        }
    });

    it("fetches nothing for a gap it has no token for yet, and does once it has one", async () => {
        const { client } = setup();
        const request = vi
            .spyOn(client, "createMessagesRequest")
            .mockResolvedValue({ chunk: [raw("!a:example.org", "$old")], start: "later" });
        const host = hostFor(new Map([["!a:example.org", "$old"]])) as ReturnType<typeof hostFor> & {
            set: (roomId: string, anchor: string) => void;
        };
        const recovery = new CountRecovery(client, host);
        recovery.allow();
        const room = roomWith(client, "!a:example.org", "$a", null);
        host.set(room.roomId, "$a");

        recovery.request(room, "$a");
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(request).not.toHaveBeenCalled();

        // Such as a later response giving the timeline a token.
        room.getLiveTimeline().setPaginationToken("later", EventTimeline.BACKWARDS);
        recovery.request(room, "$a");
        await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    });

    /** Start the room's timeline again at a newer event, with a token for the history before it. */
    function restartAt(room: Room, client: MatrixClient, first: string, token: string): void {
        room.resetLiveTimeline(token, null);
        void room.addLiveEvents([client.getEventMapper()(raw(room.roomId, first))], { addToState: false });
    }

    it("lets a newer gap take the place of one waiting", async () => {
        const { client } = setup();
        const room = roomWith(client, "!r:example.org", "$a", "before-a");
        const request = vi
            .spyOn(client, "createMessagesRequest")
            .mockResolvedValue({ chunk: [raw(room.roomId, "$old")], start: "before-e" });
        const host = hostFor(new Map([[room.roomId, "$old"]])) as ReturnType<typeof hostFor> & {
            set: (roomId: string, anchor: string) => void;
        };
        const recovery = new CountRecovery(client, host);
        host.set(room.roomId, "$a");
        recovery.request(room, "$a");

        // Before the room list has found every room, a newer sync leaves another gap.
        restartAt(room, client, "$e", "before-e");
        host.set(room.roomId, "$e");
        recovery.request(room, "$e");
        recovery.allow();
        await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));

        expect(request.mock.calls[0][1]).toBe("before-e");
    });

    it("does not use a page for a gap that went while it was fetched, and fetches the gap there is now", async () => {
        const { client } = setup();
        const room = roomWith(client, "!r:example.org", "$a", "before-a");
        const answers: Array<(value: { chunk: IRoomEvent[]; start: string }) => void> = [];
        const request = vi
            .spyOn(client, "createMessagesRequest")
            .mockImplementation(() => new Promise((resolve) => answers.push(resolve)));
        const host = hostFor(new Map([[room.roomId, "$old"]])) as ReturnType<typeof hostFor> & {
            set: (roomId: string, anchor: string) => void;
        };
        const recovery = new CountRecovery(client, host);
        recovery.allow();
        host.set(room.roomId, "$a");
        recovery.request(room, "$a");
        await vi.waitFor(() => expect(answers).toHaveLength(1));

        // Meanwhile, a newer sync leaves another gap.
        restartAt(room, client, "$e", "before-e");
        host.set(room.roomId, "$e");
        recovery.request(room, "$e");
        answers[0]({ chunk: [raw(room.roomId, "$z")], start: "before-a" });
        await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));

        expect(host.pages.get(room.roomId)).toBeUndefined();
        expect(request.mock.calls[1][1]).toBe("before-e");
    });

    it("does not use a page for a gap a receipt closed while it was fetched", async () => {
        const { client } = setup();
        const room = roomWith(client, "!r:example.org", "$a", "before-a");
        const answers: Array<(value: { chunk: IRoomEvent[]; start: string }) => void> = [];
        const request = vi
            .spyOn(client, "createMessagesRequest")
            .mockImplementation(() => new Promise((resolve) => answers.push(resolve)));
        const host = hostFor(new Map()) as ReturnType<typeof hostFor> & {
            set: (roomId: string, anchor: string) => void;
        };
        const recovery = new CountRecovery(client, host);
        recovery.allow();
        host.set(room.roomId, "$a");
        recovery.request(room, "$a");
        await vi.waitFor(() => expect(answers).toHaveLength(1));

        // Read up to the newest message meanwhile: no gap matters any more.
        host.set(room.roomId, "");
        answers[0]({ chunk: [raw(room.roomId, "$z")], start: "before-a", end: "older" } as never);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(host.pages.get(room.roomId)).toBeUndefined();
        expect(request).toHaveBeenCalledTimes(1);
    });

    it("fetches nothing until allowed, nor once stopped", async () => {
        const { client } = setup();
        const request = vi.spyOn(client, "createMessagesRequest").mockResolvedValue({ chunk: [], start: "t" });
        const host = hostFor(new Map()) as ReturnType<typeof hostFor> & {
            set: (roomId: string, anchor: string) => void;
        };
        const recovery = new CountRecovery(client, host);
        const room = roomWith(client, "!a:example.org", "$a");
        host.set(room.roomId, "$a");

        // While the room list is still finding the account's rooms.
        recovery.request(room, "$a");
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(request).not.toHaveBeenCalled();

        recovery.stop();
        recovery.allow();
        recovery.request(roomWith(client, "!b:example.org", "$b"), "$b");
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(request).not.toHaveBeenCalled();
    });

    it("takes the most recently active rooms first, and drops work no longer needed without spending on it", async () => {
        const { client } = setup();
        const quiet = roomWith(client, "!quiet:example.org", "$q");
        const busy = roomWith(client, "!busy:example.org", "$b");
        const left = roomWith(client, "!left:example.org", "$l");
        const read = roomWith(client, "!read:example.org", "$r");
        quiet.setBumpStamp(1);
        busy.setBumpStamp(9);
        left.setBumpStamp(8);
        read.setBumpStamp(7);
        const asked: string[] = [];
        const request = vi.spyOn(client, "createMessagesRequest").mockImplementation(async (roomId) => {
            asked.push(roomId);
            return { chunk: [raw(roomId, `$old-${roomId}`)], start: "before" };
        });
        const host = hostFor(new Map([quiet, busy, left, read].map((room) => [room.roomId, `$old-${room.roomId}`])));
        const set = (host as unknown as { set: (roomId: string, anchor: string) => void }).set;
        for (const [room, anchor] of [
            [quiet, "$q"],
            [busy, "$b"],
            [left, "$l"],
            [read, "$r"],
        ] as const) {
            set(room.roomId, anchor);
        }
        const recovery = new CountRecovery(client, host, { concurrent: 1, sessionPages: 2 });
        for (const [room, anchor] of [
            [quiet, "$q"],
            [busy, "$b"],
            [left, "$l"],
            [read, "$r"],
        ] as const) {
            recovery.request(room, anchor);
        }
        // Meanwhile, the user leaves one room and reads another up to its newest message.
        left.updateMyMembership("leave");
        set(read.roomId, "");

        recovery.allow();
        await vi.waitFor(() => expect(asked).toHaveLength(2));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(asked).toEqual([busy.roomId, quiet.roomId]);
        expect(request).toHaveBeenCalledTimes(2);
    });

    it("carries on past a page with no events, and stops at the session's byte allowance", async () => {
        const { client } = setup();
        const room = roomWith(client, "!r:example.org", "$d");
        const request = vi
            .spyOn(client, "createMessagesRequest")
            // Nothing the client sees, but history goes on.
            .mockResolvedValueOnce({ chunk: [], start: "before", end: "t1" })
            .mockResolvedValueOnce({ chunk: [raw(room.roomId, "$big")], start: "t1", end: "t2" });
        const host = hostFor(new Map([[room.roomId, "$never"]])) as ReturnType<typeof hostFor> & {
            set: (roomId: string, anchor: string) => void;
        };
        host.set(room.roomId, "$d");
        // The second page uses up the bytes: no third is asked for, though the gap remains.
        const recovery = new CountRecovery(client, host, { pagesPerGap: 5, sessionBytes: 50 });
        recovery.allow();

        recovery.request(room, "$d");
        await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(request.mock.calls[1][1]).toBe("t1");
        expect(host.pages.get(room.roomId)).toEqual([["$big"]]);
        expect(request).toHaveBeenCalledTimes(2);
    });
});
