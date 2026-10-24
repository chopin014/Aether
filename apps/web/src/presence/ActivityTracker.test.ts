/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it, vi } from "vitest";
import { ClientEvent, MatrixEvent, RoomEvent, RoomMemberEvent } from "matrix-js-sdk/src/matrix";

import { ActivityTracker, ActivityTrackerEvent } from "./ActivityTracker";
import { makeFakeClient } from "../test/test-utils/aetherPresence";

const NOW = 1_700_000_000_000;
const BOB = "@bob:example.org";
const CAROL = "@carol:example.org";

const msg = (sender: string, ts: number, extra: Record<string, unknown> = {}): MatrixEvent =>
    new MatrixEvent({ type: "m.room.message", sender, origin_server_ts: ts, content: {}, ...extra });

/** Fake client whose rooms expose a live timeline and receipts. */
function setup(events: MatrixEvent[] = [], receipts: Record<string, number> = {}) {
    const client = makeFakeClient({ rooms: [{ id: "!r", members: [BOB, CAROL] }] });
    const room = client.getRooms()[0] as unknown as Record<string, unknown>;
    room.getLiveTimeline = () => ({ getEvents: () => events });
    room.getReadReceiptForUserId = (userId: string, _ignore: boolean, type: string) =>
        type === "m.read" && receipts[userId] ? { eventId: "$e", data: { ts: receipts[userId] } } : null;
    const tracker = new ActivityTracker(client, () => NOW);
    return { client, room, tracker };
}

describe("ActivityTracker", () => {
    it("scans existing timelines and receipts once at start", () => {
        const { tracker } = setup([msg(BOB, NOW - 5000), msg(BOB, NOW - 9000)], { [CAROL]: NOW - 70_000 });
        tracker.start();
        expect(tracker.getLastActive(BOB)).toBe(NOW - 5000);
        expect(tracker.getLastActive(CAROL)).toBe(NOW - 70_000);
        expect(tracker.getLastActive("@nobody:example.org")).toBeUndefined();
    });

    it("ignores state events and unsent local echoes", () => {
        const echo = msg(BOB, NOW - 10);
        echo.setStatus("sending" as never);
        const { tracker } = setup([
            new MatrixEvent({
                type: "m.room.member",
                state_key: BOB,
                sender: BOB,
                origin_server_ts: NOW - 5,
                content: {},
            }),
            echo,
        ]);
        tracker.start();
        expect(tracker.getLastActive(BOB)).toBeUndefined();
    });

    it("follows live timeline events and notifies once per advance", () => {
        const { client, room, tracker } = setup();
        tracker.start();
        const listener = vi.fn();
        tracker.on(ActivityTrackerEvent.Update, listener);
        client.emit(RoomEvent.Timeline, msg(BOB, NOW - 3000), room, false);
        client.emit(RoomEvent.Timeline, msg(BOB, NOW - 9000), room, false);
        expect(tracker.getLastActive(BOB)).toBe(NOW - 3000);
        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener).toHaveBeenCalledWith(BOB);
    });

    it("ignores back-paginated events", () => {
        const { client, room, tracker } = setup();
        tracker.start();
        client.emit(RoomEvent.Timeline, msg(BOB, NOW - 3000), room, true);
        expect(tracker.getLastActive(BOB)).toBeUndefined();
    });

    it("follows receipts", () => {
        const { client, tracker } = setup();
        tracker.start();
        const receipt = new MatrixEvent({
            type: "m.receipt",
            content: { $e: { "m.read": { [CAROL]: { ts: NOW - 2000 } } } },
        });
        client.emit(RoomEvent.Receipt, receipt);
        expect(tracker.getLastActive(CAROL)).toBe(NOW - 2000);
    });

    it("treats typing as active now, and stopping as nothing", () => {
        const { client, tracker } = setup();
        tracker.start();
        client.emit(RoomMemberEvent.Typing, new MatrixEvent({}), { userId: BOB, typing: false } as never);
        expect(tracker.getLastActive(BOB)).toBeUndefined();
        client.emit(RoomMemberEvent.Typing, new MatrixEvent({}), { userId: BOB, typing: true } as never);
        expect(tracker.getLastActive(BOB)).toBe(NOW);
    });

    it("never reports activity in the future", () => {
        const { tracker, client, room } = setup();
        tracker.start();
        client.emit(RoomEvent.Timeline, msg(BOB, NOW + 10 * 60_000), room, false);
        expect(tracker.getLastActive(BOB)).toBe(NOW);
    });

    it("scans rooms that appear later", () => {
        const { client, tracker } = setup();
        tracker.start();
        const room = {
            getMyMembership: () => "join",
            getLiveTimeline: () => ({ getEvents: () => [msg(BOB, NOW - 100)] }),
            getJoinedMembers: () => [],
        };
        client.emit(ClientEvent.Room, room as never);
        expect(tracker.getLastActive(BOB)).toBe(NOW - 100);
    });

    it("stops listening and forgets on stop", () => {
        const { client, room, tracker } = setup([msg(BOB, NOW - 1)]);
        tracker.start();
        tracker.stop();
        expect(tracker.getLastActive(BOB)).toBeUndefined();
        client.emit(RoomEvent.Timeline, msg(BOB, NOW - 1), room, false);
        expect(tracker.getLastActive(BOB)).toBeUndefined();
        expect(client.listenerCount(RoomEvent.Timeline)).toBe(0);
    });
});
