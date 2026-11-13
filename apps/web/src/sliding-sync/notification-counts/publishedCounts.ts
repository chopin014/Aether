/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/*
 * What the count engine publishes besides the numbers it sets on rooms: which counts are not exact, and which
 * rooms' counts changed.
 */

import { NotificationCountType, type Room } from "matrix-js-sdk/src/matrix";

/** How a published count that is not exact can be off. */
export enum InexactCount {
    /** At least this many: more could be unread than it says. Badges show it as "N+". */
    LowerBound = "lowerBound",
    /** As last seen: it could be too high, as well as too low. Badges show it as it is. */
    Approximate = "approximate",
}

/** A room's counts that are not exact, by scope. */
export interface InexactScopes {
    /** How the main timeline's count is off, if it is. */
    main?: InexactCount;
    /** How each thread's count is off, by root ID, for the threads whose counts are. */
    threads: ReadonlyMap<string, InexactCount>;
}

const inexact = new WeakMap<Room, InexactScopes>();

/**
 * Record which of a room's counts are not exact, by whatever sets the room's counts. Set it before the counts, so
 * whoever hears of new counts sees it too.
 * @param scopes - Undefined, or none set, when every count is as exact as the room's counts can be.
 */
export function setInexactCounts(room: Room, scopes: InexactScopes | undefined): void {
    if (!scopes || (!scopes.main && scopes.threads.size === 0)) {
        inexact.delete(room);
    } else {
        inexact.set(room, scopes);
    }
}

/** Which of a room's counts are not exact, if any are. */
export function getInexactCounts(room: Room): InexactScopes | undefined {
    return inexact.get(room);
}

/**
 * How several counts added together are off: as last seen if one is, as one of them could be too high; otherwise
 * at least their sum if one is a lower bound; otherwise exact. Only counts above zero are given: a count of zero
 * that is not exact, such as a Space's, which has no history, adds nothing to a sum, nor doubt to it.
 */
export function combineInexactCounts(counts: Iterable<InexactCount | undefined>): InexactCount | undefined {
    let result: InexactCount | undefined;
    for (const count of counts) {
        if (count === InexactCount.Approximate) return InexactCount.Approximate;
        if (count === InexactCount.LowerBound) result = InexactCount.LowerBound;
    }
    return result;
}

/**
 * How a room's unread count is off, if it is not exact: as set by {@link setInexactCounts}, for the counts it is
 * made of that are above zero.
 * @param threadId - The thread whose count it is; otherwise the room's.
 * @param includeThreads - For the room's count: whether it adds its threads' counts to the main timeline's.
 */
export function getInexactCount(room: Room, threadId?: string, includeThreads = false): InexactCount | undefined {
    const scopes = inexact.get(room);
    if (!scopes) return undefined;
    const positive = (thread?: string): boolean =>
        thread === undefined
            ? room.getRoomUnreadNotificationCount(NotificationCountType.Total) > 0 ||
              room.getRoomUnreadNotificationCount(NotificationCountType.Highlight) > 0
            : room.getThreadUnreadNotificationCount(thread, NotificationCountType.Total) > 0 ||
              room.getThreadUnreadNotificationCount(thread, NotificationCountType.Highlight) > 0;
    if (threadId) {
        const thread = scopes.threads.get(threadId);
        return thread && positive(threadId) ? thread : undefined;
    }
    const parts: Array<InexactCount | undefined> = [];
    if (scopes.main && positive()) parts.push(scopes.main);
    if (includeThreads) {
        for (const [id, thread] of scopes.threads) {
            if (positive(id)) parts.push(thread);
        }
    }
    return combineInexactCounts(parts);
}

const changeListeners = new Set<(room: Room) => void>();

/**
 * Hear of each room whose counts, or how far they can be trusted, the count engine changed. A room announces its
 * own changes, but the client does not pass them on, so this is how a view of many rooms' counts keeps up.
 * @returns A function that stops the listener hearing.
 */
export function onCountsChanged(listener: (room: Room) => void): () => void {
    changeListeners.add(listener);
    return () => changeListeners.delete(listener);
}

/** Tell whoever listens that a room's counts, or how far they can be trusted, changed. */
export function announceCountsChanged(room: Room): void {
    for (const listener of changeListeners) listener(room);
}
