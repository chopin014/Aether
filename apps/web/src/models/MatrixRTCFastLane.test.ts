/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { EventEmitter } from "node:events";
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
import { AETHER_KEYS_WAITING_PER_SENDER, RTCEncryptionManager } from "matrix-js-sdk/src/matrixrtc/RTCEncryptionManager";
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

/** A key from Bob's device BOB as the crypto layer hands it over, by default Olm authenticated as from BOB. */
function keyMessage(
    order?: object,
    { senderDevice = "BOB", encrypted = true }: { senderDevice?: string; encrypted?: boolean } = {},
): ReceivedToDeviceMessage {
    return {
        message: {
            type: EventType.CallEncryptionKeysPrefix,
            sender: "@bob:x",
            content: {
                room_id: "!r:x",
                member_id: "@bob:x:BOB",
                media_key: { index: 1, key: "a2V5" },
                member: { claimed_device_id: "BOB" },
                ...(order ? { "io.aether.key_order": order } : {}),
            },
        },
        encryptionInfo: encrypted
            ? { sender: "@bob:x", senderDevice, senderCurve25519KeyBase64: "curve", senderVerified: false }
            : null,
    };
}

describe("receiving keys", () => {
    const own = { userId: "@alice:x", deviceId: "ALICE", memberId: "@alice:x:ALICE" };
    const receiving = (): { client: EventEmitter; received: Mock; transport: ToDeviceKeyTransport } => {
        const client = new EventEmitter();
        const transport = new ToDeviceKeyTransport(
            own,
            "!r:x",
            client as never,
            {
                counters: { roomEventEncryptionKeysSent: 0, roomEventEncryptionKeysReceived: 0 },
                totals: { roomEventEncryptionKeysReceivedTotalAge: 0 },
            } as never,
        );
        const received = vi.fn();
        transport.on(KeyTransportEvents.ReceivedKeys, received);
        transport.start();
        return { client, received, transport };
    };

    it("takes a key for the device Olm authenticated as its sender", () => {
        const { client, received, transport } = receiving();
        client.emit(ClientEvent.ReceivedToDeviceMessage, keyMessage());
        expect(received).toHaveBeenCalledWith(
            { userId: "@bob:x", deviceId: "BOB", memberId: "@bob:x:BOB" },
            "a2V5",
            1,
            expect.any(Number),
            undefined,
        );
        transport.stop();
    });

    it.each([
        ["from another device of the same user, naming this one", { senderDevice: "BOB2" }],
        ["sent in clear", { encrypted: false }],
    ])("ignores a key %s", (_, options) => {
        const { client, received, transport } = receiving();
        client.emit(ClientEvent.ReceivedToDeviceMessage, keyMessage(undefined, options));
        expect(received).not.toHaveBeenCalled();
        transport.stop();
    });
});

