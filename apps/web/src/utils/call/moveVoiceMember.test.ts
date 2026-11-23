/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EventEmitter from "node:events";
import { EventType, MatrixEvent, Room, RoomType, type MatrixClient } from "matrix-js-sdk/src/matrix";
import { KnownMembership } from "matrix-js-sdk/src/types";
import { MatrixRTCSessionEvent, type CallMembership, type MatrixRTCSession } from "matrix-js-sdk/src/matrixrtc";
import { stubClient } from "test-utils";

import { moveVoiceMember, VOICE_MOVE_FOLLOW_TIMEOUT_MS } from "./moveVoiceMember";
import { VOICE_MOVE_EVENT_TYPE } from "./voiceMove";
import defaultDispatcher from "../../dispatcher/dispatcher";
import { Action } from "../../dispatcher/actions";
import Modal from "../../Modal";
import ErrorDialog from "../../components/views/dialogs/ErrorDialog";

vi.mock("../../Modal");

const MOD = "@mod:example.org";
const BOB = "@bob:example.org";
const GERAL1 = "!geral1:example.org";
const GERAL2 = "!geral2:example.org";

describe("moveVoiceMember", () => {
    let client: MatrixClient;
    let rooms: Map<string, Room>;
    let sessions: Map<string, MatrixRTCSession>;

    const makeRoom = (roomId: string, type: string, modLevel = 50): Room => {
        const room = new Room(roomId, client, MOD);
        const state = (eventType: string, content: object, stateKey = ""): MatrixEvent =>
            new MatrixEvent({ type: eventType, state_key: stateKey, room_id: roomId, sender: MOD, content });
        room.currentState.setStateEvents([
            state(EventType.RoomCreate, { creator: MOD, room_version: "10", type }),
            state(EventType.RoomMember, { membership: KnownMembership.Join, displayname: "Mod" }, MOD),
            state(EventType.RoomMember, { membership: KnownMembership.Join, displayname: "Bob" }, BOB),
            state(EventType.RoomPowerLevels, { users: { [MOD]: modLevel }, users_default: 0, state_default: 50 }),
        ]);
        room.updateMyMembership(KnownMembership.Join);
        rooms.set(roomId, room);
        return room;
    };

    const inCall = (roomId: string, ...userIds: string[]): void => {
        const session = client.matrixRTC.getRoomSession(rooms.get(roomId)!);
        session.memberships = userIds.map((userId) => ({ userId }) as CallMembership);
        session.emit(MatrixRTCSessionEvent.MembershipsChanged, [], session.memberships);
    };

    beforeEach(() => {
        client = stubClient();
        vi.spyOn(client, "getSafeUserId").mockReturnValue(MOD);
        rooms = new Map();
        sessions = new Map();
        const server = makeRoom("!server:example.org", RoomType.Space);
        makeRoom(GERAL1, RoomType.UnstableCall);
        makeRoom(GERAL2, RoomType.UnstableCall);
        for (const child of [GERAL1, GERAL2]) {
            server.currentState.setStateEvents([
                new MatrixEvent({
                    type: EventType.SpaceChild,
                    state_key: child,
                    room_id: server.roomId,
                    sender: MOD,
                    content: { via: ["example.org"] },
                }),
            ]);
        }
        vi.mocked(client.getRooms).mockImplementation(() => [...rooms.values()]);
        vi.mocked(client.getRoom).mockImplementation((roomId) => rooms.get(roomId!) ?? null);
        vi.mocked(client.matrixRTC.getRoomSession).mockImplementation((room) => {
            if (!sessions.has(room.roomId)) {
                sessions.set(
                    room.roomId,
                    Object.assign(new EventEmitter(), { memberships: [] }) as unknown as MatrixRTCSession,
                );
            }
            return sessions.get(room.roomId)!;
        });
        inCall(GERAL1, BOB, MOD);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("asks the person's app to move, and is quiet once they turn up in the other call", async () => {
        const moving = moveVoiceMember(client, GERAL1, BOB, GERAL2);
        await vi.waitFor(() => expect(client.sendStateEvent).toHaveBeenCalled());
        expect(client.sendStateEvent).toHaveBeenCalledWith(
            GERAL1,
            VOICE_MOVE_EVENT_TYPE,
            { to: GERAL2, id: expect.any(String) },
            `u:${BOB}`,
        );
        inCall(GERAL2, BOB);
        await moving;
        expect(Modal.createDialog).not.toHaveBeenCalled();
    });

    it("says so when the person's app does not follow", async () => {
        vi.useFakeTimers();
        const moving = moveVoiceMember(client, GERAL1, BOB, GERAL2);
        await vi.advanceTimersByTimeAsync(VOICE_MOVE_FOLLOW_TIMEOUT_MS);
        await moving;
        expect(Modal.createDialog).toHaveBeenCalledWith(ErrorDialog, {
            title: "Couldn't move Bob",
            description: "Bob didn't follow the move. Only people using Aether can be moved to another channel.",
        });
    });

    it("says so when the homeserver refuses the request", async () => {
        vi.mocked(client.sendStateEvent).mockRejectedValue(new Error("M_FORBIDDEN"));
        await moveVoiceMember(client, GERAL1, BOB, GERAL2);
        expect(Modal.createDialog).toHaveBeenCalledWith(ErrorDialog, {
            title: "Couldn't move Bob",
            description: "M_FORBIDDEN",
        });
    });

    it("moves the user themselves directly", async () => {
        const dispatch = vi.spyOn(defaultDispatcher, "dispatch");
        await moveVoiceMember(client, GERAL1, MOD, GERAL2);
        expect(dispatch).toHaveBeenCalledWith({ action: Action.FollowVoiceMove, room_id: GERAL2 });
        expect(client.sendStateEvent).not.toHaveBeenCalled();
    });

    it("does nothing without the power to move people", async () => {
        makeRoom(GERAL1, RoomType.UnstableCall, 0);
        await moveVoiceMember(client, GERAL1, BOB, GERAL2);
        expect(client.sendStateEvent).not.toHaveBeenCalled();
    });

    it("does nothing for someone who is not in the call, or a channel of another server", async () => {
        await moveVoiceMember(client, GERAL1, "@carol:example.org", GERAL2);
        makeRoom("!lonely:example.org", RoomType.UnstableCall);
        await moveVoiceMember(client, GERAL1, BOB, "!lonely:example.org");
        expect(client.sendStateEvent).not.toHaveBeenCalled();
    });
});
