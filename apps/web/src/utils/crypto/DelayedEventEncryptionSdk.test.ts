/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    createClient,
    EventType,
    type MatrixClient,
    type MatrixEvent,
    MsgType,
    type Room,
} from "matrix-js-sdk/src/matrix";
import { type RtcLeftMembershipData } from "matrix-js-sdk/src/matrixrtc";
import { type RoomMessageEventContent } from "matrix-js-sdk/src/types";

// Checks Aether's matrix-js-sdk patch: delayed (MSC4140) timeline events are encrypted in encrypted rooms, as
// upstream matrix-js-sdk #5682 does, except MatrixRTC call membership, which is sent as before.

const ROOM_ID = "!room:example.org";
const DELAY_MS = 60_000;
const ENCRYPTED = { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "ciphertext", session_id: "session" };
const MESSAGE: RoomMessageEventContent = { msgtype: MsgType.Text, body: "Sent later" };

interface SentRequest {
    method: string;
    path: string;
    query: URLSearchParams;
    body: unknown;
}

describe("matrix-js-sdk delayed event encryption", () => {
    let client: MatrixClient;
    let requests: SentRequest[];
    let room: { roomId: string; hasEncryptionStateEvent: ReturnType<typeof vi.fn>; updatePendingEvent: () => void };
    let encryptEvent: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        requests = [];
        const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = new URL(input instanceof Request ? input.url : input);
            requests.push({
                method: init?.method ?? "GET",
                path: decodeURIComponent(url.pathname),
                query: url.searchParams,
                body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
            });
            return new Response(JSON.stringify({ delay_id: "syd_delay" }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        });
        const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() };
        Object.assign(logger, { getChild: () => logger });
        client = createClient({
            logger: logger as never,
            baseUrl: "https://example.org",
            accessToken: "token",
            userId: "@alice:example.org",
            deviceId: "DEVICE",
            fetchFn,
        });
        vi.spyOn(client, "doesServerSupportUnstableFeature").mockResolvedValue(true);

        room = { roomId: ROOM_ID, hasEncryptionStateEvent: vi.fn(() => true), updatePendingEvent: vi.fn() };
        vi.spyOn(client, "getRoom").mockReturnValue(room as unknown as Room);
        encryptEvent = vi.fn(async (event: MatrixEvent) => {
            event.makeEncrypted(EventType.RoomMessageEncrypted, ENCRYPTED, "curve25519", "ed25519");
        });
        // The crypto backend is private; a stand-in that encrypts like the real one is all these tests need.
        Object.assign(client, { cryptoBackend: { encryptEvent, isEncryptionEnabledInRoom: vi.fn(), stop: vi.fn() } });
    });

    describe("in an encrypted room", () => {
        it("sends a delayed message as an encrypted event", async () => {
            await expect(
                client._unstable_sendDelayedEvent(ROOM_ID, DELAY_MS, null, EventType.RoomMessage, { ...MESSAGE }, "t1"),
            ).resolves.toEqual({ delay_id: "syd_delay" });

            expect(requests).toHaveLength(1);
            expect(requests[0].method).toBe("PUT");
            expect(requests[0].path).toBe(`/_matrix/client/v3/rooms/${ROOM_ID}/send/m.room.encrypted/t1`);
            expect(requests[0].query.get("org.matrix.msc4140.delay")).toBe(String(DELAY_MS));
            expect(requests[0].body).toEqual(ENCRYPTED);
            expect(encryptEvent).toHaveBeenCalledTimes(1);
            expect(encryptEvent.mock.calls[0][0].getContent()).toEqual(MESSAGE);
            // A delayed event is not one of the room's pending events, so it has no local echo to update.
            expect(room.updatePendingEvent).not.toHaveBeenCalled();
        });

        it("sends a delayed sticky event that is not call membership as an encrypted event", async () => {
            await client._unstable_sendStickyDelayedEvent(
                ROOM_ID,
                5_000,
                DELAY_MS,
                null,
                EventType.RoomMessage,
                { ...MESSAGE },
                "t2",
            );

            expect(requests[0].path).toBe(`/_matrix/client/v3/rooms/${ROOM_ID}/send/m.room.encrypted/t2`);
            expect(requests[0].query.get("org.matrix.msc4354.sticky_duration_ms")).toBe("5000");
            expect(requests[0].body).toEqual(ENCRYPTED);
        });

        it("schedules nothing when encryption fails", async () => {
            encryptEvent.mockRejectedValue(new Error("No keys"));

            await expect(
                client._unstable_sendDelayedEvent(ROOM_ID, DELAY_MS, null, EventType.RoomMessage, { ...MESSAGE }),
            ).rejects.toThrow("No keys");
            expect(requests).toHaveLength(0);
        });

        it("keeps a delayed state event, such as a call's delayed leave, unencrypted", async () => {
            const leave = {};
            await client._unstable_sendDelayedStateEvent(
                ROOM_ID,
                DELAY_MS,
                "org.matrix.msc3401.call.member" as never,
                leave as never,
                "_@alice:example.org_DEVICE_m.call",
            );

            expect(encryptEvent).not.toHaveBeenCalled();
            expect(requests[0].path).toBe(
                `/_matrix/client/v3/rooms/${ROOM_ID}/state/org.matrix.msc3401.call.member/_@alice:example.org_DEVICE_m.call`,
            );
            expect(requests[0].query.get("org.matrix.msc4140.delay")).toBe(String(DELAY_MS));
            expect(requests[0].body).toEqual(leave);
        });

        it("keeps the delayed leave of sticky call membership as it was", async () => {
            const leave: RtcLeftMembershipData = {
                slot_id: "m.call#ROOM",
                member: { id: "member", membership: "leave" },
                msc4354_sticky_key: "member",
            };
            await client._unstable_sendStickyDelayedEvent(
                ROOM_ID,
                5_000,
                DELAY_MS,
                null,
                EventType.RTCMembership,
                leave,
                "t3",
            );

            expect(encryptEvent).not.toHaveBeenCalled();
            expect(requests[0].path).toBe(`/_matrix/client/v3/rooms/${ROOM_ID}/send/${EventType.RTCMembership}/t3`);
            expect(requests[0].body).toEqual(leave);
        });
    });

    describe("in an unencrypted room", () => {
        beforeEach(() => {
            room.hasEncryptionStateEvent.mockReturnValue(false);
        });

        it("sends a delayed message unchanged", async () => {
            await client._unstable_sendDelayedEvent(
                ROOM_ID,
                DELAY_MS,
                null,
                EventType.RoomMessage,
                { ...MESSAGE },
                "t4",
            );

            expect(encryptEvent).not.toHaveBeenCalled();
            expect(requests[0].path).toBe(`/_matrix/client/v3/rooms/${ROOM_ID}/send/m.room.message/t4`);
            expect(requests[0].query.get("org.matrix.msc4140.delay")).toBe(String(DELAY_MS));
            expect(requests[0].body).toEqual(MESSAGE);
        });
    });
});
