/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type Room } from "matrix-js-sdk/src/matrix";

/**
 * The room state event in which each Aether device in a voice channel's call says whether it is muted or
 * deafened, so that people who have not joined can see it too. Its content is {@link PublishedVoiceStateContent},
 * or empty once the device has left.
 */
export const VOICE_STATE_EVENT_TYPE = "io.aether.call.voice_state";

/** The content of a {@link VOICE_STATE_EVENT_TYPE} event. */
export interface PublishedVoiceStateContent {
    muted: boolean;
    deafened: boolean;
}

/**
 * The state key of a device's voice state. It starts with the user ID, like call memberships do, so that readers
 * can tell whose state it claims to be.
 */
export function voiceStateKey(userId: string, deviceId: string): string {
    return `_${userId}_${deviceId}`;
}

/**
 * Whether someone is muted or deafened in a room's call, from what their devices in the call have published.
 * Like the call itself does, a person counts as muted or deafened only when all of their devices are.
 *
 * Anyone in the room may send this event type, so a device's state only counts when its owner sent it.
 *
 * @param room - The room the call is in.
 * @param userId - Whose state to read.
 * @param deviceIds - The devices they have in the call. Older states of devices that have left are ignored.
 * @returns Their state, or undefined when none of their devices has published one.
 */
export function getPublishedVoiceState(
    room: Room,
    userId: string,
    deviceIds: Iterable<string>,
): PublishedVoiceStateContent | undefined {
    let state: PublishedVoiceStateContent | undefined;
    for (const deviceId of deviceIds) {
        const event = room.currentState.getStateEvents(VOICE_STATE_EVENT_TYPE, voiceStateKey(userId, deviceId));
        const content = event?.getSender() === userId ? event.getContent() : undefined;
        if (typeof content?.muted !== "boolean" || typeof content.deafened !== "boolean") continue;
        state = {
            muted: (state?.muted ?? true) && content.muted,
            deafened: (state?.deafened ?? true) && content.deafened,
        };
    }
    return state;
}
