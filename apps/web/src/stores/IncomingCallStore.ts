/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    EventType,
    MatrixEventEvent,
    RoomEvent,
    TypedEventEmitter,
    type MatrixEvent,
    type Room,
} from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";
import {
    MatrixRTCSessionEvent,
    MatrixRTCSessionManagerEvents,
    type IRTCNotificationContent,
} from "matrix-js-sdk/src/matrixrtc";

import { getNotificationEventSendTs } from "../toasts/IncomingCallToast";

/** How long a call rings when its notification does not say. */
const DEFAULT_RING_TIME_MS = 90 * 1000;

/** A call that is ringing on this device and waiting for the user to answer or decline it. */
export interface IncomingCall {
    /** Identifies the call in its room; the same key as the incoming call toast. */
    readonly key: string;
    /** The room the call is in. */
    readonly room: Room;
    /** The MatrixRTC notification that started the ringing. */
    readonly notificationEvent: MatrixEvent;
    /** Whether the caller rang this user directly, rather than announcing a call in a group room. */
    readonly ring: boolean;
    /** Whether the caller started a voice call rather than a video call. */
    readonly voiceOnly: boolean;
}

export const INCOMING_CALLS_CHANGED = "incoming_calls_changed";

type EventMap = { [INCOMING_CALLS_CHANGED]: () => void };

/**
 * The calls ringing on this device. A call stops ringing when it is answered or declined here or on another of the
 * user's devices, when the caller hangs up, when its notification is redacted, or when its lifetime runs out. Ringing
 * is tracked here rather than in the popup so it keeps working whatever is on screen.
 */
export class IncomingCallStore extends TypedEventEmitter<typeof INCOMING_CALLS_CHANGED, EventMap> {
    public static readonly instance = new IncomingCallStore();

    private readonly entries = new Map<string, { call: IncomingCall; stop: () => void }>();
    private list: readonly IncomingCall[] = [];

    /** The ringing calls, oldest first. A new array whenever the calls change. */
    public get calls(): readonly IncomingCall[] {
        return this.list;
    }

    /** Whether the call with this key is ringing. */
    public has(key: string): boolean {
        return this.entries.has(key);
    }

    /**
     * Start ringing for a call. Does nothing if the call is already ringing.
     * @param key The call's key, from {@link getIncomingCallToastKey}.
     * @param room The room the call is in.
     * @param notificationEvent The MatrixRTC notification for the call.
     */
    public add(key: string, room: Room, notificationEvent: MatrixEvent): void {
        if (this.entries.has(key)) return;
        const content = notificationEvent.getContent<Partial<IRTCNotificationContent>>();
        const call: IncomingCall = {
            key,
            room,
            notificationEvent,
            ring: content.notification_type === "ring",
            voiceOnly: content["m.call.intent"] === "audio",
        };
        this.entries.set(key, { call, stop: this.watch(call) });
        this.update();
    }

    /** Stop ringing for a call, for example because the user answered it. */
    public dismiss(key: string): void {
        const entry = this.entries.get(key);
        if (!entry) return;
        this.entries.delete(key);
        entry.stop();
        this.update();
    }

    /** Stop ringing for a call and tell the caller and the user's other devices that it was declined. */
    public decline(key: string): void {
        const call = this.entries.get(key)?.call;
        if (!call) return;
        // Silence the ring first; the decline is only a courtesy to the caller and may be slow.
        this.dismiss(key);
        const eventId = call.notificationEvent.getId();
        if (!eventId) return;
        call.room.client
            .sendRtcDecline(call.room.roomId, eventId)
            .catch((error) => logger.warn("Could not send the call decline", error));
    }

    /** Stop every ringing call without declining any of them. */
    public reset(): void {
        if (this.entries.size === 0) return;
        for (const { stop } of this.entries.values()) stop();
        this.entries.clear();
        this.update();
    }

    private update(): void {
        this.list = [...this.entries.values()].map(({ call }) => call);
        this.emit(INCOMING_CALLS_CHANGED);
    }

    /** Watch for everything that ends the ringing for a call. Returns a function that stops watching. */
    private watch(call: IncomingCall): () => void {
        const { key, room, notificationEvent } = call;
        const client = room.client;
        const dismiss = (): void => this.dismiss(key);
        const content = notificationEvent.getContent<Partial<IRTCNotificationContent>>();

        const lifetime = content.lifetime ?? DEFAULT_RING_TIME_MS;
        const timeout = setTimeout(dismiss, getNotificationEventSendTs(notificationEvent) + lifetime - Date.now());

        const onRedaction = (event: MatrixEvent): void => {
            const ids = [notificationEvent.getId(), notificationEvent.getRelation()?.event_id];
            if (ids.includes(event.getId())) dismiss();
        };

        // A decline sent by another of the user's devices.
        const onTimeline = (event: MatrixEvent): void => {
            if (
                event.getType() === EventType.RTCDecline &&
                event.getSender() === client.getUserId() &&
                event.relationEventId === notificationEvent.getId()
            ) {
                dismiss();
            }
        };

        // The caller hung up before anyone answered, or the user joined from this or another device.
        const session = client.matrixRTC.getRoomSession(room);
        const onMemberships = (): void => {
            const memberships = session.memberships;
            if (memberships.length === 0 || memberships.some((m) => m.userId === client.getUserId())) dismiss();
        };
        const onSessionEnded = (roomId: string): void => {
            if (roomId === room.roomId) dismiss();
        };

        room.on(MatrixEventEvent.BeforeRedaction, onRedaction);
        room.on(RoomEvent.Timeline, onTimeline);
        session.on(MatrixRTCSessionEvent.MembershipsChanged, onMemberships);
        client.matrixRTC.on(MatrixRTCSessionManagerEvents.SessionEnded, onSessionEnded);
        return () => {
            clearTimeout(timeout);
            room.off(MatrixEventEvent.BeforeRedaction, onRedaction);
            room.off(RoomEvent.Timeline, onTimeline);
            session.off(MatrixRTCSessionEvent.MembershipsChanged, onMemberships);
            client.matrixRTC.off(MatrixRTCSessionManagerEvents.SessionEnded, onSessionEnded);
        };
    }
}
