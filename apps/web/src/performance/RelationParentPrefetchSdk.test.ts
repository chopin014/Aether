/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { EventType, type IEvent, MatrixEvent, RelationType, Room } from "matrix-js-sdk/src/matrix";

import { createClientWithCreds } from "../utils/createMatrixClient";

const roomId = "!room:example.com";
const userId = "@user:example.com";

function reaction(id: string, parent: string): MatrixEvent {
    return new MatrixEvent({
        type: EventType.Reaction,
        room_id: roomId,
        sender: userId,
        event_id: id,
        origin_server_ts: 1,
        content: { "m.relates_to": { rel_type: RelationType.Annotation, event_id: parent, key: "👍" } },
    });
}

function parent(id: string): IEvent {
    return {
        type: EventType.RoomMessage,
        room_id: roomId,
        sender: userId,
        event_id: id,
        origin_server_ts: 0,
        content: { msgtype: "m.text", body: id },
        unsigned: {},
    } as IEvent;
}

function setup() {
    const client = createClientWithCreds({ homeserverUrl: "http://example.com", userId, accessToken: "token" });
    vi.spyOn(client, "supportsThreads").mockReturnValue(true);
    const fetches = new Map<string, PromiseWithResolvers<IEvent>>();
    const fetchRoomEvent = vi.spyOn(client, "fetchRoomEvent").mockImplementation((_room, eventId) => {
        const pending = Promise.withResolvers<IEvent>();
        fetches.set(eventId, pending);
        return pending.promise;
    });
    const room = new Room(roomId, client, userId);
    return { room, fetches, fetchRoomEvent };
}

describe("relation parent fetches during live event ingestion", () => {
    afterEach(() => vi.restoreAllMocks());

    it("requests every missing parent at once and still adds events in order", async () => {
        const { room, fetches, fetchRoomEvent } = setup();
        const adding = room.addLiveEvents([reaction("$r1", "$p1"), reaction("$r2", "$p2"), reaction("$r3", "$p1")], {
            addToState: false,
        });
        // Both distinct parents are requested before the first one answers.
        expect(fetchRoomEvent.mock.calls.map(([, id]) => id)).toEqual(["$p1", "$p2"]);
        fetches.get("$p2")!.resolve(parent("$p2"));
        fetches.get("$p1")!.resolve(parent("$p1"));
        await adding;
        expect(fetchRoomEvent).toHaveBeenCalledTimes(2);
        // Reactions to main-timeline messages are aggregated, not shown as timeline events.
        expect(
            room
                .getLiveTimeline()
                .getEvents()
                .map((event) => event.getId()),
        ).toEqual([]);
        expect(room.relations.getChildEventsForEvent("$p1", RelationType.Annotation, EventType.Reaction)).toBeTruthy();
    });

    it("keeps ingesting when a parent cannot be fetched", async () => {
        const { room, fetches } = setup();
        const adding = room.addLiveEvents([reaction("$r1", "$gone"), reaction("$r2", "$p2")], { addToState: false });
        fetches.get("$gone")!.reject(new Error("not found"));
        fetches.get("$p2")!.resolve(parent("$p2"));
        await expect(adding).resolves.toBeUndefined();
    });

    it("does not fetch parents for cached events or relations to events in the same batch", async () => {
        const { room, fetchRoomEvent } = setup();
        await room.addLiveEvents([reaction("$r1", "$p1")], { addToState: false, fromCache: true });
        await room.addLiveEvents([new MatrixEvent(parent("$p2")), reaction("$r2", "$p2")], { addToState: false });
        expect(fetchRoomEvent).not.toHaveBeenCalled();
    });

    it("bounds concurrent parent requests and serves waiting events in order", async () => {
        const { room, fetches, fetchRoomEvent } = setup();
        const events = Array.from({ length: 10 }, (_, i) => reaction(`$r${i}`, `$p${i}`));
        const adding = room.addLiveEvents(events, { addToState: false });
        await Promise.resolve();
        expect(fetchRoomEvent.mock.calls.map(([, id]) => id)).toEqual(["$p0", "$p1", "$p2", "$p3", "$p4", "$p5"]);
        fetches.get("$p3")!.resolve(parent("$p3"));
        await vi.waitFor(() => expect(fetchRoomEvent).toHaveBeenCalledTimes(7));
        expect(fetchRoomEvent.mock.calls[6][1]).toBe("$p6");
        for (let i = 0; i < 10; i++) {
            await vi.waitFor(() => expect(fetches.has(`$p${i}`)).toBe(true));
            fetches.get(`$p${i}`)!.resolve(parent(`$p${i}`));
        }
        await adding;
        expect(fetchRoomEvent).toHaveBeenCalledTimes(10);
    });
});
