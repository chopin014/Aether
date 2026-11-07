/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";

import { dropSide, isRoomSlotData, rejectsDraggedRoom } from "./dragAndDrop";

describe("dragAndDrop", () => {
    it("drops a room dragged up before the target and one dragged down after it", () => {
        expect(dropSide({ type: "room", isDm: false, index: 4 }, { type: "slot", index: 1 })).toBe("before");
        expect(dropSide({ type: "room", isDm: false, index: 0 }, { type: "slot", index: 1 })).toBe("after");
        // Without a known position, the room goes after the target.
        expect(dropSide({ type: "room", isDm: false }, { type: "slot", index: 1 })).toBe("after");
        expect(dropSide(undefined, { type: "slot", index: 1 })).toBe("after");
    });

    it("tells room slots apart from other drop targets", () => {
        expect(isRoomSlotData({ type: "slot", index: 0 })).toBe(true);
        expect(isRoomSlotData({ type: "section", index: 0 })).toBe(false);
        expect(isRoomSlotData(undefined)).toBe(false);
    });

    it("keeps refusing what each section refuses", () => {
        expect(rejectsDraggedRoom("nonDm", { type: "room", isDm: true })).toBe(true);
        expect(rejectsDraggedRoom("nonDm", { type: "room", isDm: false })).toBe(false);
        expect(rejectsDraggedRoom("none", { type: "room", isDm: false })).toBe(true);
    });
});
