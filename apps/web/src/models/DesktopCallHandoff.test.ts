/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientEvent, EventType, MatrixEvent, type MatrixClient, type Room } from "matrix-js-sdk/src/matrix";
import { MatrixRTCSessionEvent, type CallMembership, type MatrixRTCSession } from "matrix-js-sdk/src/matrixrtc";

import type { Call } from "./Call";
import { DesktopCallHandoff } from "./DesktopCallHandoff";

const userId = "@alice:example.org";

function member(device: string, created: number): CallMembership {
    return {
        userId,
        deviceId: device,
        memberId: `${userId}:${device}`,
        eventId: `$${device}-${created}`,
        createdTs: () => created,
    } as CallMembership;
}

describe("DesktopCallHandoff", () => {
    const own = member("current", 200);
    let session: MatrixRTCSession;
    let events: MatrixEvent[];
    let connected: boolean;
    let call: Call;
    let client: MatrixClient;
    let handoff: DesktopCallHandoff;
    let moved: ReturnType<typeof vi.fn<() => void>>;

    beforeEach(() => {
        events = [];
        connected = true;
        session = Object.assign(new EventEmitter(), { memberships: [own] }) as unknown as MatrixRTCSession;
        const room = {
            roomId: "!room:example.org",
            currentState: {
                getStateEvents: (_type: string, key?: string) =>
                    key === undefined ? events : (events.find((event) => event.getStateKey() === key) ?? null),
            },
        } as unknown as Room;
        client = Object.assign(new EventEmitter(), {
            getUserId: () => userId,
            getDeviceId: () => "current",
            getRoom: (id: string) => (id === room.roomId ? room : null),
            getRooms: () => [room],
            matrixRTC: { getRoomSession: () => session },
            sendToDevice: vi.fn().mockResolvedValue({}),
            sendStateEvent: vi.fn().mockResolvedValue({}),
        }) as unknown as MatrixClient;
        call = {
            roomId: room.roomId,
            get connected() {
                return connected;
            },
            disconnect: vi.fn(async () => {
                connected = false;
            }),
        } as unknown as Call;
        moved = vi.fn();
        handoff = new DesktopCallHandoff(client, () => [call], moved);
    });
    afterEach(() => {
        handoff.dispose();
        vi.useRealTimers();
    });

    function takeover(overrides: Record<string, unknown> = {}, sender = userId): MatrixEvent {
        return new MatrixEvent({
            type: "io.aether.call.handoff",
            sender,
            content: {
                device_id: "new-device",
                created_ts: 300,
                targets: [{ room_id: call.roomId, member_id: own.memberId, created_ts: own.createdTs() }],
                ...overrides,
            },
        });
    }

    it("targets only older sessions belonging to this account's other devices", async () => {
        const older = member("old", 100);
        session.memberships.push(older, member("newer", 400), {
            ...member("stranger", 50),
            userId: "@bob:example.org",
        } as CallMembership);
        await handoff.claim(call);
        expect(client.sendToDevice).toHaveBeenCalledWith(
            "io.aether.call.handoff",
            new Map([
                [
                    userId,
                    new Map([
                        [
                            "old",
                            {
                                device_id: "current",
                                created_ts: 200,
                                targets: [{ room_id: call.roomId, member_id: older.memberId, created_ts: 100 }],
                            },
                        ],
                    ]),
                ],
            ]),
        );
    });

    it("leaves the exact older session and notifies its user", async () => {
        await handoff.claim(call);
        client.emit(ClientEvent.ToDeviceEvent, takeover());
        await vi.waitFor(() => expect(moved).toHaveBeenCalledOnce());
        expect(call.disconnect).toHaveBeenCalledOnce();
    });

    it.each([
        [{}, "@bob:example.org"],
        [{ device_id: "current" }, userId],
        [{ created_ts: 100 }, userId],
        [{ created_ts: "300" }, userId],
        [{ targets: [{ room_id: "!other", member_id: own.memberId, created_ts: 200 }] }, userId],
        [{ targets: [{ room_id: "!room:example.org", member_id: own.memberId, created_ts: 50 }] }, userId],
        [{ targets: [null, "invalid"] }, userId],
    ])("ignores a foreign, malformed, older or unrelated takeover: %j", async (content, sender) => {
        await handoff.claim(call);
        client.emit(ClientEvent.ToDeviceEvent, takeover(content, sender));
        await Promise.resolve();
        expect(call.disconnect).not.toHaveBeenCalled();
    });

    it("ignores an old queued request after this device joins a new session", async () => {
        await handoff.claim(call);
        session.memberships = [member("current", 500)];
        await handoff.claim(call);
        client.emit(ClientEvent.ToDeviceEvent, takeover());
        await Promise.resolve();
        expect(call.disconnect).not.toHaveBeenCalled();
    });

    it("clears an offline device's exact stale state record after sending its handoff", async () => {
        const older = member("old", 100);
        session.memberships.push(older);
        events.push(
            new MatrixEvent({
                type: EventType.GroupCallMemberPrefix,
                sender: userId,
                event_id: older.eventId,
                state_key: "old-device",
                content: { application: "m.call", device_id: "old" },
            }),
        );
        await handoff.claim(call);
        expect(client.sendStateEvent).toHaveBeenCalledWith(
            call.roomId,
            EventType.GroupCallMemberPrefix,
            {},
            "old-device",
        );
    });

    it("preserves a device that rejoins while the handoff is being delivered", async () => {
        const older = member("old", 100);
        session.memberships.push(older);
        events.push(
            new MatrixEvent({
                type: EventType.GroupCallMemberPrefix,
                sender: userId,
                event_id: older.eventId,
                state_key: "old-device",
                content: { device_id: "old" },
            }),
        );
        const sent = Promise.withResolvers<{}>();
        vi.mocked(client.sendToDevice).mockReturnValue(sent.promise);
        const claiming = handoff.claim(call);
        events = [
            new MatrixEvent({
                type: EventType.GroupCallMemberPrefix,
                sender: userId,
                event_id: "$rejoined",
                state_key: "old-device",
                content: { device_id: "old" },
            }),
        ];
        sent.resolve({});
        await claiming;
        expect(client.sendStateEvent).not.toHaveBeenCalled();
    });

    it("does not publish a handoff when this join never acquires a membership", async () => {
        vi.useFakeTimers();
        session.memberships = [];
        const claiming = handoff.claim(call);
        await vi.advanceTimersByTimeAsync(3_000);
        await claiming;
        expect(client.sendToDevice).not.toHaveBeenCalled();
        expect(session.listenerCount(MatrixRTCSessionEvent.MembershipsChanged)).toBe(0);
    });

    it("stops listening when the client logs out", async () => {
        await handoff.claim(call);
        handoff.dispose();
        client.emit(ClientEvent.ToDeviceEvent, takeover());
        expect(call.disconnect).not.toHaveBeenCalled();
        expect(client.listenerCount(ClientEvent.ToDeviceEvent)).toBe(0);
    });
});
