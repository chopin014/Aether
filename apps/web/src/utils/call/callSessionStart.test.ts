/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";
import { EventType, MatrixEvent, PendingEventOrdering, Room } from "matrix-js-sdk/src/matrix";
import { type CallMembership } from "matrix-js-sdk/src/matrixrtc";
import { createTestClient } from "test-utils";

import { CALL_GAP_GRACE_MS, getCallSessionStart } from "./callSessionStart";

const membership = (createdTs: number): CallMembership => ({ createdTs: () => createdTs }) as CallMembership;

let eventCounter = 0;

/** A call member state event for one of `user`'s devices. */
function memberEvent(
    user: string,
    ts: number,
    content: Record<string, unknown>,
    prevContent?: Record<string, unknown>,
): MatrixEvent {
    return new MatrixEvent({
        type: EventType.GroupCallMemberPrefix,
        state_key: `_@${user}:server_${user.toUpperCase()}_m.call`,
        sender: `@${user}:server`,
        room_id: "!room:server",
        event_id: `$${user}-${++eventCounter}`,
        origin_server_ts: ts,
        content,
        unsigned: prevContent ? { prev_content: prevContent } : undefined,
    });
}

const joined = (user: string, createdTs?: number): Record<string, unknown> => ({
    application: "m.call",
    device_id: user.toUpperCase(),
    ...(createdTs === undefined ? {} : { created_ts: createdTs }),
});

describe("getCallSessionStart", () => {
    let room: Room;

    beforeEach(() => {
        const client = createTestClient();
        room = new Room("!room:server", client, client.getSafeUserId(), {
            pendingEventOrdering: PendingEventOrdering.Detached,
        });
    });

    it("is undefined while nobody is in the call", () => {
        expect(getCallSessionStart(room, [])).toBeUndefined();
    });

    it("starts with the earliest membership when nothing else is known", () => {
        expect(getCallSessionStart(room, [membership(3_000), membership(2_000)])).toBe(2_000);
    });

    it("walks back through people who left after the next person joined", () => {
        // Alice 1 000 to 4 000, Bob 3 000 to 8 000, Carol from 7 000 and still there.
        room.currentState.setStateEvents([
            memberEvent("alice", 4_000, {}, joined("alice", 1_000)),
            memberEvent("bob", 8_000, {}, joined("bob", 3_000)),
        ]);
        expect(getCallSessionStart(room, [membership(7_000)])).toBe(1_000);
    });

    it("does not reach back past a time the call was empty", () => {
        // Alice left at 4 000, long before Bob joined.
        room.currentState.setStateEvents([memberEvent("alice", 4_000, {}, joined("alice", 1_000))]);
        const bobJoined = 4_000 + CALL_GAP_GRACE_MS + 1;
        expect(getCallSessionStart(room, [membership(bobJoined)])).toBe(bobJoined);
    });

    it("keeps the call going across a quick reconnect", () => {
        room.currentState.setStateEvents([memberEvent("alice", 4_000, {}, joined("alice", 1_000))]);
        expect(getCallSessionStart(room, [membership(4_000 + CALL_GAP_GRACE_MS - 1)])).toBe(1_000);
    });

    it("uses the timeline for joins whose leave did not carry them", () => {
        const join = memberEvent("alice", 1_000, joined("alice"));
        const leave = memberEvent("alice", 5_000, {});
        room.getLiveTimeline().addEvent(join, { toStartOfTimeline: false, addToState: true });
        room.getLiveTimeline().addEvent(leave, { toStartOfTimeline: false, addToState: true });
        expect(getCallSessionStart(room, [membership(3_000)])).toBe(1_000);
    });

    it("ignores memberships of other applications", () => {
        room.currentState.setStateEvents([
            memberEvent("alice", 4_000, {}, { application: "m.other", device_id: "ALICE", created_ts: 1_000 }),
        ]);
        expect(getCallSessionStart(room, [membership(3_000)])).toBe(3_000);
    });

    it("remembers the start while the call stays occupied, and forgets it once empty", () => {
        room.currentState.setStateEvents([memberEvent("alice", 4_000, {}, joined("alice", 1_000))]);
        expect(getCallSessionStart(room, [membership(3_000)], 5_000)).toBe(1_000);

        // The history that told us about Alice is gone, but Bob has been there throughout.
        room.currentState.setStateEvents([memberEvent("alice", 9_000, joined("alice", 9_000))]);
        expect(getCallSessionStart(room, [membership(3_000)], 10_000)).toBe(1_000);

        // Someone who joined after we last looked does not inherit the old start.
        room = new Room("!room:server", room.client, room.client.getSafeUserId());
        expect(getCallSessionStart(room, [membership(3_000)], 5_000)).toBe(3_000);
        expect(getCallSessionStart(room, [membership(5_000 + CALL_GAP_GRACE_MS + 1)], 60_000)).toBe(
            5_000 + CALL_GAP_GRACE_MS + 1,
        );

        expect(getCallSessionStart(room, [], 70_000)).toBeUndefined();
        expect(getCallSessionStart(room, [membership(80_000)], 80_000)).toBe(80_000);
    });
});
