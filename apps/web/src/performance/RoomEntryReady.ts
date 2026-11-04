/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { ClientEvent, type MatrixClient, type Room, SyncState } from "matrix-js-sdk/src/matrix";

interface RoomEntry {
    room: Room | null;
    ready: boolean;
    pending: Set<() => void>;
    deadline?: ReturnType<typeof setTimeout>;
}

const entries = new WeakMap<MatrixClient, Map<string, RoomEntry>>();
const ENTRY_DEADLINE_MS = 3000;

function entryFor(client: MatrixClient, roomId: string): RoomEntry {
    let clientEntries = entries.get(client);
    if (!clientEntries) entries.set(client, (clientEntries = new Map()));
    const room = client.getRoom(roomId);
    let entry = clientEntries.get(roomId);
    if (entry && !entry.room) entry.room = room;
    if (entry && entry.room !== room) {
        clearTimeout(entry.deadline);
        entry.pending.clear();
        entry = undefined;
    }
    if (!entry) {
        entry = { room, ready: false, pending: new Set() };
        clientEntries.set(roomId, entry);
    }
    return entry;
}

function release(entry: RoomEntry): void {
    clearTimeout(entry.deadline);
    entry.deadline = undefined;
    entry.ready = true;
    for (const start of entry.pending) start();
    entry.pending.clear();
}

/** Release automatic roster work after the destination's initial timeline has painted. */
export function notifyRoomEntryReady(client: MatrixClient, roomId: string): void {
    release(entryFor(client, roomId));
}

/**
 * Keep decorative roster hydration off the first conversation's critical path.
 * Permission, encryption and explicitly requested member lists should load directly instead.
 * Cancel when the consumer unmounts or changes its destination. Empty/error timelines fall back after three seconds.
 */
export function deferRoomEntryWork(client: MatrixClient, roomId: string | undefined, work: () => void): () => void {
    if (!roomId) {
        work();
        return () => {};
    }
    const entry = entryFor(client, roomId);
    let task: ReturnType<typeof setTimeout> | undefined;
    const start = (): void => {
        // Queue a task so a paint notification never imports a large roster synchronously.
        task = setTimeout(() => {
            // A Room the SDK created after the work was scheduled is the destination, not a replacement.
            entry.room ??= client.getRoom(roomId);
            if (client.getRoom(roomId) === entry.room) work();
        }, 0);
    };
    if (entry.ready) start();
    else {
        entry.pending.add(start);
        entry.deadline ??= setTimeout(() => release(entry), ENTRY_DEADLINE_MS);
    }
    return () => {
        clearTimeout(task);
        entry.pending.delete(start);
        if (!entry.ready && entry.pending.size === 0) {
            clearTimeout(entry.deadline);
            entry.deadline = undefined;
        }
    };
}

const ACCOUNT_SYNC_DEADLINE_MS = 15_000;

/**
 * Hold optional background work until the account's first sync has been processed, so heavy module loading stays
 * out of startup and first joins. Runs anyway after a deadline, since a failing sync should not disable the work.
 */
export function deferUntilAccountSync(client: MatrixClient, work: () => void): () => void {
    if (client.isInitialSyncComplete()) {
        work();
        return () => {};
    }
    let done = false;
    const run = (): void => {
        if (done) return;
        cancel();
        work();
    };
    const onSync = (state: SyncState): void => {
        if (state === SyncState.Prepared || state === SyncState.Syncing) run();
    };
    const deadline = setTimeout(run, ACCOUNT_SYNC_DEADLINE_MS);
    const cancel = (): void => {
        done = true;
        clearTimeout(deadline);
        client.off(ClientEvent.Sync, onSync);
    };
    client.on(ClientEvent.Sync, onSync);
    return cancel;
}
