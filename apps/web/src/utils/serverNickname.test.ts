/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventType, MatrixEvent, Room, RoomType, type MatrixClient } from "matrix-js-sdk/src/matrix";
import { KnownMembership } from "matrix-js-sdk/src/types";
import { stubClient } from "test-utils";

import {
    currentNickname,
    desiredNickname,
    mayChangeNickname,
    MEMBER_NICK_EVENT_TYPE,
    memberNickStateKey,
    moderatorNickname,
    readServerNicknames,
    roomsOfServer,
    serverOfRoom,
    SERVER_NICKNAMES_EVENT_TYPE,
    setNickname,
} from "./serverNickname";

const ME = "@me:example.org";
const MOD = "@mod:example.org";
const ADMIN = "@admin:example.org";
const BOB = "@bob:example.org";

describe("serverNickname", () => {
    let client: MatrixClient;
    let rooms: Map<string, Room>;
    let server: Room;
    let accountData: Record<string, object>;

    const state = (room: Room, type: string, content: object, stateKey = "", sender = ADMIN): MatrixEvent =>
        new MatrixEvent({ type, state_key: stateKey, room_id: room.roomId, sender, content });

    const makeRoom = (roomId: string, type?: string, membership: string = KnownMembership.Join): Room => {
        const room = new Room(roomId, client, ME);
        room.currentState.setStateEvents([
            state(room, EventType.RoomCreate, { creator: ADMIN, room_version: "10", ...(type ? { type } : {}) }),
            ...[ME, MOD, ADMIN, BOB].map((userId) =>
                state(room, EventType.RoomMember, { membership: KnownMembership.Join }, userId, userId),
            ),
            state(room, EventType.RoomPowerLevels, {
                users: { [ADMIN]: 100, [MOD]: 50 },
                users_default: 0,
                state_default: 50,
            }),
        ]);
        room.updateMyMembership(membership);
        rooms.set(roomId, room);
        return room;
    };

    const nickRecord = (userId: string, content: object, sender = MOD): void =>
        server.currentState.setStateEvents([
            state(server, MEMBER_NICK_EVENT_TYPE, content, memberNickStateKey(userId), sender),
        ]);

    beforeEach(() => {
        client = stubClient();
        vi.spyOn(client, "getSafeUserId").mockReturnValue(ME);
        rooms = new Map();
        accountData = {};
        server = makeRoom("!server:example.org", RoomType.Space);
        makeRoom("!general:example.org");
        makeRoom("!voice:example.org", RoomType.UnstableCall);
        makeRoom("!notjoined:example.org", undefined, KnownMembership.Leave);
        for (const child of ["!general:example.org", "!voice:example.org", "!notjoined:example.org"]) {
            server.currentState.setStateEvents([state(server, EventType.SpaceChild, { via: ["example.org"] }, child)]);
        }
        server.currentState.setStateEvents([state(server, EventType.SpaceChild, {}, "!removed:example.org")]);
        makeRoom("!removed:example.org");
        vi.mocked(client.getRooms).mockImplementation(() => [...rooms.values()]);
        vi.mocked(client.getRoom).mockImplementation((roomId) => rooms.get(roomId!) ?? null);
        vi.mocked(client.getAccountData).mockImplementation((type) =>
            accountData[type] ? new MatrixEvent({ type, content: accountData[type] }) : undefined,
        );
        vi.mocked(client.setAccountData).mockImplementation(async (type, content) => {
            accountData[type] = content as object;
            return {};
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("keys a moderator's record by user without starting with their ID, which only they could send", () => {
        expect(memberNickStateKey(BOB)).toBe(`u:${BOB}`);
    });

    it("finds the server of a channel, and the rooms of a server the user is in", () => {
        expect(serverOfRoom(client, rooms.get("!general:example.org")!)).toBe(server);
        expect(serverOfRoom(client, server)).toBe(server);
        expect(serverOfRoom(client, rooms.get("!removed:example.org")!)).toBeUndefined();
        expect(roomsOfServer(client, server).map((room) => room.roomId)).toEqual([
            "!server:example.org",
            "!general:example.org",
            "!voice:example.org",
        ]);
    });

    it("lets anyone change their own nickname, and moderators those of people below them", () => {
        expect(mayChangeNickname(server, ME, ME)).toBe(true);
        expect(mayChangeNickname(server, MOD, BOB)).toBe(true);
        expect(mayChangeNickname(server, BOB, ME)).toBe(false);
        expect(mayChangeNickname(server, MOD, ADMIN)).toBe(false);
        expect(mayChangeNickname(server, ADMIN, MOD)).toBe(true);
    });

    it("honours a moderator's nickname only from someone who may still give it", () => {
        expect(moderatorNickname(server, BOB)).toBeUndefined();
        nickRecord(BOB, { nick: "  sdds do litz  " });
        expect(moderatorNickname(server, BOB)).toBe("sdds do litz");
        nickRecord(BOB, { nick: "x".repeat(40) });
        expect(moderatorNickname(server, BOB)).toHaveLength(32);
        nickRecord(BOB, { nick: "" });
        expect(moderatorNickname(server, BOB)).toBeUndefined();
        // A moderator cannot rename an admin; nor can someone without the power.
        nickRecord(ADMIN, { nick: "boss" });
        expect(moderatorNickname(server, ADMIN)).toBeUndefined();
        nickRecord(BOB, { nick: "bob" }, ME);
        expect(moderatorNickname(server, BOB)).toBeUndefined();
    });

    it("honours a moderator's nickname when the Space has not loaded the moderator's membership", () => {
        const sparse = new Room("!sparse:example.org", client, ME);
        sparse.currentState.setStateEvents([
            state(sparse, EventType.RoomCreate, { creator: ADMIN, room_version: "10", type: RoomType.Space }),
            state(sparse, EventType.RoomMember, { membership: KnownMembership.Join }, BOB, BOB),
            state(sparse, EventType.RoomPowerLevels, { users: { [MOD]: 50 }, users_default: 0, state_default: 50 }),
            state(sparse, MEMBER_NICK_EVENT_TYPE, { nick: "sdds do litz" }, memberNickStateKey(BOB), MOD),
        ]);
        expect(sparse.getMember(MOD)).toBeNull();
        expect(moderatorNickname(sparse, BOB)).toBe("sdds do litz");
    });

    it("reads the user's own nicknames defensively", () => {
        accountData[SERVER_NICKNAMES_EVENT_TYPE] = { own: { a: "x", b: 3 }, shown: "nope" };
        expect(readServerNicknames(client)).toEqual({ own: { a: "x" }, shown: {} });
    });

    it("prefers a moderator's nickname to the one the user chose", async () => {
        expect(desiredNickname(client, server)).toBeUndefined();
        await setNickname(client, server, ME, "  chopin ");
        expect(accountData[SERVER_NICKNAMES_EVENT_TYPE]).toEqual({ own: { [server.roomId]: "chopin" }, shown: {} });
        expect(desiredNickname(client, server)).toBe("chopin");
        expect(currentNickname(client, server, ME)).toBe("chopin");
        nickRecord(ME, { nick: "renamed" });
        expect(desiredNickname(client, server)).toBe("renamed");
        await setNickname(client, server, ME, "");
        expect(accountData[SERVER_NICKNAMES_EVENT_TYPE]).toEqual({ own: {}, shown: {} });
    });

    it("records a moderator's nickname for someone else in the server, and resets it", async () => {
        await setNickname(client, server, BOB, "litz");
        expect(client.sendStateEvent).toHaveBeenLastCalledWith(
            server.roomId,
            MEMBER_NICK_EVENT_TYPE,
            { nick: "litz" },
            memberNickStateKey(BOB),
        );
        await setNickname(client, server, BOB, " ");
        expect(client.sendStateEvent).toHaveBeenLastCalledWith(
            server.roomId,
            MEMBER_NICK_EVENT_TYPE,
            {},
            memberNickStateKey(BOB),
        );
    });
});
