/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import EventEmitter from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    EventType,
    type MatrixClient,
    MatrixEvent,
    PendingEventOrdering,
    Room,
    RoomStateEvent,
} from "matrix-js-sdk/src/matrix";
import { type VoiceState } from "@element-hq/element-call-component/api";
import { createTestClient } from "test-utils";

import { type Call, CallEvent, ConnectionState } from "./Call";
import { VOICE_STATE_PUBLISH_DELAY_MS, VoiceStatePublisher } from "./VoiceStatePublisher";
import { VOICE_STATE_EVENT_TYPE, voiceStateKey } from "../utils/call/publishedVoiceState";

const ME = "@me:server";
const DEVICE = "DEVICE";
const KEY = voiceStateKey(ME, DEVICE);

class FakeCall extends EventEmitter {
    public connectionState = ConnectionState.Disconnected;
    public voiceStates = new Map<string, VoiceState>();

    public connect(): void {
        this.connectionState = ConnectionState.Connected;
        this.emit(CallEvent.ConnectionState, ConnectionState.Connected, ConnectionState.Disconnected);
    }

    public disconnect(): void {
        this.connectionState = ConnectionState.Disconnected;
        this.emit(CallEvent.ConnectionState, ConnectionState.Disconnected, ConnectionState.Connected);
    }

    public report(muted: boolean, deafened: boolean): void {
        this.voiceStates = new Map([[ME, { userId: ME, muted, deafened }]]);
        this.emit(CallEvent.VoiceStates, this.voiceStates);
    }
}

