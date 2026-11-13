/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/**
 * The steps of opening a room, in the order they normally happen:
 * - `navigation`: the app takes the room as the one to show.
 * - `shell`: the room's view is mounted.
 * - `rows`: its timeline has rows to show.
 * - `placed`: the timeline has placed the reader in them.
 * - `painted`: the timeline has painted a message.
 * - `composer`: the message composer is mounted and focused.
 */
export const ROOM_SWITCH_PHASES = ["navigation", "shell", "rows", "placed", "painted", "composer"] as const;

/** One of {@link ROOM_SWITCH_PHASES}. */
export type RoomSwitchPhase = (typeof ROOM_SWITCH_PHASES)[number];

/** The start of each phase's mark name; the phase follows it. */
export const ROOM_SWITCH_MARK_PREFIX = "aether:switch:";

/** What a mark's `detail` holds: the room it is for. Nothing a room holds, such as messages, is recorded. */
export interface RoomSwitchMarkDetail {
    roomId: string;
}

/**
 * What a page sets on its window to have room switches marked, before the app loads, such as a benchmark measuring
 * where a switch spends its time. Nothing is marked otherwise.
 */
export interface RoomSwitchMarksWindow {
    aetherRoomSwitchMarks?: boolean;
}

/** At most this many marks of each phase are kept; older ones are cleared, should nobody collect them. */
const MAX_MARKS_PER_PHASE = 50;

/**
 * Note that a room has reached `phase` of being opened, as a `performance.mark` named after the phase with the room in
 * its detail, when the page asked for room switches to be marked; see {@link RoomSwitchMarksWindow}. Otherwise this
 * does nothing. Whoever reads the marks clears them, as the navigation benchmark does.
 * @param phase - The step reached.
 * @param roomId - The room being opened. Nothing is marked without one.
 */
export function markRoomSwitch(phase: RoomSwitchPhase, roomId: string | null | undefined): void {
    if (!roomId || (window as RoomSwitchMarksWindow).aetherRoomSwitchMarks !== true) return;
    try {
        const name = ROOM_SWITCH_MARK_PREFIX + phase;
        if (performance.getEntriesByName(name, "mark").length >= MAX_MARKS_PER_PHASE) performance.clearMarks(name);
        performance.mark(name, { detail: { roomId } satisfies RoomSwitchMarkDetail });
    } catch {
        // Marks are only diagnostics.
    }
}
