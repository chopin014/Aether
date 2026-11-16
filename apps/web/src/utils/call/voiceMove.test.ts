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
import { MatrixRTCSessionEvent, type MatrixRTCSession } from "matrix-js-sdk/src/matrixrtc";
import { stubClient } from "test-utils";

import {
    mayMoveVoiceMembers,
    requestVoiceMove,
    VOICE_MOVE_EVENT_TYPE,
    voiceMoveDestinations,
    voiceMoveDestinationVia,
    voiceMoveStateKey,
    waitForCallMember,
} from "./voiceMove";

const ME = "@me:example.org";
const MOD = "@mod:example.org";

/** A joined room of the given type with the moderator in it, who has power level 50 while the user has none. */
function makeTestRoom(
    client: MatrixClient,
    roomId: string,
    type?: string,
    powerLevels: object = { users: { [MOD]: 50 }, users_default: 0, state_default: 50 },
): Room {
    const room = new Room(roomId, client, ME);
    const state = (eventType: string, content: object, stateKey = ""): MatrixEvent =>
        new MatrixEvent({ type: eventType, state_key: stateKey, room_id: roomId, sender: ME, content });
    room.currentState.setStateEvents([
        state(EventType.RoomCreate, { creator: ME, room_version: "10", ...(type ? { type } : {}) }),
        state(EventType.RoomMember, { membership: KnownMembership.Join }, ME),
        state(EventType.RoomMember, { membership: KnownMembership.Join }, MOD),
        state(EventType.RoomPowerLevels, powerLevels),
    ]);
    room.updateMyMembership(KnownMembership.Join);
    room.name = roomId.slice(1, roomId.indexOf(":"));
    return room;
}

/** Makes `space` hold `child` as one of its channels. */
function addChild(space: Room, childId: string, via: string[] = ["example.org"], order?: string): void {
    space.currentState.setStateEvents([
        new MatrixEvent({
            type: EventType.SpaceChild,
            state_key: childId,
            room_id: space.roomId,
            sender: ME,
            content: { via, ...(order ? { order } : {}) },
            origin_server_ts: 1,
        }),
    ]);
}

describe("voiceMove", () => {
    let client: MatrixClient;
    let rooms: Map<string, Room>;
    let server: Room;
    let geral1: Room;
    let geral2: Room;
    let afk: Room;

    beforeEach(() => {
        client = stubClient();
        vi.spyOn(client, "getSafeUserId").mockReturnValue(ME);
        rooms = new Map();
        const add = (room: Room): Room => {
            rooms.set(room.roomId, room);
            return room;
        };
        server = add(makeTestRoom(client, "!server:example.org", RoomType.Space));
        geral1 = add(makeTestRoom(client, "!geral1:example.org", RoomType.UnstableCall));
        geral2 = add(makeTestRoom(client, "!geral2:example.org", RoomType.UnstableCall));
        afk = add(makeTestRoom(client, "!afk:example.org", RoomType.UnstableCall));
        const chat = add(makeTestRoom(client, "!chat:example.org"));
        const removed = add(makeTestRoom(client, "!removed:example.org", RoomType.UnstableCall));
        const elsewhere = add(makeTestRoom(client, "!other:example.org", RoomType.Space));
        const otherVoice = add(makeTestRoom(client, "!othervoice:example.org", RoomType.UnstableCall));
        addChild(server, geral1.roomId, ["example.org"], "a");
        addChild(server, afk.roomId, ["example.org"], "c");
        addChild(server, geral2.roomId, ["example.org", "matrix.org"], "b");
        addChild(server, chat.roomId);
        addChild(server, removed.roomId, []);
        addChild(elsewhere, otherVoice.roomId);
        vi.mocked(client.getRooms).mockImplementation(() => [...rooms.values()]);
        vi.mocked(client.getRoom).mockImplementation((roomId) => rooms.get(roomId!) ?? null);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("keys a request by user without starting with their ID, which only they could send", () => {
        expect(voiceMoveStateKey("@bob:example.org")).toBe("u:@bob:example.org");
        expect(voiceMoveStateKey("@bob:example.org").startsWith("@")).toBe(false);
    });

    it("lets only those with the event's power level move people, and only out of voice channels", () => {
        expect(mayMoveVoiceMembers(geral1, MOD)).toBe(true);
        expect(mayMoveVoiceMembers(geral1, ME)).toBe(false);
        expect(mayMoveVoiceMembers(rooms.get("!chat:example.org")!, MOD)).toBe(false);

        const open = makeTestRoom(client, "!open:example.org", RoomType.UnstableCall, {
            users: {},
            users_default: 0,
            state_default: 50,
            events: { [VOICE_MOVE_EVENT_TYPE]: 0 },
        });
        expect(mayMoveVoiceMembers(open, ME)).toBe(true);
    });

    it("offers the other voice channels of the same server, in the server's order", () => {
        expect(voiceMoveDestinations(client, geral1).map((room) => room.roomId)).toEqual([
            "!geral2:example.org",
            "!afk:example.org",
        ]);
        // A channel outside any server the user is in can go nowhere.
        expect(voiceMoveDestinations(client, rooms.get("!removed:example.org")!)).toEqual([]);
    });

    it("finds how to join a destination only within the same server", () => {
        expect(voiceMoveDestinationVia(client, geral1.roomId, geral2.roomId)).toEqual(["example.org", "matrix.org"]);
        expect(voiceMoveDestinationVia(client, geral1.roomId, "!othervoice:example.org")).toBeUndefined();
        expect(voiceMoveDestinationVia(client, geral1.roomId, "!removed:example.org")).toBeUndefined();
        expect(voiceMoveDestinationVia(client, geral1.roomId, "!unknown:example.org")).toBeUndefined();
    });

    it("sends the request about the person to the channel they are in", async () => {
        await requestVoiceMove(client, geral1.roomId, "@bob:example.org", geral2.roomId);
        expect(client.sendStateEvent).toHaveBeenCalledWith(
            geral1.roomId,
            VOICE_MOVE_EVENT_TYPE,
            { to: geral2.roomId, id: expect.any(String) },
            "u:@bob:example.org",
        );
    });

    describe("waitForCallMember", () => {
        let session: MatrixRTCSession;

        beforeEach(() => {
            session = Object.assign(new EventEmitter(), { memberships: [] }) as unknown as MatrixRTCSession;
            vi.mocked(client.matrixRTC.getRoomSession).mockReturnValue(session);
        });

        it("resolves once the person turns up in the call", async () => {
            const arrived = waitForCallMember(client, geral2, "@bob:example.org", true, 1000);
            session.memberships = [{ userId: "@bob:example.org" }] as never;
            session.emit(MatrixRTCSessionEvent.MembershipsChanged, [], session.memberships);
            await expect(arrived).resolves.toBe(true);
        });

        it("resolves at once when it already happened", async () => {
            await expect(waitForCallMember(client, geral2, "@bob:example.org", false, 1000)).resolves.toBe(true);
        });

        it("gives up after the timeout", async () => {
            vi.useFakeTimers();
            const arrived = waitForCallMember(client, geral2, "@bob:example.org", true, 1000);
            vi.advanceTimersByTime(1000);
            await expect(arrived).resolves.toBe(false);
            expect(session.listenerCount(MatrixRTCSessionEvent.MembershipsChanged)).toBe(0);
        });
    });
});
