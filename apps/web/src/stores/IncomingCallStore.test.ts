/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi, type Mocked } from "vitest";
import {
    EventType,
    MatrixEventEvent,
    Room,
    RoomEvent,
    type IContent,
    type MatrixClient,
    type MatrixEvent,
    TypedEventEmitter,
} from "matrix-js-sdk/src/matrix";
import {
    MatrixRTCSessionEvent,
    MatrixRTCSessionManagerEvents,
    type CallMembership,
    type MatrixRTCSession,
} from "matrix-js-sdk/src/matrixrtc";

import { mkEvent, stubClient } from "test-utils";
import { IncomingCallStore, INCOMING_CALLS_CHANGED } from "./IncomingCallStore";

const KEY = "call_1_!dm:example.org";

describe("IncomingCallStore", () => {
    let client: Mocked<MatrixClient>;
    let room: Room;
    let session: MatrixRTCSession;
    let store: IncomingCallStore;

    const notification = (content: IContent = {}, ts = Date.now()): MatrixEvent =>
        mkEvent({
            event: true,
            type: EventType.RTCNotification,
            user: "@pon:example.org",
            room: room.roomId,
            id: "$ring",
            ts,
            content: {
                "notification_type": "ring",
                "m.call.intent": "audio",
                "m.relates_to": { rel_type: "m.reference", event_id: "$member" },
                "lifetime": 30000,
                "sender_ts": ts,
                ...content,
            },
        });

    const setMemberships = (userIds: string[]): void => {
        session.memberships = userIds.map((userId) => ({ userId }) as CallMembership);
        session.emit(MatrixRTCSessionEvent.MembershipsChanged, [], session.memberships);
    };

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        client = vi.mocked(stubClient());
        room = new Room("!dm:example.org", client, client.getSafeUserId());
        session = new TypedEventEmitter() as unknown as MatrixRTCSession;
        session.memberships = [{ userId: "@pon:example.org" } as CallMembership];
        vi.mocked(client.matrixRTC.getRoomSession).mockReturnValue(session);
        store = new IncomingCallStore();
    });

    afterEach(() => {
        store.reset();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("rings once per call and describes it", () => {
        const changed = vi.fn();
        store.on(INCOMING_CALLS_CHANGED, changed);
        const event = notification();
        store.add(KEY, room, event);
        store.add(KEY, room, notification());

        expect(changed).toHaveBeenCalledOnce();
        expect(store.has(KEY)).toBe(true);
        expect(store.calls).toEqual([{ key: KEY, room, notificationEvent: event, ring: true, voiceOnly: true }]);
    });

    it("tells apart a group call announcement and a video call", () => {
        store.add(KEY, room, notification({ "notification_type": "notification", "m.call.intent": "video" }));
        expect(store.calls[0]).toMatchObject({ ring: false, voiceOnly: false });
    });

    it("stops ringing when the notification's lifetime runs out", () => {
        store.add(KEY, room, notification({}, Date.now() - 10000));
        vi.advanceTimersByTime(19999);
        expect(store.has(KEY)).toBe(true);
        vi.advanceTimersByTime(1);
        expect(store.has(KEY)).toBe(false);
    });

    it("stops ringing when the caller hangs up", () => {
        store.add(KEY, room, notification());
        setMemberships(["@pon:example.org", "@ana:example.org"]);
        expect(store.has(KEY)).toBe(true);
        setMemberships([]);
        expect(store.has(KEY)).toBe(false);
    });

    it("stops ringing when the user joins from any device", () => {
        store.add(KEY, room, notification());
        setMemberships(["@pon:example.org", client.getSafeUserId()]);
        expect(store.has(KEY)).toBe(false);
    });

    it("stops ringing when the room's call session ends", () => {
        store.add(KEY, room, notification());
        client.matrixRTC.emit(MatrixRTCSessionManagerEvents.SessionEnded, "!other:example.org", session);
        expect(store.has(KEY)).toBe(true);
        client.matrixRTC.emit(MatrixRTCSessionManagerEvents.SessionEnded, room.roomId, session);
        expect(store.has(KEY)).toBe(false);
    });

    it("stops ringing when the notification or its call is redacted", () => {
        store.add(KEY, room, notification());
        room.emit(
            MatrixEventEvent.BeforeRedaction,
            mkEvent({ event: true, type: "m.room.message", user: "@a:b", content: {} }),
            {} as MatrixEvent,
        );
        expect(store.has(KEY)).toBe(true);
        const member = mkEvent({ event: true, type: "m.room.message", user: "@a:b", content: {}, id: "$member" });
        room.emit(MatrixEventEvent.BeforeRedaction, member, {} as MatrixEvent);
        expect(store.has(KEY)).toBe(false);
    });

    it("stops ringing when another of the user's devices declines", () => {
        store.add(KEY, room, notification());
        const decline = (sender: string): MatrixEvent =>
            mkEvent({
                event: true,
                type: EventType.RTCDecline,
                user: sender,
                room: room.roomId,
                content: { "m.relates_to": { rel_type: "m.reference", event_id: "$ring" } },
            });
        room.emit(RoomEvent.Timeline, decline("@pon:example.org"), room, false, false, {} as never);
        expect(store.has(KEY)).toBe(true);
        room.emit(RoomEvent.Timeline, decline(client.getSafeUserId()), room, false, false, {} as never);
        expect(store.has(KEY)).toBe(false);
    });

    it("silences the ring at once when declining, then tells the caller", () => {
        store.add(KEY, room, notification());
        store.decline(KEY);
        expect(store.has(KEY)).toBe(false);
        expect(client.sendRtcDecline).toHaveBeenCalledWith(room.roomId, "$ring");
    });

    it("stops watching a call once it no longer rings", () => {
        store.add(KEY, room, notification());
        store.dismiss(KEY);
        const changed = vi.fn();
        store.on(INCOMING_CALLS_CHANGED, changed);
        setMemberships([]);
        vi.runAllTimers();
        expect(changed).not.toHaveBeenCalled();
        expect(session.listenerCount(MatrixRTCSessionEvent.MembershipsChanged)).toBe(0);
    });
});
