/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { type MatrixClient, PendingEventOrdering, Room } from "matrix-js-sdk/src/matrix";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestClient } from "test-utils";

import { RoomTimelineHostViewModel, type RoomTimelineRequest } from "./RoomTimelineHostViewModel";
import { RoomTimelineViewModel } from "./RoomTimelineViewModel";

describe("RoomTimelineHostViewModel", () => {
    let client: MatrixClient;
    let roomA: Room;
    let roomB: Room;
    let host: RoomTimelineHostViewModel;

    const request = (room: Room, override: Partial<RoomTimelineRequest> = {}): RoomTimelineRequest => ({
        client,
        room,
        showReadReceipts: true,
        sendReadReceiptOnLoad: false,
        enableReadReceiptsAndMarkersOnActivity: true,
        ...override,
    });

    beforeEach(() => {
        client = createTestClient();
        const room = (id: string): Room =>
            new Room(id, client, "@me:example.org", { pendingEventOrdering: PendingEventOrdering.Detached });
        roomA = room("!a:example.org");
        roomB = room("!b:example.org");
        host = new RoomTimelineHostViewModel({ client });
    });

    afterEach(() => {
        host.dispose();
        vi.restoreAllMocks();
    });

    it("owns one room's timeline at a time, disposing of the last as it binds the next", () => {
        const leaseA = host.bind(request(roomA))!;
        const timelineA = host.getSnapshot().entry!.vm;
        const disposeA = vi.spyOn(timelineA, "dispose");

        const leaseB = host.bind(request(roomB))!;

        expect(disposeA).toHaveBeenCalledTimes(1);
        expect(host.isCurrent(leaseA)).toBe(false);
        expect(host.isCurrent(leaseB)).toBe(true);
        expect(host.getSnapshot().entry).toEqual({ lease: leaseB, vm: expect.any(RoomTimelineViewModel) });
        expect(host.getSnapshot().entry!.vm).not.toBe(timelineA);
        expect(host.getSnapshot().entry!.vm.isDisposed).toBe(false);
    });

    it("makes a new timeline when the same room is bound again, keeping none from before", () => {
        const first = host.bind(request(roomA))!;
        const timeline = host.getSnapshot().entry!.vm;
        host.release(first);

        const second = host.bind(request(roomA))!;

        expect(second.entryId).not.toBe(first.entryId);
        expect(host.getSnapshot().entry!.vm).not.toBe(timeline);
        expect(timeline.isDisposed).toBe(true);
    });

    it("ignores the release of a lease that is no longer current", () => {
        const stale = host.bind(request(roomA))!;
        const current = host.bind(request(roomA))!;
        const timeline = host.getSnapshot().entry!.vm;

        host.release(stale);

        expect(host.isCurrent(current)).toBe(true);
        expect(timeline.isDisposed).toBe(false);
    });

    it("stops a lease being current before it disposes of its timeline", () => {
        const lease = host.bind(request(roomA))!;
        const timeline = host.getSnapshot().entry!.vm;
        let currentAtDispose: boolean | undefined;
        vi.spyOn(timeline, "dispose").mockImplementation(() => {
            currentAtDispose = host.isCurrent(lease);
        });

        host.release(lease);

        expect(currentAtDispose).toBe(false);
        expect(host.getSnapshot().entry).toBeNull();
    });

    it("gives a timeline up in order: its lease, then those told, its view model, and last its snapshot", () => {
        const lease = host.bind(request(roomA))!;
        const timeline = host.getSnapshot().entry!.vm;
        const order: string[] = [];
        host.subscribeToRevocation(lease, () =>
            order.push(`told: current ${host.isCurrent(lease)}, shown ${host.getSnapshot().entry !== null}`),
        );
        // Disposing suspends too, which does nothing once suspended.
        vi.spyOn(timeline, "suspendPresentation").mockImplementation(() => {
            if (!order.includes("suspended")) order.push("suspended");
        });
        const dispose = timeline.dispose.bind(timeline);
        vi.spyOn(timeline, "dispose").mockImplementation(() => {
            order.push("disposed");
            dispose();
        });
        host.subscribe(() => order.push(`removed: ${host.getSnapshot().entry === null}`));

        host.release(lease);

        expect(order).toEqual(["told: current false, shown true", "suspended", "disposed", "removed: true"]);
    });

    it("tells each listener once, and none for a lease given up already or that stopped listening", () => {
        const stale = host.bind(request(roomA))!;
        const lease = host.bind(request(roomB))!;
        const forStale = vi.fn();
        const told = vi.fn();
        const stopped = vi.fn();
        host.subscribeToRevocation(stale, forStale);
        host.subscribeToRevocation(lease, told);
        host.subscribeToRevocation(lease, stopped)();

        host.release(lease);
        host.release(lease);
        // Another timeline given up tells only those listening for it.
        host.release(host.bind(request(roomA))!);
        host.dispose();

        expect(forStale).not.toHaveBeenCalled();
        expect(told).toHaveBeenCalledOnce();
        expect(stopped).not.toHaveBeenCalled();
    });

    it("keeps a timeline bound by one told of the last being given up", () => {
        const lease = host.bind(request(roomA))!;
        let next: ReturnType<typeof host.bind> = null;
        host.subscribeToRevocation(lease, () => {
            host.release(lease);
            next = host.bind(request(roomB));
        });

        host.release(lease);

        expect(host.isCurrent(next!)).toBe(true);
        expect(host.getSnapshot().entry?.lease).toBe(next);
        expect(host.getSnapshot().entry?.vm.isDisposed).toBe(false);
    });

    it("binds nothing for another client, or once disposed", () => {
        expect(host.bind(request(roomA, { client: createTestClient() }))).toBeNull();
        expect(host.getSnapshot().entry).toBeNull();

        host.dispose();
        expect(host.bind(request(roomA))).toBeNull();
    });

    it("disposes of its timeline, and holds no lease, once disposed", () => {
        const lease = host.bind(request(roomA))!;
        const timeline = host.getSnapshot().entry!.vm;

        host.dispose();

        expect(timeline.isDisposed).toBe(true);
        expect(host.isCurrent(lease)).toBe(false);
    });

    it("makes the timeline as asked, without starting it", () => {
        const start = vi.spyOn(RoomTimelineViewModel.prototype, "start");
        host.bind(request(roomA, { initialEventId: "$event", sendReadReceiptOnLoad: true }));
        const timeline = host.getSnapshot().entry!.vm;

        expect(start).not.toHaveBeenCalled();
        // The message to open at is the highlighted one until the timeline loads.
        expect(timeline.getSnapshot().highlightedEventId).toBe("$event");
    });
});
