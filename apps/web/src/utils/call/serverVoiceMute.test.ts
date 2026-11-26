/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    ClientEvent,
    EventType,
    MatrixEvent,
    Room,
    RoomEvent,
    RoomStateEvent,
    RoomType,
    type MatrixClient,
} from "matrix-js-sdk/src/matrix";
import { KnownMembership } from "matrix-js-sdk/src/types";
import { stubClient } from "test-utils";

import {
    getServerVoiceMute,
    moderatedVoiceMute,
    onServerVoiceMutesChanged,
    SERVER_VOICE_MUTE_EVENT_TYPE,
    serverVoiceMuteStateKey,
    setServerVoiceMute,
} from "./serverVoiceMute";

const ME = "@me:example.org";
const MOD = "@mod:example.org";
const BOB = "@bob:example.org";
const VOICE = "!voice:example.org";

describe("serverVoiceMute", () => {
    let client: MatrixClient;
    let rooms: Map<string, Room>;
    let server: Room;
    let other: Room;

    const state = (room: Room, type: string, content: object, stateKey = "", sender = ME): MatrixEvent =>
        new MatrixEvent({ type, state_key: stateKey, room_id: room.roomId, sender, content });

    const makeRoom = (roomId: string, type?: string): Room => {
        const room = new Room(roomId, client, ME);
        room.currentState.setStateEvents([
            state(room, EventType.RoomCreate, { creator: ME, room_version: "10", ...(type ? { type } : {}) }),
            state(room, EventType.RoomMember, { membership: KnownMembership.Join }, ME, ME),
            state(room, EventType.RoomMember, { membership: KnownMembership.Join }, MOD, MOD),
            state(room, EventType.RoomPowerLevels, { users: { [MOD]: 50 }, users_default: 0, state_default: 50 }),
        ]);
        room.updateMyMembership(KnownMembership.Join);
        rooms.set(roomId, room);
        return room;
    };

    const record = (space: Room, userId: string, content: object): void =>
        space.currentState.setStateEvents([
            state(space, SERVER_VOICE_MUTE_EVENT_TYPE, content, serverVoiceMuteStateKey(userId), MOD),
        ]);

    beforeEach(() => {
        client = stubClient();
        vi.spyOn(client, "getSafeUserId").mockReturnValue(MOD);
        rooms = new Map();
        server = makeRoom("!server:example.org", RoomType.Space);
        other = makeRoom("!other:example.org", RoomType.Space);
        makeRoom(VOICE, RoomType.UnstableCall);
        makeRoom("!chat:example.org");
        for (const [space, child] of [
            [server, VOICE],
            [server, "!chat:example.org"],
        ] as const) {
            space.currentState.setStateEvents([state(space, EventType.SpaceChild, { via: ["example.org"] }, child)]);
        }
        vi.mocked(client.getRooms).mockImplementation(() => [...rooms.values()]);
        vi.mocked(client.getRoom).mockImplementation((roomId) => rooms.get(roomId!) ?? null);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("keys a record by user without starting with their ID, which only they could send", () => {
        expect(serverVoiceMuteStateKey(BOB)).toBe(`u:${BOB}`);
    });

    it("reads a mute from a server holding the channel, and a deafen as a mute too", () => {
        expect(getServerVoiceMute(client, VOICE, BOB)).toEqual({ muted: false, deafened: false });
        record(server, BOB, { muted: true });
        expect(getServerVoiceMute(client, VOICE, BOB)).toEqual({ muted: true, deafened: false });
        record(server, BOB, { deafened: true });
        expect(getServerVoiceMute(client, VOICE, BOB)).toEqual({ muted: true, deafened: true });
        record(server, BOB, {});
        expect(getServerVoiceMute(client, VOICE, BOB)).toEqual({ muted: false, deafened: false });
    });

    it("ignores servers that do not hold the channel", () => {
        record(other, BOB, { deafened: true });
        expect(getServerVoiceMute(client, VOICE, BOB)).toEqual({ muted: false, deafened: false });
    });

    it("lets only those with the event's power level mute people, and only in voice channels", () => {
        expect(moderatedVoiceMute(client, VOICE, MOD, BOB)).toEqual({ muted: false, deafened: false });
        expect(moderatedVoiceMute(client, VOICE, ME, BOB)).toBeUndefined();
        expect(moderatedVoiceMute(client, "!chat:example.org", MOD, BOB)).toBeUndefined();
    });

    it.each([
        [{}, { muted: true }, { muted: true }],
        [{ muted: true }, { deafened: true }, { muted: true, deafened: true }],
        // Undeafening keeps the mute; unmuting lifts the deafen too.
        [{ muted: true, deafened: true }, { deafened: false }, { muted: true }],
        [{ muted: true, deafened: true }, { muted: false }, {}],
    ])("changes %j with %j into %j", async (before, change, after) => {
        record(server, BOB, before);
        await setServerVoiceMute(client, VOICE, BOB, change);
        expect(client.sendStateEvent).toHaveBeenCalledWith(
            server.roomId,
            SERVER_VOICE_MUTE_EVENT_TYPE,
            after,
            serverVoiceMuteStateKey(BOB),
        );
    });

    it("reads the record a moderator would change, in the server where they may mute people", () => {
        record(other, BOB, { muted: true });
        other.currentState.setStateEvents([state(other, EventType.SpaceChild, { via: ["example.org"] }, VOICE)]);
        other.currentState.setStateEvents([
            state(other, EventType.RoomPowerLevels, { users: {}, users_default: 0, state_default: 50 }),
        ]);
        expect(getServerVoiceMute(client, VOICE, BOB)).toEqual({ muted: true, deafened: false });
        expect(moderatedVoiceMute(client, VOICE, MOD, BOB)).toEqual({ muted: false, deafened: false });
        record(server, BOB, { deafened: true });
        expect(moderatedVoiceMute(client, VOICE, MOD, BOB)).toEqual({ muted: true, deafened: true });
        expect(moderatedVoiceMute(client, VOICE, ME, BOB)).toBeUndefined();
    });

    it("lets a moderator of two servers holding the channel see and lift a mute set in either", async () => {
        other.currentState.setStateEvents([state(other, EventType.SpaceChild, { via: ["example.org"] }, VOICE)]);
        record(other, BOB, { muted: true });
        expect(moderatedVoiceMute(client, VOICE, MOD, BOB)).toEqual({ muted: true, deafened: false });

        await setServerVoiceMute(client, VOICE, BOB, { muted: false });
        // Only the server holding the mute gets the lifted record.
        expect(client.sendStateEvent).toHaveBeenCalledTimes(1);
        expect(client.sendStateEvent).toHaveBeenCalledWith(
            other.roomId,
            SERVER_VOICE_MUTE_EVENT_TYPE,
            {},
            serverVoiceMuteStateKey(BOB),
        );

        // With no record anywhere, a new mute goes to the first of them.
        record(other, BOB, {});
        vi.mocked(client.sendStateEvent).mockClear();
        await setServerVoiceMute(client, VOICE, BOB, { deafened: true });
        expect(client.sendStateEvent).toHaveBeenCalledTimes(1);
        expect(client.sendStateEvent).toHaveBeenCalledWith(
            server.roomId,
            SERVER_VOICE_MUTE_EVENT_TYPE,
            { muted: true, deafened: true },
            serverVoiceMuteStateKey(BOB),
        );
    });

    it("lifts a deafen only where it was set, leaving the other server's records as they are", async () => {
        other.currentState.setStateEvents([state(other, EventType.SpaceChild, { via: ["example.org"] }, VOICE)]);
        // The other server's mute was lifted by its own moderators, which has not arrived here yet: writing it again
        // would set it back.
        record(server, BOB, { muted: true, deafened: true });
        record(other, BOB, { muted: true });
        await setServerVoiceMute(client, VOICE, BOB, { deafened: false });
        expect(client.sendStateEvent).toHaveBeenCalledTimes(1);
        expect(client.sendStateEvent).toHaveBeenCalledWith(
            server.roomId,
            SERVER_VOICE_MUTE_EVENT_TYPE,
            { muted: true },
            serverVoiceMuteStateKey(BOB),
        );
    });

    it("refuses to change anything without the power", async () => {
        vi.mocked(client.getSafeUserId).mockReturnValue(ME);
        await expect(setServerVoiceMute(client, VOICE, BOB, { muted: true })).rejects.toThrow();
        expect(client.sendStateEvent).not.toHaveBeenCalled();
    });

    it("tells listeners about mutes and server changes, until they stop listening", () => {
        const listener = vi.fn();
        const stop = onServerVoiceMutesChanged(client, listener);
        const emit = (type: string): void => {
            client.emit(RoomStateEvent.Events, state(server, type, {}, "x"), server.currentState, null);
        };
        emit(SERVER_VOICE_MUTE_EVENT_TYPE);
        emit(EventType.SpaceChild);
        emit(EventType.RoomTopic);
        expect(listener).toHaveBeenCalledTimes(2);
        stop();
        emit(SERVER_VOICE_MUTE_EVENT_TYPE);
        expect(listener).toHaveBeenCalledTimes(2);
    });

    it("tells listeners when the user joins or leaves a server, whose records may have arrived first", () => {
        const listener = vi.fn();
        const stop = onServerVoiceMutesChanged(client, listener);
        client.emit(RoomEvent.MyMembership, server, KnownMembership.Join, KnownMembership.Invite);
        client.emit(ClientEvent.Room, other);
        expect(listener).toHaveBeenCalledTimes(2);
        client.emit(RoomEvent.MyMembership, rooms.get("!chat:example.org")!, KnownMembership.Leave);
        expect(listener).toHaveBeenCalledTimes(2);
        stop();
    });
});
