/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/*
 * What the count engine publishes besides the numbers it sets on rooms: which counts are only lower bounds, and
 * which rooms' counts changed.
 */

import type { Room } from "matrix-js-sdk/src/matrix";

/**
 * Which of a room's unread counts are only lower bounds: more could be unread than they say, such as messages in
 * history this device has not seen. Badges show such a count as "N+".
 */
export interface LowerBoundScopes {
    /** Whether the main timeline's count is one. */
    main: boolean;
    /** The root IDs of the threads whose counts are. */
    threads: ReadonlySet<string>;
}

const lowerBounds = new WeakMap<Room, LowerBoundScopes>();

/**
 * Record which of a room's counts are lower bounds, by whatever sets the room's counts. Set it before the counts,
 * so whoever hears of new counts sees it too.
 * @param scopes - Undefined, or none set, when every count is as exact as the room's counts can be.
 */
export function setLowerBoundCounts(room: Room, scopes: LowerBoundScopes | undefined): void {
    if (!scopes || (!scopes.main && scopes.threads.size === 0)) {
        lowerBounds.delete(room);
    } else {
        lowerBounds.set(room, scopes);
    }
}

/** Which of a room's counts are lower bounds, if any are. */
export function getLowerBoundCounts(room: Room): LowerBoundScopes | undefined {
    return lowerBounds.get(room);
}

/**
 * Whether a room's unread count is only a lower bound.
 * @param threadId - The thread whose count it is; otherwise the room's.
 * @param includeThreads - For the room's count: whether it adds its threads' counts to the main timeline's.
 */
export function isLowerBoundCount(room: Room, threadId?: string, includeThreads = false): boolean {
    const scopes = lowerBounds.get(room);
    if (!scopes) return false;
    if (threadId) return scopes.threads.has(threadId);
    return scopes.main || (includeThreads && scopes.threads.size > 0);
}

const changeListeners = new Set<(room: Room) => void>();

/**
 * Hear of each room whose counts, or which of them are lower bounds, the count engine changed. A room announces
 * its own changes, but the client does not pass them on, so this is how a view of many rooms' counts keeps up.
 * @returns A function that stops the listener hearing.
 */
export function onCountsChanged(listener: (room: Room) => void): () => void {
    changeListeners.add(listener);
    return () => changeListeners.delete(listener);
}

/** Tell whoever listens that a room's counts, or which of them are lower bounds, changed. */
export function announceCountsChanged(room: Room): void {
    for (const listener of changeListeners) listener(room);
}
