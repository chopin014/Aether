/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import {
    ClientEvent,
    createClient,
    EventType,
    MatrixEvent,
    type ReceivedToDeviceMessage,
    Room,
    TypedEventEmitter,
    type MatrixClient,
} from "matrix-js-sdk/src/matrix";
import { MatrixRTCSession, MatrixRTCSessionEvent } from "matrix-js-sdk/src/matrixrtc";

/* oxlint-disable no-restricted-imports -- Exercise the patched SDK fast lane, which has no public entry point. */
import {
    type CallCarrier,
    HELLO_EVENT_TYPE,
    participationOf,
    PROVISIONAL_MEMBERSHIP_MS,
    sendSealed,
} from "matrix-js-sdk/src/matrixrtc/AetherFastLane";
import { type CallMembership } from "matrix-js-sdk/src/matrixrtc/CallMembership";
import { RTCEncryptionManager } from "matrix-js-sdk/src/matrixrtc/RTCEncryptionManager";
import { ToDeviceKeyTransport } from "matrix-js-sdk/src/matrixrtc/ToDeviceKeyTransport";
import {
    type IKeyTransport,
    KeyTransportEvents,
    type KeyTransportEventsHandlerMap,
} from "matrix-js-sdk/src/matrixrtc/IKeyTransport";
/* oxlint-enable no-restricted-imports */

/** A carrier that reaches the given devices and records what it sends. */
function carrier(reachable: string[]): CallCarrier & { sent: { to: string; type: string; content: unknown }[] } {
    const sent: { to: string; type: string; content: unknown }[] = [];
    return {
        sent,
        canReach: (userId, deviceId) => reachable.includes(`${userId}|${deviceId}`),
        send: (userId, deviceId, message) => sent.push({ to: `${userId}|${deviceId}`, ...message }),
    };
}

type Device = { userId: string; deviceId: string };

/** Stands in for the crypto layer: each device gets a distinct "ciphertext" naming it. */
function crypto(): {
    encryptToDeviceMessages: Mock<
        (eventType: string, devices: Device[], payload: object) => Promise<{ eventType: string; batch: object[] }>
    >;
} {
    let counter = 0;
    return {
        encryptToDeviceMessages: vi.fn(async (eventType: string, devices: Device[], payload: object) => ({
            eventType: EventType.RoomMessageEncrypted,
            batch: devices.map(({ userId, deviceId }) => ({
                userId,
                deviceId,
                payload: { ciphertext: `${eventType}#${++counter}`, for: `${userId}|${deviceId}`, payload },
            })),
        })),
    };
}

describe("sendSealed", () => {
    it("encrypts a message of its own for each device the carrier reaches, and sends it there", async () => {
        const c = crypto();
        const lane = carrier(["@bob:x|BOB", "@carol:x|CAROL"]);
        const sent = await sendSealed(
            { getCrypto: () => c } as never,
            lane,
            "m.test",
            [
                { userId: "@bob:x", deviceId: "BOB" },
                { userId: "@dave:x", deviceId: "DAVE" },
                { userId: "@carol:x", deviceId: "CAROL" },
            ],
            { hello: 1 },
        );
        expect(sent).toEqual([
            { userId: "@bob:x", deviceId: "BOB" },
            { userId: "@carol:x", deviceId: "CAROL" },
        ]);
        // Dave is not in the media room, so nothing is encrypted for him.
        expect(c.encryptToDeviceMessages.mock.calls[0]![1]).toHaveLength(2);
        expect(lane.sent.map(({ to, type }) => [to, type])).toEqual([
            ["@bob:x|BOB", EventType.RoomMessageEncrypted],
            ["@carol:x|CAROL", EventType.RoomMessageEncrypted],
        ]);
        expect(lane.sent[0].content).not.toEqual(lane.sent[1].content);
    });

    it("sends nothing without crypto or without a device it reaches", async () => {
        const c = crypto();
        expect(
            await sendSealed(
                { getCrypto: () => undefined } as never,
                carrier(["@b:x|B"]),
                "t",
                [{ userId: "@b:x", deviceId: "B" }],
                {},
            ),
        ).toEqual([]);
        expect(
            await sendSealed(
                { getCrypto: () => c } as never,
                carrier([]),
                "t",
                [{ userId: "@b:x", deviceId: "B" }],
                {},
            ),
        ).toEqual([]);
        expect(c.encryptToDeviceMessages).not.toHaveBeenCalled();
    });
});

