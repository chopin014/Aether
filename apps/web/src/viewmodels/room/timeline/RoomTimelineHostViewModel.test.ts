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
import { createTimelineVisitBinding } from "./TimelineVisitBinding";

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
        vi.useRealTimers();
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

    describe("bounded model cache", () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });

        const bindReusable = (input: RoomTimelineRequest): ReturnType<typeof host.bind> => {
            const lease = host.bind(input);
            // The timeline suite covers actual admission and invalidation; isolate cache ownership here.
            const model = host.getSnapshot().entry!.vm;
            vi.spyOn(model, "parkForReuse").mockReturnValue(true);
            vi.spyOn(model, "resumeCompatible").mockReturnValue(true);
            return lease;
        };

        it("reuses a compatible model under a fresh lease and permanently rejects A1 callbacks", () => {
            const a1 = bindReusable(request(roomA))!;
            const model = host.getSnapshot().entry!.vm;
            const markRead = vi.spyOn(model, "onMarkAllAsRead");
            const a1Binding = createTimelineVisitBinding(
                model,
                () => host.isCurrent(a1),
                () => true,
            );
            const revoked = vi.fn();
            host.subscribeToRevocation(a1, revoked);
            host.release(a1);
            bindReusable(request(roomB));
            const a2 = bindReusable(request(roomA))!;
            expect(host.getSnapshot().entry!.vm).toBe(model);
            expect(a2).not.toBe(a1);
            expect(a2.entryId).not.toBe(a1.entryId);
            expect(host.isCurrent(a1)).toBe(false);
            a1Binding.onMarkAllAsRead();
            a1Binding.onVisibleRangeChanged(0, 10);
            expect(markRead).not.toHaveBeenCalled();
            host.release(a1);
            host.discard(a1);
            expect(host.isCurrent(a2)).toBe(true);
            expect(revoked).toHaveBeenCalledOnce();
        });

        it.each(["invalidation", "permalink", "receipts", "activity"])("falls back after %s", (kind) => {
            const lease = bindReusable(request(roomA))!;
            const model = host.getSnapshot().entry!.vm;
            host.release(lease);
            if (kind === "invalidation") vi.mocked(model.resumeCompatible).mockReturnValue(false);
            const options: Partial<RoomTimelineRequest> =
                kind === "permalink"
                    ? { initialEventId: "$target" }
                    : kind === "receipts"
                      ? { showReadReceipts: false }
                      : kind === "activity"
                        ? { enableReadReceiptsAndMarkersOnActivity: false }
                        : {};
            host.bind(request(roomA, options));
            expect(model.isDisposed).toBe(true);
            expect(host.getSnapshot().entry!.vm).not.toBe(model);
        });

        it("keeps at most five parked models plus the active one and evicts one oldest model per admission", () => {
            const models: RoomTimelineViewModel[] = [];
            for (let i = 0; i < 20; i++) {
                const room = new Room(`!room${i}:test`, client, "@me:test", {
                    pendingEventOrdering: PendingEventOrdering.Detached,
                });
                bindReusable(request(room));
                models.push(host.getSnapshot().entry!.vm);
                expect(models.filter((vm) => !vm.isDisposed)).toHaveLength(Math.min(i + 1, 6));
                expect(vi.getTimerCount()).toBe(Math.min(i, 5));
            }
            expect(models.slice(0, 14).every((vm) => vm.isDisposed)).toBe(true);
            host.dispose();
            expect(models.every((vm) => vm.isDisposed)).toBe(true);
            expect(vi.getTimerCount()).toBe(0);
        });

        it("expires parked models without waiting for another navigation", () => {
            const lease = bindReusable(request(roomA))!;
            const model = host.getSnapshot().entry!.vm;
            host.release(lease);
            vi.advanceTimersByTime(60_000);
            expect(model.isDisposed).toBe(true);
            expect(vi.getTimerCount()).toBe(0);
        });

        it("reclaims the oldest room in a six-room cycle after the slot released its predecessor", () => {
            const rooms = Array.from(
                { length: 6 },
                (_, index) =>
                    new Room(`!cycle${index}:test`, client, "@me:test", {
                        pendingEventOrdering: PendingEventOrdering.Detached,
                    }),
            );
            bindReusable(request(rooms[0]));
            const first = host.getSnapshot().entry!.vm;
            for (const room of rooms.slice(1)) {
                host.release(host.getSnapshot().entry!.lease);
                bindReusable(request(room));
            }
            host.release(host.getSnapshot().entry!.lease);
            bindReusable(request(rooms[0]));
            expect(host.getSnapshot().entry!.vm).toBe(first);
            expect(first.isDisposed).toBe(false);
            expect(vi.getTimerCount()).toBe(5);
        });

        it("never caches a failed presentation", () => {
            const lease = bindReusable(request(roomA))!;
            const model = host.getSnapshot().entry!.vm;
            host.discard(lease);
            expect(model.isDisposed).toBe(true);
            expect(vi.getTimerCount()).toBe(0);
        });
    });
});