describe("the order of a sender's keys", () => {
    const own = { userId: "@alice:x", deviceId: "ALICE", memberId: "@alice:x:ALICE" };
    const bob = { userId: "@bob:x", deviceId: "BOB", memberId: "@bob:x:BOB" };

    it("travels with each key and is passed on to whoever takes it", async () => {
        const c = crypto();
        const client = Object.assign(new EventEmitter(), {
            getCrypto: () => c,
            encryptAndSendToDevice: vi.fn(async (_type: string, _devices: Device[], _content: object) => {}),
        });
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
        await transport.sendKey("a2V5", 1, [{ userId: "@bob:x", deviceId: "BOB", membershipTs: 1 }], {
            epoch: "e",
            seq: 7,
            join: "j",
        });
        expect(client.encryptAndSendToDevice.mock.calls[0]![2]).toMatchObject({
            "io.aether.key_order": { epoch: "e", seq: 7, join: "j" },
        });

        const received = vi.fn();
        transport.on(KeyTransportEvents.ReceivedKeys, received);
        transport.start();
        client.emit(ClientEvent.ReceivedToDeviceMessage, keyMessage({ epoch: "f", seq: 3, join: "j2" }));
        expect(received).toHaveBeenCalledWith(expect.anything(), "a2V5", 1, expect.any(Number), {
            epoch: "f",
            seq: 3,
            join: "j2",
        });
        transport.stop();
    });

    /** Our key manager in a call with Bob, whose participation (join id) the test changes. */
    function withBob(): {
        manager: RTCEncryptionManager;
        bobJoins: (joinId: string | undefined) => void;
        fromBob: () => string[];
    } {
        const keysChanged = vi.fn();
        const transport = Object.assign(new TypedEventEmitter<KeyTransportEvents, KeyTransportEventsHandlerMap>(), {
            start: vi.fn(),
            stop: vi.fn(),
            sendKey: vi.fn(async () => {}),
        });
        let joinId: string | undefined = "join1";
        const bobMembership = {
            userId: bob.userId,
            deviceId: bob.deviceId,
            sender: bob.userId,
            memberId: bob.memberId,
            backendIdentities: [bob.memberId],
            createdTs: () => 1,
            get aetherJoinId() {
                return joinId;
            },
        } as unknown as CallMembership;
        const manager = new RTCEncryptionManager(own, () => [bobMembership], transport, keysChanged);
        manager.join({ manageMediaKeys: true }, []);
        return {
            manager,
            bobJoins: (id) => {
                joinId = id;
                manager.onMembershipsUpdate();
            },
            fromBob: () =>
                keysChanged.mock.calls
                    .filter(([, , m]) => m.userId === bob.userId)
                    .map(([key]) => new TextDecoder().decode(key)),
        };
    }
    // "key1".."key9", base64.
    const key = (n: number): string => btoa(`key${n}`);

    afterEach(() => {
        vi.useRealTimers();
    });

    it("keeps a newer key of a sender's participation when an older one for the same index arrives after it", () => {
        const { manager, fromBob } = withBob();
        manager.onNewKeyReceived(bob, key(2), 0, Date.now(), { epoch: "m1", seq: 3, join: "join1" });
        manager.onNewKeyReceived(bob, key(1), 0, Date.now(), { epoch: "m1", seq: 2, join: "join1" });
        expect(fromBob()).toEqual(["key2"]);
        manager.leave();
    });

    it("uses a key only for the participation of the sender it was sent in, whatever the clocks say", () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        const { manager, bobJoins, fromBob } = withBob();
        manager.onNewKeyReceived(bob, key(1), 0, Date.now(), { epoch: "m1", seq: 1, join: "join1" });
        expect(fromBob()).toEqual(["key1"]);

        // Bob re-joins: his first key comes before we know of his new participation, and waits for it.
        manager.onNewKeyReceived(bob, key(2), 0, Date.now(), { epoch: "m2", seq: 1, join: "join2" });
        expect(fromBob()).toEqual(["key1"]);
        bobJoins("join2");
        expect(fromBob()).toEqual(["key1", "key2"]);

        // A key of his previous participation arrives late: it is never used, though it is "newer" in its own join.
        manager.onNewKeyReceived(bob, key(3), 0, Date.now(), { epoch: "m1", seq: 2, join: "join1" });
        bobJoins("join2");
        vi.advanceTimersByTime(60_000);
        bobJoins("join2");
        expect(fromBob()).toEqual(["key1", "key2"]);
        manager.leave();
    });

    it("keeps a key for a participation we learn of late, however late", () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        const { manager, bobJoins, fromBob } = withBob();
        manager.onNewKeyReceived(bob, key(1), 0, Date.now(), { epoch: "m1", seq: 1, join: "join2" });
        vi.advanceTimersByTime(60_000);
        bobJoins("join1");
        expect(fromBob()).toEqual([]);
        bobJoins("join2");
        expect(fromBob()).toEqual(["key1"]);
        manager.leave();
    });

    it("keeps only a sender's newest keys waiting for participations we do not count it in", () => {
        const { manager, bobJoins, fromBob } = withBob();
        for (let seq = 1; seq <= AETHER_KEYS_WAITING_PER_SENDER + 4; seq++) {
            manager.onNewKeyReceived(bob, key(seq % 10), seq % 4, Date.now(), { epoch: "old", seq, join: "gone" });
        }
        const waiting = (manager as unknown as { keysWithoutMatchingRTCMembership: unknown[] })
            .keysWithoutMatchingRTCMembership;
        expect(waiting).toHaveLength(AETHER_KEYS_WAITING_PER_SENDER);
        bobJoins("join1");
        expect(fromBob()).toEqual([]);
        manager.leave();
    });

    it("orders a sender's keys by their participation, not by when they arrived by our clock", () => {
        const { manager, bobJoins, fromBob } = withBob();
        manager.onNewKeyReceived(bob, key(1), 0, 10_000, { epoch: "m1", seq: 1, join: "join1" });
        // Our clock moved back before Bob re-joined and sent his new key at the same index.
        bobJoins("join2");
        manager.onNewKeyReceived(bob, key(2), 0, 5_000, { epoch: "m2", seq: 1, join: "join2" });
        expect(fromBob()).toEqual(["key1", "key2"]);
        manager.leave();
    });

    it("uses keys without a participation, as other clients send them, as before", () => {
        const { manager, fromBob } = withBob();
        manager.onNewKeyReceived(bob, key(1), 0, Date.now());
        manager.onNewKeyReceived(bob, key(2), 0, Date.now(), { epoch: "m1", seq: 1 });
        expect(fromBob()).toEqual(["key1", "key2"]);
        manager.leave();
    });

    it("sends our key again for our new participation once a re-join from scratch shows in room state", async () => {
        const transport = Object.assign(new TypedEventEmitter<KeyTransportEvents, KeyTransportEventsHandlerMap>(), {
            start: vi.fn(),
            stop: vi.fn(),
            sendKey: vi.fn<IKeyTransport["sendKey"]>(async () => {}),
        });
        let ourJoin = "join-a";
        const memberOf = (userId: string, deviceId: string, joinId?: string): CallMembership =>
            ({
                userId,
                deviceId,
                sender: userId,
                memberId: `${userId}:${deviceId}`,
                backendIdentities: [`${userId}:${deviceId}`],
                createdTs: () => 1,
                aetherJoinId: joinId,
            }) as unknown as CallMembership;
        const memberships = [memberOf(bob.userId, bob.deviceId), memberOf(own.userId, own.deviceId, "join-a")];
        const manager = new RTCEncryptionManager(own, () => memberships, transport, vi.fn());
        manager.aetherJoinIdOf = () => ourJoin;
        manager.join({ manageMediaKeys: true }, [{ type: "livekit", livekit_service_url: "https://lk" }]);
        await vi.waitFor(() => expect(transport.sendKey).toHaveBeenCalledTimes(1));

        // We re-join from scratch: nothing goes out until the others can see us in the new participation.
        ourJoin = "join-b";
        manager.onMembershipsUpdate();
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(transport.sendKey).toHaveBeenCalledTimes(1);
        memberships[1] = memberOf(own.userId, own.deviceId, "join-b");
        manager.onMembershipsUpdate();
        await vi.waitFor(() => expect(transport.sendKey).toHaveBeenCalledTimes(2));
        const [first, second] = transport.sendKey.mock.calls;
        expect(second![0]).toBe(first![0]);
        expect(second![2].map(({ userId }) => userId)).toEqual([bob.userId]);
        expect(second![3]).toEqual(expect.objectContaining({ join: "join-b" }));
        manager.leave();
    });

    it("sends our keys with the participation we are in", async () => {
        const transport = Object.assign(new TypedEventEmitter<KeyTransportEvents, KeyTransportEventsHandlerMap>(), {
            start: vi.fn(),
            stop: vi.fn(),
            sendKey: vi.fn<IKeyTransport["sendKey"]>(async () => {}),
        });
        const memberships = [
            {
                userId: bob.userId,
                deviceId: bob.deviceId,
                sender: bob.userId,
                memberId: bob.memberId,
                backendIdentities: [bob.memberId],
                createdTs: () => 1,
            } as unknown as CallMembership,
        ];
        const manager = new RTCEncryptionManager(own, () => memberships, transport, vi.fn());
        manager.aetherJoinIdOf = () => "our-join";
        manager.join({ manageMediaKeys: true }, [{ type: "livekit", livekit_service_url: "https://lk" }]);
        await vi.waitFor(() => expect(transport.sendKey).toHaveBeenCalled());
        expect(transport.sendKey.mock.calls[0]![3]).toEqual(expect.objectContaining({ join: "our-join" }));
        manager.leave();
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

    it("drops the joiner at once when they leave the room or lose the right to join its call", async () => {
        hello();
        await settle();
        expect(members()).toEqual([`${alice}|ALICE`, `${me}|BOB`]);
        room.currentState.setStateEvents([stateEvent(EventType.RoomMember, alice, { membership: "leave" }, me)]);
        await session.ensureRecalculateSessionMembers();
        await settle();
        expect(members()).toEqual([`${me}|BOB`]);
    });

    it("does not let further hellos keep a joiner in the call past the time of its first", async () => {
        hello();
        await settle();
        await vi.advanceTimersByTimeAsync(PROVISIONAL_MEMBERSHIP_MS - 2000);
        hello();
        await settle();
        expect(members()).toEqual([`${alice}|ALICE`, `${me}|BOB`]);
        await vi.advanceTimersByTimeAsync(2000);
        await settle();
        expect(members()).toEqual([`${me}|BOB`]);
        // Its time is used up until a membership event of the device arrives.
        hello();
        await settle();
        expect(members()).toEqual([`${me}|BOB`]);
    });

    it("lets a device's hellos count again once a membership event of it arrived", async () => {
        hello();
        await settle();
        await vi.advanceTimersByTimeAsync(PROVISIONAL_MEMBERSHIP_MS);
        await settle();
        const aliceKey = `_${alice}_ALICE_m.call`;
        room.currentState.setStateEvents([
            stateEvent(EventType.GroupCallMemberPrefix, aliceKey, membershipContent("ALICE", "join-2"), alice),
        ]);
        await session.ensureRecalculateSessionMembers();
        room.currentState.setStateEvents([stateEvent(EventType.GroupCallMemberPrefix, aliceKey, {}, alice)]);
        await session.ensureRecalculateSessionMembers();
        await settle();
        expect(members()).toEqual([`${me}|BOB`]);
        hello({ content: { membership: membershipContent("ALICE", "join-3") } });
        await settle();
        expect(members()).toEqual([`${alice}|ALICE`, `${me}|BOB`]);
    });

    it("takes the hello of a device's next join when the membership event of its last one came before its hello", async () => {
        const aliceKey = `_${alice}_ALICE_m.call`;
        room.currentState.setStateEvents([
            stateEvent(EventType.GroupCallMemberPrefix, aliceKey, membershipContent("ALICE", "join-1"), alice),
        ]);
        await session.ensureRecalculateSessionMembers();
        hello();
        await settle();
        await vi.advanceTimersByTimeAsync(PROVISIONAL_MEMBERSHIP_MS * 2);
        room.currentState.setStateEvents([stateEvent(EventType.GroupCallMemberPrefix, aliceKey, {}, alice)]);
        await session.ensureRecalculateSessionMembers();
        await settle();
        expect(members()).toEqual([`${me}|BOB`]);
        hello({ content: { membership: membershipContent("ALICE", "join-2") } });
        await settle();
        expect(members()).toEqual([`${alice}|ALICE`, `${me}|BOB`]);
    });

    it("ignores a late hello for a participation room state already had", async () => {
        const aliceKey = `_${alice}_ALICE_m.call`;
        room.currentState.setStateEvents([
            stateEvent(EventType.GroupCallMemberPrefix, aliceKey, membershipContent("ALICE", "join-1"), alice),
        ]);
        await session.ensureRecalculateSessionMembers();
        // Alice moved away and back: room state has her new participation when her first one's hello arrives.
        room.currentState.setStateEvents([
            stateEvent(EventType.GroupCallMemberPrefix, aliceKey, membershipContent("ALICE", "join-2"), alice),
        ]);
        await session.ensureRecalculateSessionMembers();
        hello({ content: { membership: membershipContent("ALICE", "join-1") } });
        await settle();
        expect(session.memberships.find((m) => m.userId === alice)?.aetherJoinId).toBe("join-2");
        // Nor does it bring her first participation back once she left.
        room.currentState.setStateEvents([stateEvent(EventType.GroupCallMemberPrefix, aliceKey, {}, alice)]);
        await session.ensureRecalculateSessionMembers();
        await vi.advanceTimersByTimeAsync(2000);
        hello({ content: { membership: membershipContent("ALICE", "join-1") } });
        await settle();
        expect(members()).toEqual([`${me}|BOB`]);
    });

    it("does not let a late hello of an earlier participation take the place of a later one", async () => {
        // We never saw Alice's first participation in room state, only her return.
        const aliceKey = `_${alice}_ALICE_m.call`;
        room.currentState.setStateEvents([
            stateEvent(EventType.GroupCallMemberPrefix, aliceKey, membershipContent("ALICE", "join-2"), alice),
        ]);
        await session.ensureRecalculateSessionMembers();
        hello({ content: { membership: membershipContent("ALICE", "join-1"), replaces: "join-0" } });
        await settle();
        expect(session.memberships.find((m) => m.userId === alice)?.aetherJoinId).toBe("join-2");
    });

    it("lets a hello take the place of the participation it names, and right after an ignored one", async () => {
        const aliceKey = `_${alice}_ALICE_m.call`;
        room.currentState.setStateEvents([
            stateEvent(EventType.GroupCallMemberPrefix, aliceKey, membershipContent("ALICE", "join-1"), alice),
        ]);
        await session.ensureRecalculateSessionMembers();
        // The hello of join-1 comes after its state event, and is ignored.
        hello();
        await settle();
        // Alice moves away and straight back.
        hello({ content: { membership: membershipContent("ALICE", "join-2"), replaces: "join-1" } });
        await settle();
        expect(session.memberships.find((m) => m.userId === alice)?.aetherJoinId).toBe("join-2");
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
