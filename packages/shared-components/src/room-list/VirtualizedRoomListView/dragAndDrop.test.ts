/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";

import {
    callParticipantDragId,
    dropSide,
    isCallParticipantDragData,
    isRoomSlotData,
    isVoiceChannelDropData,
    rejectsDraggedRoom,
    voiceChannelDropId,
} from "./dragAndDrop";

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

    it("never drops a person dragged out of a call into a section", () => {
        const person = { type: "participant", roomId: "!a:server", userId: "@bob:server", name: "Bob" } as const;
        expect(isCallParticipantDragData(person)).toBe(true);
        expect(isCallParticipantDragData({ type: "room", isDm: false })).toBe(false);
        for (const accepted of ["any", "dm", "nonDm", "none"] as const) {
            expect(rejectsDraggedRoom(accepted, person)).toBe(true);
        }
        expect(rejectsDraggedRoom("any", { type: "room", isDm: true })).toBe(false);
    });

    it("tells voice channels taking people apart from other drop targets, under ids of their own", () => {
        expect(isVoiceChannelDropData({ type: "voiceChannel", roomId: "!a:server" })).toBe(true);
        expect(isVoiceChannelDropData({ type: "slot", index: 0 })).toBe(false);
        expect(voiceChannelDropId("!a:server")).not.toBe("!a:server");
        expect(callParticipantDragId("!a:server", "@bob:server")).not.toBe(
            callParticipantDragId("!b:server", "@bob:server"),
        );
    });
});
