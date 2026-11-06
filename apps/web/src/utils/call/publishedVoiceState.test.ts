/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";
import { MatrixEvent, PendingEventOrdering, Room } from "matrix-js-sdk/src/matrix";
import { createTestClient } from "test-utils";

import { getPublishedVoiceState, VOICE_STATE_EVENT_TYPE, voiceStateKey } from "./publishedVoiceState";

function voiceState(sender: string, userId: string, deviceId: string, content: object): MatrixEvent {
    return new MatrixEvent({
        type: VOICE_STATE_EVENT_TYPE,
        state_key: voiceStateKey(userId, deviceId),
        sender,
        room_id: "!room:server",
        event_id: `$${sender}-${userId}-${deviceId}`,
        content,
    });
}

describe("getPublishedVoiceState", () => {
    let room: Room;

    beforeEach(() => {
        const client = createTestClient();
        room = new Room("!room:server", client, client.getSafeUserId(), {
            pendingEventOrdering: PendingEventOrdering.Detached,
        });
    });

    it("is undefined until a device in the call has published", () => {
        expect(getPublishedVoiceState(room, "@alice:server", ["ALICE"])).toBeUndefined();
        room.currentState.setStateEvents([voiceState("@alice:server", "@alice:server", "OLD", { muted: true })]);
        expect(getPublishedVoiceState(room, "@alice:server", ["ALICE"])).toBeUndefined();
    });

    it("reads what a device published", () => {
        room.currentState.setStateEvents([
            voiceState("@alice:server", "@alice:server", "ALICE", { muted: true, deafened: false }),
        ]);
        expect(getPublishedVoiceState(room, "@alice:server", ["ALICE"])).toEqual({ muted: true, deafened: false });
    });

    it("counts someone as muted or deafened only when all of their devices are", () => {
        room.currentState.setStateEvents([
            voiceState("@alice:server", "@alice:server", "PHONE", { muted: true, deafened: true }),
            voiceState("@alice:server", "@alice:server", "LAPTOP", { muted: true, deafened: false }),
        ]);
        expect(getPublishedVoiceState(room, "@alice:server", ["PHONE", "LAPTOP"])).toEqual({
            muted: true,
            deafened: false,
        });
    });

    it("ignores a state someone else sent on a person's behalf", () => {
        room.currentState.setStateEvents([
            voiceState("@mallory:server", "@alice:server", "ALICE", { muted: true, deafened: true }),
        ]);
        expect(getPublishedVoiceState(room, "@alice:server", ["ALICE"])).toBeUndefined();
    });

    it("ignores a cleared state", () => {
        room.currentState.setStateEvents([voiceState("@alice:server", "@alice:server", "ALICE", {})]);
        expect(getPublishedVoiceState(room, "@alice:server", ["ALICE"])).toBeUndefined();
    });
});
