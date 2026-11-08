/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { NotificationCountType, PendingEventOrdering, Room, RoomEvent } from "matrix-js-sdk/src/matrix";
import { stubClient } from "test-utils";

import { SpaceNotificationState } from "./SpaceNotificationState";
import { RoomNotificationState } from "./RoomNotificationState";
import { RoomNotificationStateStore } from "./RoomNotificationStateStore";
import { setLowerBoundCounts } from "../../sliding-sync/notification-counts/lowerBoundCounts";

describe("SpaceNotificationState", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    function roomWith(roomId: string, total: number): Room {
        const room = new Room(roomId, stubClient(), "@user:example.org", {
            pendingEventOrdering: PendingEventOrdering.Detached,
        });
        room.setUnreadNotificationCount(NotificationCountType.Total, total);
        return room;
    }

    it("sums its rooms' counts to a lower bound when one of them is one", () => {
        vi.useFakeTimers();
        const first = roomWith("!first:example.org", 2);
        const second = roomWith("!second:example.org", 3);
        const states = new Map<Room, RoomNotificationState>();
        vi.spyOn(RoomNotificationStateStore.instance, "getRoomState").mockImplementation((room) => {
            if (!states.has(room)) states.set(room, new RoomNotificationState(room, false));
            return states.get(room)!;
        });
        const space = new SpaceNotificationState();
        space.setRooms([first, second]);
        vi.advanceTimersByTime(200);
        expect(space.count).toBe(5);
        expect(space.countIsLowerBound).toBe(false);

        setLowerBoundCounts(second, { main: true, threads: new Set() });
        second.emit(RoomEvent.UnreadNotifications, { total: 3, highlight: 0 });
        vi.advanceTimersByTime(200);

        expect(space.count).toBe(5);
        expect(space.countIsLowerBound).toBe(true);
        space.destroy();
    });
});
