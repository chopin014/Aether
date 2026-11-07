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
        recoveryAnchor: (roomId) => anchors.get(roomId) ?? undefined,
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

    it("fetches nothing for a gap it has no token for, nor once stopped", async () => {
        const { client } = setup();
        const request = vi.spyOn(client, "createMessagesRequest");
        const host = hostFor(new Map());
        const recovery = new CountRecovery(client, host);

        recovery.request(roomWith(client, "!a:example.org", "$a", null), "$a");
        // An anchor that does not start its timeline has no token either.
        recovery.request(roomWith(client, "!b:example.org", "$b"), "$elsewhere");
        recovery.stop();
        recovery.request(roomWith(client, "!c:example.org", "$c"), "$c");
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(request).not.toHaveBeenCalled();
    });
});