describe("participationOf", () => {
    const of = (content: object, ts: number): CallMembership =>
        ({
            aetherJoinId: (content as { "io.aether.join_id"?: string })["io.aether.join_id"],
            createdTs: () => ts,
        }) as CallMembership;

    it("is the same for a hello and its state event, which differ in timestamp", () => {
        expect(participationOf(of({ "io.aether.join_id": "abc" }, 1))).toBe(
            participationOf(of({ "io.aether.join_id": "abc" }, 2)),
        );
        expect(participationOf(of({ "io.aether.join_id": "abc" }, 1))).not.toBe(
            participationOf(of({ "io.aether.join_id": "abd" }, 1)),
        );
    });

    it("is the creation time for other clients' memberships", () => {
        expect(participationOf(of({}, 1234))).toBe(1234);
    });
});

describe("ToDeviceKeyTransport with a carrier", () => {
    const own = { userId: "@alice:x", deviceId: "ALICE", memberId: "@alice:x:ALICE" };

    it("sends keys through the media room as well as the homeserver, as separate messages", async () => {
        const c = crypto();
        const client = {
            getCrypto: () => c,
            encryptAndSendToDevice: vi.fn(async (_type: string, _devices: Device[], _content: object) => {}),
            on: vi.fn(),
            off: vi.fn(),
        };
        const transport = new ToDeviceKeyTransport(
            own,
            "!r:x",
            client as never,
            {
                counters: { roomEventEncryptionKeysSent: 0, roomEventEncryptionKeysReceived: 0 },
                totals: { roomEventEncryptionKeysReceivedTotalAge: 0 },
            } as never,
        );
        const lane = carrier(["@bob:x|BOB"]);
        transport.setCarrier(lane);
        await transport.sendKey("a2V5", 3, [
            { userId: "@bob:x", deviceId: "BOB", membershipTs: 1 },
            { userId: "@dave:x", deviceId: "DAVE", membershipTs: 1 },
        ]);
        expect(client.encryptAndSendToDevice).toHaveBeenCalledOnce();
        expect(client.encryptAndSendToDevice.mock.calls[0]![1]).toHaveLength(2);
        expect(lane.sent.map(({ to }) => to)).toEqual(["@bob:x|BOB"]);
        expect(c.encryptToDeviceMessages.mock.calls[0]![0]).toBe(EventType.CallEncryptionKeysPrefix);

        lane.sent.length = 0;
        await transport.sendKeySealed("a2V5", 3, [{ userId: "@bob:x", deviceId: "BOB", membershipTs: 1 }]);
        expect(client.encryptAndSendToDevice).toHaveBeenCalledOnce();
        expect(lane.sent.map(({ to }) => to)).toEqual(["@bob:x|BOB"]);
    });
});

