/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import EventEmitter from "node:events";
import {
    ClientEvent,
    EventType,
    MatrixEvent,
    Room,
    RoomStateEvent,
    RoomType,
    type MatrixClient,
} from "matrix-js-sdk/src/matrix";
import { KnownMembership } from "matrix-js-sdk/src/types";
import { type CallMembership, type MatrixRTCSession } from "matrix-js-sdk/src/matrixrtc";
import { stubClient } from "test-utils";

import { VoiceMoveFollower, VOICE_MOVE_MAX_AGE_MS } from "./VoiceMoveFollower";
import { VOICE_MOVE_EVENT_TYPE } from "../utils/call/voiceMove";

const ME = "@me:example.org";
const MOD = "@mod:example.org";
const BOB = "@bob:example.org";
const SERVER = "!server:example.org";
const GERAL1 = "!geral1:example.org";
const GERAL2 = "!geral2:example.org";
const ELSEWHERE = "!elsewhere:example.org";

describe("VoiceMoveFollower", () => {
    let client: MatrixClient;
    let rooms: Map<string, Room>;
    let inCall: Set<string>;
    let follow: Mock<(room: Room) => void>;
    let disconnect: Mock<(room: Room) => void>;
    let follower: VoiceMoveFollower;
    let sessions: Map<string, MatrixRTCSession>;

    const makeRoom = (roomId: string, type?: string): Room => {
        const room = new Room(roomId, client, ME);
        const state = (eventType: string, content: object, stateKey = ""): MatrixEvent =>
            new MatrixEvent({ type: eventType, state_key: stateKey, room_id: roomId, sender: ME, content });
        room.currentState.setStateEvents([
            state(EventType.RoomCreate, { creator: ME, room_version: "10", ...(type ? { type } : {}) }),
            state(EventType.RoomMember, { membership: KnownMembership.Join }, ME),
            state(EventType.RoomMember, { membership: KnownMembership.Join }, MOD),
            state(EventType.RoomMember, { membership: KnownMembership.Join }, BOB),
            state(EventType.RoomPowerLevels, { users: { [MOD]: 50 }, users_default: 0, state_default: 50 }),
        ]);
        room.updateMyMembership(KnownMembership.Join);
        rooms.set(roomId, room);
        return room;
    };

    /** A move request as it arrives through sync. */
    const request = (
        content: object,
        {
            sender = MOD,
            stateKey = `u:${ME}`,
            age = 0,
            roomId = GERAL1,
            ts,
        }: { sender?: string; stateKey?: string; age?: number; roomId?: string; ts?: number } = {},
    ): MatrixEvent =>
        new MatrixEvent({
            type: VOICE_MOVE_EVENT_TYPE,
            state_key: stateKey,
            room_id: roomId,
            sender,
            content,
            event_id: `$${Math.random()}`,
            origin_server_ts: ts ?? Date.now() - age,
            unsigned: { age },
        });

    const receive = async (event: MatrixEvent): Promise<void> => {
        client.emit(RoomStateEvent.Events, event, rooms.get(event.getRoomId()!)!.currentState, null);
        // The follower checks and joins asynchronously.
        await new Promise((resolve) => setTimeout(resolve, 0));
    };

    beforeEach(() => {
        client = stubClient();
        vi.spyOn(client, "getSafeUserId").mockReturnValue(ME);
        vi.spyOn(client, "getDeviceId").mockReturnValue("DEVICE");
        rooms = new Map();
        sessions = new Map();
        const server = makeRoom(SERVER, RoomType.Space);
        makeRoom(GERAL1, RoomType.UnstableCall);
        makeRoom(GERAL2, RoomType.UnstableCall);
        const other = makeRoom("!other:example.org", RoomType.Space);
        for (const [space, child] of [
            [server, GERAL1],
            [server, GERAL2],
            [other, ELSEWHERE],
        ] as const) {
            space.currentState.setStateEvents([
                new MatrixEvent({
                    type: EventType.SpaceChild,
                    state_key: child,
                    room_id: space.roomId,
                    sender: ME,
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
        inCall = new Set([GERAL1]);
        follow = vi.fn();
        disconnect = vi.fn();
        follower = new VoiceMoveFollower(client, (roomId) => inCall.has(roomId), follow, disconnect);
    });

    afterEach(() => {
        follower.dispose();
        vi.restoreAllMocks();
    });

    it("follows a moderator who moves this user to another channel of the same server", async () => {
        await receive(request({ to: GERAL2, id: "a" }));
        expect(follow).toHaveBeenCalledWith(rooms.get(GERAL2));
    });

    it("joins the destination first when the user is not in it yet", async () => {
        const destination = rooms.get(GERAL2)!;
        rooms.delete(GERAL2);
        vi.mocked(client.joinRoom).mockImplementation(async () => {
            rooms.set(GERAL2, destination);
            return destination;
        });
        await receive(request({ to: GERAL2, id: "a" }));
        expect(client.joinRoom).toHaveBeenCalledWith(GERAL2, { viaServers: ["example.org"] });
        expect(follow).toHaveBeenCalledWith(destination);
    });

    it("leaves the call when a moderator disconnects this user", async () => {
        await receive(request({ id: "a" }));
        expect(disconnect).toHaveBeenCalledWith(rooms.get(GERAL1));
        expect(follow).not.toHaveBeenCalled();
    });

    it("ignores a disconnect from someone without the power, or about a call this device is not in", async () => {
        await receive(request({ id: "a" }, { sender: BOB }));
        inCall.clear();
        await receive(request({ id: "b" }));
        expect(disconnect).not.toHaveBeenCalled();
    });

    /** A move request as it arrives through the call's media room, as an Olm-decrypted to-device message. */
    const fast = async (
        content: object,
        {
            sender = MOD,
            olmSender = sender,
            encrypted = true,
        }: { sender?: string; olmSender?: string; encrypted?: boolean } = {},
    ): Promise<void> => {
        client.emit(ClientEvent.ReceivedToDeviceMessage, {
            message: {
                type: VOICE_MOVE_EVENT_TYPE,
                sender,
                content: { room_id: GERAL1, ts: Date.now(), ...content },
            },
            encryptionInfo: encrypted
                ? { sender: olmSender, senderDevice: "MODDEVICE", senderCurve25519KeyBase64: "", senderVerified: false }
                : null,
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
    };

    it("follows a move that comes through the call's media room", async () => {
        await fast({ to: GERAL2, id: "a" });
        expect(follow).toHaveBeenCalledWith(rooms.get(GERAL2));
    });

    it.each([
        ["not Olm encrypted", { encrypted: false }],
        ["whose sender Olm did not authenticate", { olmSender: BOB }],
        ["from someone without the power to move people", { sender: BOB }],
    ])("ignores a move through the media room %s", async (_, options) => {
        await fast({ to: GERAL2, id: "a" }, options);
        expect(follow).not.toHaveBeenCalled();
    });

    it("ignores a move through the media room sent before this device joined the call", async () => {
        const session = client.matrixRTC.getRoomSession(rooms.get(GERAL1)!);
        session.memberships = [
            { userId: ME, deviceId: "DEVICE", createdTs: () => Date.now() } as unknown as CallMembership,
        ];
        await fast({ to: GERAL2, id: "a", ts: Date.now() - 5000 });
        expect(follow).not.toHaveBeenCalled();
    });

    it("follows the state event of a request whose fast copy it turned down", async () => {
        // The moderator's clock is far behind: the copy through the media room looks too old.
        await fast({ to: GERAL2, id: "a", ts: Date.now() - VOICE_MOVE_MAX_AGE_MS - 5000 });
        expect(follow).not.toHaveBeenCalled();
        await receive(request({ to: GERAL2, id: "a" }));
        expect(follow).toHaveBeenCalledOnce();
    });

    it("lets nobody without the power to move people use up a request's id", async () => {
        await fast({ to: GERAL2, id: "a" }, { sender: BOB });
        await receive(request({ to: GERAL2, id: "a" }));
        expect(follow).toHaveBeenCalledOnce();
    });

    it("follows a request once, whichever way it arrives first", async () => {
        await fast({ to: GERAL2, id: "a" });
        await receive(request({ to: GERAL2, id: "a" }));
        expect(follow).toHaveBeenCalledTimes(1);
    });

    it("follows each request once", async () => {
        const event = request({ to: GERAL2, id: "a" });
        await receive(event);
        await receive(event);
        expect(follow).toHaveBeenCalledTimes(1);
    });

    it.each([
        ["someone without the power to move people", { sender: BOB }],
        ["a request about somebody else", { stateKey: `u:${BOB}` }],
        ["a request older than a minute", { age: VOICE_MOVE_MAX_AGE_MS + 1 }],
    ])("ignores %s", async (_, options) => {
        await receive(request({ to: GERAL2, id: "a" }, options));
        expect(follow).not.toHaveBeenCalled();
    });

    it("ignores requests while this device is not in the channel's call", async () => {
        inCall.clear();
        await receive(request({ to: GERAL2, id: "a" }));
        expect(follow).not.toHaveBeenCalled();
    });

    it("ignores a request sent before this device joined the call", async () => {
        const session = client.matrixRTC.getRoomSession(rooms.get(GERAL1)!);
        session.memberships = [
            { userId: ME, deviceId: "DEVICE", createdTs: () => Date.now() } as unknown as CallMembership,
        ];
        await receive(request({ to: GERAL2, id: "a" }, { ts: Date.now() - 5000 }));
        expect(follow).not.toHaveBeenCalled();
    });

    it("never goes to a channel of another server, nor to something that is not a voice channel", async () => {
        await receive(request({ to: ELSEWHERE, id: "a" }));
        await receive(request({ to: GERAL1, id: "b" }));
        await receive(request({ to: 42, id: "c" }));
        await receive(request({ to: SERVER, id: "d" }));
        expect(client.joinRoom).not.toHaveBeenCalled();
        expect(follow).not.toHaveBeenCalled();
    });

    it("stops following once disposed", async () => {
        follower.dispose();
        await receive(request({ to: GERAL2, id: "a" }));
        expect(follow).not.toHaveBeenCalled();
    });
});
