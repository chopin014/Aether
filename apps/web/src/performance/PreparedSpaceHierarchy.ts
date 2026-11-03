/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type JoinRule, type MatrixClient, Room, type RoomSummary } from "matrix-js-sdk/src/matrix";
import { RoomHierarchy } from "matrix-js-sdk/src/room-hierarchy";

/** A public hierarchy page shared by the Space preview and its eventual joined view. */
export interface PreparedSpaceHierarchy {
    hierarchy: RoomHierarchy;
    ready: Promise<void>;
}

interface CachedHierarchy {
    prepared: PreparedSpaceHierarchy;
    createdAt: number;
    expiresAt: number;
}

const CACHE_LIFETIME_MS = 30_000;
// Public metadata only seeds a preview until its own summary arrives, so it may be older than a reusable page.
const SUMMARY_HINT_LIFETIME_MS = 5 * 60_000;
const CACHE_LIMIT = 8;
const FIRST_PAGE_SIZE = 20;
const preparations = new WeakMap<MatrixClient, Map<string, CachedHierarchy>>();

/**
 * Fetch the public hierarchy while its Join prompt is visible. The root is only an API adapter: it is never stored,
 * assigned membership, or used to render a conversation. Access remains subject to the server's hierarchy checks.
 */
export function prepareSpaceHierarchy(client: MatrixClient, spaceId: string): PreparedSpaceHierarchy {
    let cache = preparations.get(client);
    if (!cache) preparations.set(client, (cache = new Map()));
    const existing = cache.get(spaceId);
    // Pages past their reuse lifetime stay cached for summary hints until replaced here or evicted.
    if (existing && existing.expiresAt > Date.now()) return existing.prepared;

    const root = client.getRoom(spaceId) ?? new Room(spaceId, client, client.getSafeUserId());
    const hierarchy = new RoomHierarchy(root, FIRST_PAGE_SIZE);
    const prepared: PreparedSpaceHierarchy = {
        hierarchy,
        ready: hierarchy.load().then(() => {}),
    };
    const createdAt = Date.now();
    const entry = { prepared, createdAt, expiresAt: createdAt + CACHE_LIFETIME_MS };
    cache.delete(spaceId);
    cache.set(spaceId, entry);
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    void prepared.ready.catch(() => {
        if (cache.get(spaceId) === entry) cache.delete(spaceId);
    });
    return prepared;
}

/** Discard a prepared page after explicit hierarchy edits or refresh requests. */
export function invalidatePreparedSpaceHierarchy(client: MatrixClient, spaceId: string): void {
    preparations.get(client)?.delete(spaceId);
}

/**
 * Public metadata for a room listed in a recently loaded hierarchy page. It carries no membership or encryption
 * fields, so it may only stand in for the room summary while that request is in flight.
 */
export function getPreparedHierarchySummary(client: MatrixClient, roomId: string): RoomSummary | undefined {
    const cache = preparations.get(client);
    if (!cache) return;
    const now = Date.now();
    // Prefer the newest page that lists this room.
    for (const { prepared, createdAt } of [...cache.values()].reverse()) {
        if (now - createdAt > SUMMARY_HINT_LIFETIME_MS) continue;
        const room = prepared.hierarchy.roomMap.get(roomId);
        if (!room) continue;
        return {
            room_id: room.room_id,
            name: room.name,
            topic: room.topic,
            avatar_url: room.avatar_url,
            canonical_alias: room.canonical_alias,
            num_joined_members: room.num_joined_members,
            world_readable: room.world_readable,
            guest_can_join: room.guest_can_join,
            room_type: room.room_type,
            join_rule: room.join_rule as JoinRule | undefined,
        };
    }
}