describe("our key through the fast lane", () => {
    const own = { userId: "@alice:x", deviceId: "ALICE", memberId: "@alice:x:ALICE" };
    const member = (userId: string, deviceId: string): CallMembership =>
        ({
            userId,
            deviceId,
            sender: userId,
            memberId: `${userId}:${deviceId}`,
            backendIdentities: [`${userId}:${deviceId}`],
            createdTs: () => 1,
        }) as CallMembership;

    it("is only sent again to devices it was already given, never to a joiner before its ratchet", async () => {
        const memberships = [member("@bob:x", "BOB")];
        const sendKey = vi.fn<IKeyTransport["sendKey"]>(async () => {});
        let release!: () => void;
        // Holds the ratchet for a joiner until the test lets it finish.
        const sendKeySealed = vi.fn<(key: string, index: number, members: Device[]) => Promise<void>>(async () => {});
        const transport = Object.assign(new TypedEventEmitter<KeyTransportEvents, KeyTransportEventsHandlerMap>(), {
            start: vi.fn(),
            stop: vi.fn(),
            sendKey,
            sendKeySealed,
        });
        const manager = new RTCEncryptionManager(own, () => memberships, transport, vi.fn());
        manager.join({ manageMediaKeys: true, useKeyDelay: 1000 }, [
            { type: "livekit", livekit_service_url: "https://lk" },
        ]);
        await vi.waitFor(() => expect(sendKey).toHaveBeenCalledOnce());

        manager.aetherShareCurrentKeySealed();
        expect(sendKeySealed).toHaveBeenCalledOnce();
        expect(sendKeySealed.mock.calls[0]![2]).toEqual([expect.objectContaining({ userId: "@bob:x" })]);

        // Carol is a member now, but our key has not been ratcheted and given to her yet.
        const gate = new Promise<void>((resolve) => (release = resolve));
        sendKey.mockImplementationOnce(() => gate);
        memberships.push(member("@carol:x", "CAROL"));
        manager.aetherShareCurrentKeySealed({ userId: "@carol:x", deviceId: "CAROL" });
        expect(sendKeySealed).toHaveBeenCalledOnce();

        // Once the rollout gives her the ratcheted key, the fast lane may deliver it again, before the homeserver
        // has even taken it.
        manager.onMembershipsUpdate();
        await vi.waitFor(() => expect(sendKey).toHaveBeenCalledTimes(2));
        manager.aetherShareCurrentKeySealed({ userId: "@carol:x", deviceId: "CAROL" });
        expect(sendKeySealed).toHaveBeenCalledTimes(2);
        expect(sendKeySealed.mock.calls[1]![0]).toBe(sendKey.mock.calls[1]![0]);
        expect(sendKeySealed.mock.calls[1]![0]).not.toBe(sendKey.mock.calls[0]![0]);
        release();
        manager.leave();
    });
});