describe("VoiceStatePublisher", () => {
    let room: Room;
    let call: FakeCall;
    let client: MatrixClient;
    let sendStateEvent: ReturnType<typeof vi.fn>;
    let publisher: VoiceStatePublisher;

    /** Sets the room's permissions, with `me` at `myLevel` and `events` as the per-event levels. */
    function setPowerLevels(myLevel: number, events: Record<string, number>): void {
        room.currentState.setStateEvents([
            new MatrixEvent({
                type: EventType.RoomPowerLevels,
                state_key: "",
                sender: "@admin:server",
                room_id: room.roomId,
                event_id: `$pl-${Math.random()}`,
                content: {
                    users: { [ME]: myLevel, "@admin:server": 100, "@mod:server": 50 },
                    users_default: 0,
                    events,
                    events_default: 0,
                    state_default: 50,
                    ban: 50,
                    kick: 50,
                    redact: 50,
                    invite: 0,
                },
            }),
        ]);
    }

    function setPublished(content: object): void {
        room.currentState.setStateEvents([
            new MatrixEvent({
                type: VOICE_STATE_EVENT_TYPE,
                state_key: KEY,
                sender: ME,
                room_id: room.roomId,
                event_id: `$voice-${Math.random()}`,
                content,
            }),
        ]);
    }

    beforeEach(() => {
        vi.useFakeTimers();
        const roomClient = createTestClient();
        room = new Room("!room:server", roomClient, ME, { pendingEventOrdering: PendingEventOrdering.Detached });
        // Permissions only count for people in the room.
        room.currentState.setStateEvents([
            new MatrixEvent({
                type: EventType.RoomCreate,
                state_key: "",
                sender: "@admin:server",
                room_id: room.roomId,
                event_id: "$create",
                content: { room_version: "10" },
            }),
            new MatrixEvent({
                type: EventType.RoomMember,
                state_key: ME,
                sender: ME,
                room_id: room.roomId,
                event_id: "$me-joined",
                content: { membership: "join" },
            }),
        ]);
        call = new FakeCall();
        sendStateEvent = vi.fn().mockResolvedValue({ event_id: "$sent" });
        client = { getSafeUserId: () => ME, getDeviceId: () => DEVICE, sendStateEvent } as unknown as MatrixClient;
        publisher = new VoiceStatePublisher(call as unknown as Call, room, client);
    });

    afterEach(() => {
        publisher.dispose();
        vi.useRealTimers();
    });

    it("publishes this device's state once toggles settle, and clears it on leaving", () => {
        setPowerLevels(0, { [VOICE_STATE_EVENT_TYPE]: 0 });
        call.connect();
        call.report(true, false);
        call.report(true, true);
        vi.advanceTimersByTime(VOICE_STATE_PUBLISH_DELAY_MS);
        expect(sendStateEvent).toHaveBeenCalledTimes(1);
        expect(sendStateEvent).toHaveBeenCalledWith(
            room.roomId,
            VOICE_STATE_EVENT_TYPE,
            { muted: true, deafened: true },
            KEY,
        );

        setPublished({ muted: true, deafened: true });
        sendStateEvent.mockClear();
        call.disconnect();
        expect(sendStateEvent).toHaveBeenCalledWith(room.roomId, VOICE_STATE_EVENT_TYPE, {}, KEY);
    });

    it("does not send the leave twice while it is on its way", () => {
        setPowerLevels(0, { [VOICE_STATE_EVENT_TYPE]: 0 });
        call.connect();
        call.report(true, false);
        vi.advanceTimersByTime(VOICE_STATE_PUBLISH_DELAY_MS);
        call.disconnect();
        // The call reports nobody once it closes, before the leave has come back through sync.
        call.voiceStates = new Map();
        call.emit(CallEvent.VoiceStates, call.voiceStates);
        vi.advanceTimersByTime(VOICE_STATE_PUBLISH_DELAY_MS);
        expect(sendStateEvent.mock.calls.map(([, , content]) => content)).toEqual([
            { muted: true, deafened: false },
            {},
        ]);
    });

    it("retries after a failed send", async () => {
        setPowerLevels(0, { [VOICE_STATE_EVENT_TYPE]: 0 });
        sendStateEvent.mockRejectedValueOnce(new Error("offline"));
        call.connect();
        call.report(true, false);
        vi.advanceTimersByTime(VOICE_STATE_PUBLISH_DELAY_MS);
        await vi.waitFor(() => expect(sendStateEvent).toHaveBeenCalledTimes(1));
        await Promise.resolve();
        call.report(true, false);
        vi.advanceTimersByTime(VOICE_STATE_PUBLISH_DELAY_MS);
        expect(sendStateEvent).toHaveBeenCalledTimes(2);
    });

    it("does not resend what the room already says", () => {
        setPowerLevels(0, { [VOICE_STATE_EVENT_TYPE]: 0 });
        setPublished({ muted: false, deafened: false });
        call.connect();
        call.report(false, false);
        vi.advanceTimersByTime(VOICE_STATE_PUBLISH_DELAY_MS);
        expect(sendStateEvent).not.toHaveBeenCalled();
    });

    it("waits for the call to report our state before publishing", () => {
        setPowerLevels(0, { [VOICE_STATE_EVENT_TYPE]: 0 });
        call.connect();
        vi.advanceTimersByTime(VOICE_STATE_PUBLISH_DELAY_MS);
        expect(sendStateEvent).not.toHaveBeenCalled();
    });

    it("leaves nothing to clear when it never published", () => {
        setPowerLevels(0, { [VOICE_STATE_EVENT_TYPE]: 0 });
        call.connect();
        call.disconnect();
        expect(sendStateEvent).not.toHaveBeenCalled();
    });

    it("lets everyone publish in an existing channel when we may change permissions, keeping every other level", () => {
        setPowerLevels(100, { "m.room.name": 50, "org.matrix.msc3401.call.member": 0 });
        const before = room.currentState.getStateEvents(EventType.RoomPowerLevels, "")!.getContent();
        call.connect();

        expect(sendStateEvent).toHaveBeenCalledWith(room.roomId, EventType.RoomPowerLevels, {
            ...before,
            events: { ...before.events, [VOICE_STATE_EVENT_TYPE]: 0 },
        });
        const sent = sendStateEvent.mock.calls[0][2];
        expect(sent.users).toEqual({ [ME]: 100, "@admin:server": 100, "@mod:server": 50 });
        expect(sent.state_default).toBe(50);
        expect(sent.ban).toBe(50);
    });

    it("leaves permissions alone when it cannot change them, or the room already mentions the event", () => {
        setPowerLevels(0, {});
        call.connect();
        call.disconnect();

        setPowerLevels(100, { [VOICE_STATE_EVENT_TYPE]: 50 });
        call.connect();

        expect(sendStateEvent).not.toHaveBeenCalledWith(room.roomId, EventType.RoomPowerLevels, expect.anything());
    });

    it("does not try to publish where it is not allowed, and publishes once it is", () => {
        setPowerLevels(0, {});
        call.connect();
        call.report(true, false);
        vi.advanceTimersByTime(VOICE_STATE_PUBLISH_DELAY_MS);
        expect(sendStateEvent).not.toHaveBeenCalled();

        setPowerLevels(0, { [VOICE_STATE_EVENT_TYPE]: 0 });
        room.emit(
            RoomStateEvent.Events,
            room.currentState.getStateEvents(EventType.RoomPowerLevels, "")!,
            room.currentState,
            null,
        );
        vi.advanceTimersByTime(VOICE_STATE_PUBLISH_DELAY_MS);
        expect(sendStateEvent).toHaveBeenCalledWith(
            room.roomId,
            VOICE_STATE_EVENT_TYPE,
            { muted: true, deafened: false },
            KEY,
        );
    });

    it("stops listening once disposed", () => {
        publisher.dispose();
        expect(call.listenerCount(CallEvent.VoiceStates)).toBe(0);
        expect(call.listenerCount(CallEvent.ConnectionState)).toBe(0);
    });
});
