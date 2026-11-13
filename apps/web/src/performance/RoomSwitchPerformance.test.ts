/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { markRoomSwitch, ROOM_SWITCH_MARK_PREFIX, type RoomSwitchMarksWindow } from "./RoomSwitchPerformance";

const marks = (phase: string): PerformanceEntry[] =>
    performance.getEntriesByName(ROOM_SWITCH_MARK_PREFIX + phase, "mark");

describe("RoomSwitchPerformance", () => {
    beforeEach(() => {
        performance.clearMarks();
    });

    afterEach(() => {
        delete (window as RoomSwitchMarksWindow).aetherRoomSwitchMarks;
        performance.clearMarks();
    });

    it("marks nothing unless the page asked for room switches to be marked", () => {
        markRoomSwitch("navigation", "!room:example.org");

        expect(marks("navigation")).toHaveLength(0);
    });

    it("marks each phase with the room it is for, and nothing without a room", () => {
        (window as RoomSwitchMarksWindow).aetherRoomSwitchMarks = true;

        markRoomSwitch("navigation", "!room:example.org");
        markRoomSwitch("rows", "!room:example.org");
        markRoomSwitch("placed", null);
        markRoomSwitch("placed", undefined);

        expect(marks("navigation").map((mark) => (mark as PerformanceMark).detail)).toEqual([
            { roomId: "!room:example.org" },
        ]);
        expect(marks("rows")).toHaveLength(1);
        expect(marks("placed")).toHaveLength(0);
    });

    it("keeps a bounded number of marks when nobody collects them", () => {
        (window as RoomSwitchMarksWindow).aetherRoomSwitchMarks = true;

        for (let i = 0; i < 120; i++) markRoomSwitch("shell", `!room${i}:example.org`);

        expect(marks("shell").length).toBeLessThanOrEqual(50);
        // The newest is always kept.
        expect((marks("shell").at(-1) as PerformanceMark).detail).toEqual({ roomId: "!room119:example.org" });
    });
});