describe("a joiner's hello", () => {
    const roomId = "!call:x";
    const me = "@bob:x";
    const alice = "@alice:x";
    let eventCount = 0;
    let client: MatrixClient;
    let room: Room;
    let session: MatrixRTCSession;

    const stateEvent = (type: string, key: string, content: object, sender = me): MatrixEvent =>
        new MatrixEvent({
            type,
            state_key: key,
            sender,
            room_id: roomId,
            event_id: `$event${++eventCount}`,
            origin_server_ts: Date.now(),
            content,
        });
    const membershipContent = (deviceId: string, joinId: string): Record<string, unknown> => ({
        "application": "m.call",
        "call_id": "",
        "scope": "m.room",
        "device_id": deviceId,
        "expires": 4 * 60 * 60 * 1000,
        "focus_active": { type: "livekit", focus_selection: "oldest_membership" },
        "foci_preferred": [{ type: "livekit", livekit_service_url: "https://jwt.x" }],
        "io.aether.join_id": joinId,
    });
    const hello = (
        overrides: { content?: object; sender?: string; senderDevice?: string; encrypted?: boolean } = {},
    ): void => {
        const sender = overrides.sender ?? alice;
        const senderDevice = overrides.senderDevice ?? "ALICE";
        client.emit(ClientEvent.ReceivedToDeviceMessage, {
            message: {
                type: HELLO_EVENT_TYPE,
                sender,
                // A hello's `membership` is the call membership, not the room membership `IContent` types it as.
                content: {
                    room_id: roomId,
                    membership: membershipContent(senderDevice, "join-1"),
                    ts: Date.now(),
                    ...overrides.content,
                } as never,
            },
            encryptionInfo:
                overrides.encrypted === false
                    ? null
                    : { sender, senderDevice, senderCurve25519KeyBase64: "curve", senderVerified: false },
        });
    };
    const members = (): string[] => session.memberships.map((m) => `${m.userId}|${m.deviceId}`).sort();
    const settle = async (): Promise<void> => {
        for (let i = 0; i < 5; i++) {
            await vi.advanceTimersByTimeAsync(0);
            await new Promise((resolve) => setImmediate(resolve));
        }
    };

    beforeEach(async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        client = createClient({ baseUrl: "https://x", userId: me, deviceId: "BOB", accessToken: "token" });
        room = new Room(roomId, client, me);
        room.currentState.setStateEvents([
            stateEvent(EventType.RoomCreate, "", {}),
            stateEvent(EventType.RoomPowerLevels, "", {
                users: { [me]: 100 },
                users_default: 0,
                events: { [EventType.GroupCallMemberPrefix]: 0 },
                state_default: 50,
            }),
            stateEvent(EventType.RoomMember, me, { membership: "join" }),
            stateEvent(EventType.RoomMember, alice, { membership: "join" }, alice),
            stateEvent(EventType.GroupCallMemberPrefix, `_${me}_BOB_m.call`, membershipContent("BOB", "bob-join")),
        ]);
        session = MatrixRTCSession.sessionForSlot(client, room, { application: "m.call", id: "ROOM" });
        await session.ensureRecalculateSessionMembers();
        // We are in the call: the fast lane is only for the joined.
        vi.spyOn(session, "isJoined").mockReturnValue(true);
        client.on(
            ClientEvent.ReceivedToDeviceMessage,
            (session as unknown as { aetherOnToDeviceMessage: (payload: ReceivedToDeviceMessage) => void })
                .aetherOnToDeviceMessage,
        );
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("makes the joiner a member at once, once Olm authenticated its device", async () => {
        hello();
        await settle();
        expect(members()).toEqual([`${alice}|ALICE`, `${me}|BOB`]);
    });

    it.each([
        ["not Olm encrypted", { encrypted: false }],
        ["for another room", { content: { room_id: "!other:x" } }],
        [
            "for a device other than the sender's",
            { senderDevice: "MALLORY", content: { membership: membershipContent("ALICE", "j") } },
        ],
        ["stale", { content: { ts: Date.now() - 60_000 } }],
        ["from someone not in the room", { sender: "@eve:x" }],
    ])("ignores a hello %s", async (_, overrides) => {
        hello(overrides);
        await settle();
        expect(members()).toEqual([`${me}|BOB`]);
    });

    it("ignores a hello from someone who may not join the call", async () => {
        room.currentState.setStateEvents([
            stateEvent(EventType.RoomPowerLevels, "", {
                users: { [me]: 100 },
                events: { [EventType.GroupCallMemberPrefix]: 50 },
            }),
        ]);
        hello();
        await settle();
        expect(members()).toEqual([`${me}|BOB`]);
    });

    it("gives way to the state event it announced, without reporting a change", async () => {
        hello();
        await settle();
        const changed = vi.fn();
        session.on(MatrixRTCSessionEvent.MembershipsChanged, changed);
        room.currentState.setStateEvents([
            stateEvent(
                EventType.GroupCallMemberPrefix,
                `_${alice}_ALICE_m.call`,
                membershipContent("ALICE", "join-1"),
                alice,
            ),
        ]);
        await session.ensureRecalculateSessionMembers();
        await settle();
        expect(members()).toEqual([`${alice}|ALICE`, `${me}|BOB`]);
        expect(changed).not.toHaveBeenCalled();
        // The state event keeps the membership after the hello would have expired.
        await vi.advanceTimersByTimeAsync(PROVISIONAL_MEMBERSHIP_MS);
        await settle();
        expect(members()).toEqual([`${alice}|ALICE`, `${me}|BOB`]);
    });

    it("drops the joiner when no state event follows the hello in time", async () => {
        hello();
        await settle();
        const changed = vi.fn();
        session.on(MatrixRTCSessionEvent.MembershipsChanged, changed);
        await vi.advanceTimersByTimeAsync(PROVISIONAL_MEMBERSHIP_MS);
        await settle();
        expect(members()).toEqual([`${me}|BOB`]);
        expect(changed).toHaveBeenCalledOnce();
    });
});
