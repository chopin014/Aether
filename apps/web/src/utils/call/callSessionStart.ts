/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { EventType, type MatrixEvent, type Room } from "matrix-js-sdk/src/matrix";
import { type CallMembership } from "matrix-js-sdk/src/matrixrtc";

/**
 * How long a call may sit empty and still count as the same call, so that a reconnect, or someone leaving just
 * as someone else joins, does not restart the timer.
 */
export const CALL_GAP_GRACE_MS = 15_000;

/** A stretch of time during which one device was known to be in a room's call. */
interface Presence {
    from: number;
    until: number;
}

/** What we last worked out for a room: the call was continuously occupied from `start` until `seenAt`. */
interface Remembered {
    start: number;
    seenAt: number;
}

const remembered = new WeakMap<Room, Remembered>();

/** Whether a call member event's content describes someone in the call, as opposed to someone leaving it. */
function isJoined(content: Record<string, unknown>): boolean {
    return Object.keys(content).length > 0 && (content.application === undefined || content.application === "m.call");
}

/** When the membership in a call member event's content began. */
function joinedAt(content: Record<string, unknown>, fallback: number): number {
    return typeof content.created_ts === "number" && content.created_ts > 0 ? content.created_ts : fallback;
}

/**
 * Every stretch of call presence the room's state and loaded timeline tell us about, including people who have
 * since left. A device's later membership events end its earlier ones, and a leave event's previous content says
 * when the membership it ends began.
 */
function knownPresence(room: Room): Presence[] {
    const events = new Map<string, MatrixEvent>();
    for (const event of room.getLiveTimeline().getEvents()) {
        if (event.getType() === EventType.GroupCallMemberPrefix && event.isState()) {
            events.set(event.getId() ?? `${event.getStateKey()}:${event.getTs()}`, event);
        }
    }
    for (const event of room.currentState.getStateEvents(EventType.GroupCallMemberPrefix)) {
        events.set(event.getId() ?? `${event.getStateKey()}:${event.getTs()}`, event);
    }

    const byDevice = new Map<string, MatrixEvent[]>();
    for (const event of events.values()) {
        const key = event.getStateKey() ?? "";
        byDevice.set(key, [...(byDevice.get(key) ?? []), event]);
    }

    const presence: Presence[] = [];
    for (const deviceEvents of byDevice.values()) {
        deviceEvents.sort((a, b) => a.getTs() - b.getTs());
        deviceEvents.forEach((event, index) => {
            const content = event.getContent();
            const next = deviceEvents[index + 1];
            if (isJoined(content)) {
                presence.push({ from: joinedAt(content, event.getTs()), until: next?.getTs() ?? event.getTs() });
            } else if (index === 0 && isJoined(event.getPrevContent())) {
                // The join this leave ends is not loaded, but its content came along with the leave.
                presence.push({ from: joinedAt(event.getPrevContent(), event.getTs()), until: event.getTs() });
            }
        });
    }
    return presence;
}

/**
 * When the call in a room started: how long it has been since the call was last empty, the way Discord times a
 * voice channel, rather than when the earliest person still in it joined.
 *
 * Someone who has left still kept the call going if they were in it when the next person joined, so the start
 * walks back through every overlapping stretch of presence we know about. The room's history may not go back far
 * enough while the app has been open, so the answer is also remembered for as long as the call stays occupied.
 *
 * @param room - The room the call is in.
 * @param memberships - The memberships currently in the room's call.
 * @param now - The current time, in milliseconds since the epoch.
 * @returns The start in milliseconds since the epoch, or undefined while nobody is in the call.
 */
export function getCallSessionStart(
    room: Room,
    memberships: readonly CallMembership[],
    now = Date.now(),
): number | undefined {
    const joined = memberships.map((membership) => membership.createdTs()).filter((ts) => ts > 0);
    if (joined.length === 0) {
        remembered.delete(room);
        return undefined;
    }

    let start = Math.min(...joined);
    const presence = knownPresence(room);
    for (let extended = true; extended;) {
        extended = false;
        for (const { from, until } of presence) {
            if (from < start && until >= start - CALL_GAP_GRACE_MS) {
                start = from;
                extended = true;
            }
        }
    }

    // What we worked out earlier still holds if the call has stayed occupied since: someone in it now was already
    // in it when we last looked.
    const before = remembered.get(room);
    if (before && start <= before.seenAt + CALL_GAP_GRACE_MS) start = Math.min(start, before.start);
    remembered.set(room, { start, seenAt: now });
    return start;
}
