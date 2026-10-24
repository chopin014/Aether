/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type SearchFilter } from "./query";

/** Where a search looks, before `in:` is applied. */
export interface ScopeInput {
    /** The room being viewed. */
    currentRoomId: string;
    /** The active space and the IDs of the rooms in it, when a space (server) is selected. */
    space?: { roomId: string; name: string; roomIds: ReadonlySet<string> };
}

export interface ResolvedScope {
    /** `space` searches the rooms of a space, `room` searches one room (a DM or a room outside any space). */
    kind: "space" | "room";
    roomIds: string[];
}

/**
 * Picks the rooms to search. A selected space searches all of its rooms, like Discord's "Search <server>"; a DM or a
 * room outside the space searches only itself. `in:` narrows either one and never widens it.
 */
export function resolveScope(input: ScopeInput, filters: SearchFilter[]): ResolvedScope {
    const { currentRoomId, space } = input;
    const inSpace = !!space && space.roomIds.has(currentRoomId);
    const base = inSpace ? [...space.roomIds] : [currentRoomId];

    const narrowed = filters.filter((filter) => filter.key === "in").map((filter) => filter.value);
    const roomIds = narrowed.length ? base.filter((roomId) => narrowed.includes(roomId)) : base;
    return { kind: inSpace ? "space" : "room", roomIds };
}
