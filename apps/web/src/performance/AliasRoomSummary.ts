/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type MatrixClient, type RoomSummary } from "matrix-js-sdk/src/matrix";

/** The directory answer for an alias: its room ID and servers that can be used to join it. */
export type AliasLookup = Awaited<ReturnType<MatrixClient["getRoomIdForAlias"]>>;

interface PendingSummary {
    summary: Promise<RoomSummary | undefined>;
    expiresAt: number;
}

interface PendingLookup {
    lookup: Promise<AliasLookup>;
    expiresAt: number;
}

const LIFETIME_MS = 30_000;
const LIMIT = 8;
const pending = new WeakMap<MatrixClient, Map<string, PendingSummary>>();
const lookups = new WeakMap<MatrixClient, Map<string, PendingLookup>>();

/**
 * Resolve an alias the app is about to open, together with its summary, as soon as the client has credentials.
 * Startup can then finish preparing storage, crypto and sync while both requests are in flight.
 */
export function prefetchAliasPreview(client: MatrixClient, alias: string): void {
    let pendingLookups = lookups.get(client);
    if (!pendingLookups) lookups.set(client, (pendingLookups = new Map()));
    const lookup = client.getRoomIdForAlias(alias);
    // Awaited by whoever takes the lookup; failures are reported there.
    lookup.catch(() => {});
    pendingLookups.delete(alias);
    pendingLookups.set(alias, { lookup, expiresAt: Date.now() + LIFETIME_MS });
    while (pendingLookups.size > LIMIT) pendingLookups.delete(pendingLookups.keys().next().value!);
    prefetchAliasSummary(client, alias);
}

/** Take an in-flight alias lookup started by prefetchAliasPreview. Each lookup is used at most once. */
export function takeAliasLookup(client: MatrixClient, alias: string): Promise<AliasLookup> | undefined {
    const pendingLookups = lookups.get(client);
    const entry = pendingLookups?.get(alias);
    pendingLookups?.delete(alias);
    if (!entry || entry.expiresAt <= Date.now()) return;
    return entry.lookup;
}

/**
 * Request an alias's room summary while the same alias is being resolved to a room ID. The summary endpoint accepts
 * aliases, so the preview no longer waits for the directory lookup and then a second round trip.
 */
export function prefetchAliasSummary(client: MatrixClient, alias: string, via?: string[]): void {
    let summaries = pending.get(client);
    if (!summaries) pending.set(client, (summaries = new Map()));
    const summary = client.getRoomSummary(alias, via).catch(() => undefined);
    summaries.delete(alias);
    summaries.set(alias, { summary, expiresAt: Date.now() + LIFETIME_MS });
    while (summaries.size > LIMIT) summaries.delete(summaries.keys().next().value!);
}

/**
 * Take the prefetched summary for an alias. It resolves to undefined unless it describes the expected room, since an
 * alias can move between rooms. Each prefetch is used at most once.
 */
export function takeAliasSummary(
    client: MatrixClient,
    alias: string,
    roomId: string,
): Promise<RoomSummary | undefined> | undefined {
    const summaries = pending.get(client);
    const entry = summaries?.get(alias);
    summaries?.delete(alias);
    if (!entry || entry.expiresAt <= Date.now()) return;
    return entry.summary.then((summary) => (summary?.room_id === roomId ? summary : undefined));
}
