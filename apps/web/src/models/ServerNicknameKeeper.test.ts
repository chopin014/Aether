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
    MatrixError,
    MatrixEvent,
    Room,
    RoomStateEvent,
    RoomType,
    type MatrixClient,
} from "matrix-js-sdk/src/matrix";
import { KnownMembership } from "matrix-js-sdk/src/types";
import { stubClient } from "test-utils";

import { SERVER_NICKNAME_SETTLE_MS, ServerNicknameKeeper } from "./ServerNicknameKeeper";
import { MEMBER_NICK_EVENT_TYPE, memberNickStateKey, SERVER_NICKNAMES_EVENT_TYPE } from "../utils/serverNickname";

const ME = "@me:example.org";
const MOD = "@mod:example.org";
const SERVER = "!server:example.org";
const GENERAL = "!general:example.org";
const VOICE = "!voice:example.org";

describe("ServerNicknameKeeper", () => {
    let client: MatrixClient;
    let rooms: Map<string, Room>;
    let accountData: Record<string, object>;
    let keeper: ServerNicknameKeeper;

    const state = (roomId: string, type: string, content: object, stateKey = "", sender = MOD): MatrixEvent =>
        new MatrixEvent({ type, state_key: stateKey, room_id: roomId, sender, content });

    /** The user's own membership in a room, with the name the homeserver shows there. */
    const myMembership = (roomId: string, displayname: string): MatrixEvent =>
        state(
            roomId,
            EventType.RoomMember,
            { membership: KnownMembership.Join, displayname, avatar_url: "mxc://a/b" },
            ME,
            ME,
        );

    const makeRoom = (roomId: string, type?: string): Room => {
        const room = new Room(roomId, client, ME);
        room.currentState.setStateEvents([
            state(roomId, EventType.RoomCreate, { creator: MOD, room_version: "10", ...(type ? { type } : {}) }),
            myMembership(roomId, "Me"),
            state(roomId, EventType.RoomMember, { membership: KnownMembership.Join }, MOD, MOD),
            state(roomId, EventType.RoomPowerLevels, { users: { [MOD]: 50 }, users_default: 0, state_default: 50 }),
        ]);
        room.updateMyMembership(KnownMembership.Join);
        rooms.set(roomId, room);
        return room;
    };

    /** Something changes in a room, as it arrives through sync. */
    const arrive = (event: MatrixEvent): void => {
        const room = rooms.get(event.getRoomId()!)!;
        room.currentState.setStateEvents([event]);
        client.emit(RoomStateEvent.Events, event, room.currentState, null);
    };

    const setOwn = (nicknames: Record<string, string>, shown: Record<string, string> = {}): void => {
        accountData[SERVER_NICKNAMES_EVENT_TYPE] = { own: nicknames, shown };
        client.emit(ClientEvent.AccountData, new MatrixEvent({ type: SERVER_NICKNAMES_EVENT_TYPE, content: {} }));
    };

    const settle = async (): Promise<void> => {
        await vi.advanceTimersByTimeAsync(SERVER_NICKNAME_SETTLE_MS);
        await keeper.settled();
    };

    /** The names the keeper wrote, by room. */
    const written = (): Record<string, string> =>
        Object.fromEntries(
            vi
                .mocked(client.sendStateEvent)
                .mock.calls.filter(([, type]) => type === EventType.RoomMember)
                .map(([roomId, , content]) => [roomId, (content as { displayname: string }).displayname]),
        );

    beforeEach(() => {
        vi.useFakeTimers();
        client = stubClient();
        vi.spyOn(client, "getSafeUserId").mockReturnValue(ME);
        rooms = new Map();
        accountData = {};
        makeRoom(SERVER, RoomType.Space);
        makeRoom(GENERAL);
        makeRoom(VOICE, RoomType.UnstableCall);
        for (const child of [GENERAL, VOICE]) {
            rooms
                .get(SERVER)!
                .currentState.setStateEvents([state(SERVER, EventType.SpaceChild, { via: ["example.org"] }, child)]);
        }
        vi.mocked(client.getRooms).mockImplementation(() => [...rooms.values()]);
        vi.mocked(client.getRoom).mockImplementation((roomId) => rooms.get(roomId!) ?? null);
        vi.mocked(client.getAccountData).mockImplementation((type) =>
            accountData[type] ? new MatrixEvent({ type, content: accountData[type] }) : undefined,
        );
        vi.mocked(client.setAccountData).mockImplementation(async (type, content) => {
            accountData[type] = content as object;
            return {};
        });
        vi.mocked(client.getProfileInfo).mockResolvedValue({ displayname: "Me" });
        keeper = new (ServerNicknameKeeper as unknown as new () => ServerNicknameKeeper)();
    });

    afterEach(() => {
        keeper.stop();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("writes nothing while the user has no nickname", async () => {
        keeper.start(client);
        await settle();
        expect(client.sendStateEvent).not.toHaveBeenCalled();
        expect(client.setAccountData).not.toHaveBeenCalled();
    });

    it("writes the user's nickname into the server and each of its channels, keeping the rest of the membership", async () => {
        setOwn({ [SERVER]: "chopin" });
        keeper.start(client);
        await settle();
        expect(written()).toEqual({ [SERVER]: "chopin", [GENERAL]: "chopin", [VOICE]: "chopin" });
        expect(client.sendStateEvent).toHaveBeenCalledWith(
            GENERAL,
            EventType.RoomMember,
            { membership: KnownMembership.Join, displayname: "chopin", avatar_url: "mxc://a/b" },
            ME,
        );
        expect(accountData[SERVER_NICKNAMES_EVENT_TYPE]).toEqual({
            own: { [SERVER]: "chopin" },
            shown: { [SERVER]: "chopin" },
        });
    });

    it("skips rooms that already show it", async () => {
        arrive(myMembership(GENERAL, "chopin"));
        setOwn({ [SERVER]: "chopin" }, { [SERVER]: "chopin" });
        keeper.start(client);
        await settle();
        expect(Object.keys(written())).toEqual([SERVER, VOICE]);
    });

    it("writes it again when the homeserver replaces it, as changing the global name does", async () => {
        setOwn({ [SERVER]: "chopin" });
        keeper.start(client);
        await settle();
        for (const roomId of [SERVER, GENERAL, VOICE]) arrive(myMembership(roomId, "chopin"));
        vi.mocked(client.sendStateEvent).mockClear();

        arrive(myMembership(GENERAL, "New global name"));
        await settle();
        expect(written()).toEqual({ [GENERAL]: "chopin" });
    });

    it("prefers a moderator's nickname, and gives the user's own back when it is reset", async () => {
        setOwn({ [SERVER]: "chopin" });
        keeper.start(client);
        await settle();
        for (const roomId of [SERVER, GENERAL, VOICE]) arrive(myMembership(roomId, "chopin"));

        arrive(state(SERVER, MEMBER_NICK_EVENT_TYPE, { nick: "sdds" }, memberNickStateKey(ME)));
        await settle();
        expect(written()).toMatchObject({ [GENERAL]: "sdds" });
        for (const roomId of [SERVER, GENERAL, VOICE]) arrive(myMembership(roomId, "sdds"));

        vi.mocked(client.sendStateEvent).mockClear();
        arrive(state(SERVER, MEMBER_NICK_EVENT_TYPE, {}, memberNickStateKey(ME)));
        await settle();
        expect(written()).toEqual({ [SERVER]: "chopin", [GENERAL]: "chopin", [VOICE]: "chopin" });
    });

    it("applies a moderator's nickname that arrived before its server was stored", async () => {
        const server = rooms.get(SERVER)!;
        rooms.delete(SERVER);
        keeper.start(client);
        await settle();
        // A first sync of the server: its state comes in before the room is stored.
        const nick = state(SERVER, MEMBER_NICK_EVENT_TYPE, { nick: "sdds" }, memberNickStateKey(ME));
        server.currentState.setStateEvents([nick]);
        client.emit(RoomStateEvent.Events, nick, server.currentState, null);
        await settle();
        expect(written()).toEqual({});

        rooms.set(SERVER, server);
        client.emit(ClientEvent.Room, server);
        await settle();
        expect(written()).toEqual({ [SERVER]: "sdds", [GENERAL]: "sdds", [VOICE]: "sdds" });
    });

    it("puts the user's own name back where a nickname they reset still shows", async () => {
        for (const roomId of [SERVER, GENERAL]) arrive(myMembership(roomId, "chopin"));
        // The voice channel shows a name the user set some other way, which is left alone.
        arrive(myMembership(VOICE, "custom"));
        setOwn({}, { [SERVER]: "chopin" });
        keeper.start(client);
        await settle();
        expect(written()).toEqual({ [SERVER]: "Me", [GENERAL]: "Me" });
        expect(accountData[SERVER_NICKNAMES_EVENT_TYPE]).toEqual({ own: {}, shown: {} });
    });

    it("waits and tries again when the homeserver says it is sending too fast", async () => {
        vi.mocked(client.sendStateEvent)
            .mockRejectedValueOnce(new MatrixError({ errcode: "M_LIMIT_EXCEEDED", retry_after_ms: 2000 }, 429))
            .mockResolvedValue({ event_id: "$ok" });
        setOwn({ [SERVER]: "chopin" });
        keeper.start(client);
        await vi.advanceTimersByTimeAsync(SERVER_NICKNAME_SETTLE_MS);
        await vi.advanceTimersByTimeAsync(2000);
        await keeper.settled();
        expect(vi.mocked(client.sendStateEvent).mock.calls.filter(([roomId]) => roomId === SERVER)).toHaveLength(2);
        expect(written()).toEqual({ [SERVER]: "chopin", [GENERAL]: "chopin", [VOICE]: "chopin" });
    });

    it("stops listening once stopped", async () => {
        keeper.start(client);
        keeper.stop();
        setOwn({ [SERVER]: "chopin" });
        await vi.advanceTimersByTimeAsync(SERVER_NICKNAME_SETTLE_MS);
        expect(client.sendStateEvent).not.toHaveBeenCalled();
    });
});
