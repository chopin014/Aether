/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { EventType, type MatrixClient, type MatrixEvent, type Room, RoomStateEvent } from "matrix-js-sdk/src/matrix";
import { logger as rootLogger } from "matrix-js-sdk/src/logger";

import { type Call, CallEvent, ConnectionState } from "./Call";
import {
    type PublishedVoiceStateContent,
    VOICE_STATE_EVENT_TYPE,
    voiceStateKey,
} from "../utils/call/publishedVoiceState";

const logger = rootLogger.getChild("VoiceStatePublisher");

/** How long to wait for mute and deafen toggles to settle before telling the room, so a burst sends one event. */
export const VOICE_STATE_PUBLISH_DELAY_MS = 750;

/**
 * Keeps this device's {@link VOICE_STATE_EVENT_TYPE} state in a voice channel current while it is in the call, and
 * clears it on leaving, so that people who have not joined can see who is muted or deafened.
 *
 * Existing channels do not let everyone send the event, so the first person who joins and can change the room's
 * permissions lets everyone send it, and nothing else.
 */
export class VoiceStatePublisher {
    private timer?: number;
    private disposed = false;
    /** What we last sent, which the room's state only shows once it comes back through sync. */
    private lastSent?: Partial<PublishedVoiceStateContent>;

    public constructor(
        private readonly call: Call,
        private readonly room: Room,
        private readonly client: MatrixClient,
    ) {
        call.on(CallEvent.VoiceStates, this.schedule);
        call.on(CallEvent.ConnectionState, this.onConnectionState);
        room.on(RoomStateEvent.Events, this.onRoomState);
    }

    public dispose(): void {
        this.disposed = true;
        window.clearTimeout(this.timer);
        this.call.off(CallEvent.VoiceStates, this.schedule);
        this.call.off(CallEvent.ConnectionState, this.onConnectionState);
        this.room.off(RoomStateEvent.Events, this.onRoomState);
    }

    private readonly onConnectionState = (state: ConnectionState): void => {
        if (state === ConnectionState.Connected) {
            void this.allowEveryoneToPublish();
            this.schedule();
        } else if (state === ConnectionState.Disconnected) {
            // The call may be torn down right after, so the leave is not delayed.
            window.clearTimeout(this.timer);
            this.publish();
        }
    };

    /** Once we are allowed to send the event, send what is waiting to be sent. */
    private readonly onRoomState = (event: MatrixEvent): void => {
        if (event.getType() === EventType.RoomPowerLevels) this.schedule();
    };

    private readonly schedule = (): void => {
        if (this.disposed) return;
        window.clearTimeout(this.timer);
        this.timer = window.setTimeout(this.publish, VOICE_STATE_PUBLISH_DELAY_MS);
    };

    /** What this device's state should say now, or undefined while the call has not reported it yet. */
    private desiredContent(): PublishedVoiceStateContent | Record<string, never> | undefined {
        if (this.call.connectionState !== ConnectionState.Connected) return {};
        const own = this.call.voiceStates.get(this.client.getSafeUserId());
        return own ? { muted: own.muted, deafened: own.deafened } : undefined;
    }

    private readonly publish = (): void => {
        const userId = this.client.getSafeUserId();
        const deviceId = this.client.getDeviceId();
        const content = this.desiredContent();
        if (!deviceId || !content) return;

        const stateKey = voiceStateKey(userId, deviceId);
        const current =
            this.lastSent ??
            this.room.currentState.getStateEvents(VOICE_STATE_EVENT_TYPE, stateKey)?.getContent() ??
            {};
        if (current.muted === content.muted && current.deafened === content.deafened) return;
        if (!this.room.currentState.maySendStateEvent(VOICE_STATE_EVENT_TYPE, userId)) return;

        this.lastSent = content;
        this.client.sendStateEvent(this.room.roomId, VOICE_STATE_EVENT_TYPE, content, stateKey).catch((error) => {
            // Compare with the room again next time, so a later change retries.
            if (this.lastSent === content) this.lastSent = undefined;
            logger.warn(`Could not publish voice state in ${this.room.roomId}`, error);
        });
    };

    /**
     * Adds the voice state event to the room's permissions at the level everyone has, when the room does not
     * mention it yet and we may change permissions. The rest of the permissions are sent back exactly as they are.
     */
    private async allowEveryoneToPublish(): Promise<void> {
        const state = this.room.currentState;
        const powerLevels = state.getStateEvents(EventType.RoomPowerLevels, "");
        if (!powerLevels) return;
        const content = powerLevels.getContent();
        const events: Record<string, number> = content.events ?? {};
        if (events[VOICE_STATE_EVENT_TYPE] !== undefined) return;
        if (!state.maySendStateEvent(EventType.RoomPowerLevels, this.client.getSafeUserId())) return;

        try {
            await this.client.sendStateEvent(this.room.roomId, EventType.RoomPowerLevels, {
                ...content,
                events: { ...events, [VOICE_STATE_EVENT_TYPE]: 0 },
            });
        } catch (error) {
            logger.warn(`Could not let everyone publish voice state in ${this.room.roomId}`, error);
        }
    }
}
