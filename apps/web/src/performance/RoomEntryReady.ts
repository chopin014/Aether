/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { ClientEvent, type MatrixClient, type Room, SyncState } from "matrix-js-sdk/src/matrix";

/**
 * One visit to a room: from the app opening it until it is opened again. Work deferred for the room waits for the
 * current visit's conversation to paint, and a paint notification counts only for the visit it was scheduled under.
 * Compared by identity; its fields are only for reading.
 */
export interface RoomEntryVisit {
    readonly client: MatrixClient;
    readonly roomId: string;
}

interface RoomEntry {
    room: Room | null;
    visit: RoomEntryVisit;
    ready: boolean;
    pending: Set<() => void>;
    deadline?: ReturnType<typeof setTimeout>;
    /** Told when a new visit begins, so a timeline still shown for the room can notify for it. */
    visitListeners: Set<() => void>;
}

const entries = new WeakMap<MatrixClient, Map<string, RoomEntry>>();
const ENTRY_DEADLINE_MS = 3000;

function newEntry(client: MatrixClient, roomId: string, room: Room | null): RoomEntry {
    return { room, visit: { client, roomId }, ready: false, pending: new Set(), visitListeners: new Set() };
}

function entryFor(client: MatrixClient, roomId: string): RoomEntry {
    let clientEntries = entries.get(client);
    if (!clientEntries) entries.set(client, (clientEntries = new Map()));
    const room = client.getRoom(roomId);
    let entry = clientEntries.get(roomId);
    if (entry && !entry.room) entry.room = room;
    if (entry && entry.room !== room) {
        clearTimeout(entry.deadline);
        entry.pending.clear();
        const listeners = entry.visitListeners;
        entry = newEntry(client, roomId, room);
        entry.visitListeners = listeners;
    }
    entry ??= newEntry(client, roomId, room);
    clientEntries.set(roomId, entry);
    return entry;
}

function armDeadline(entry: RoomEntry): void {
    entry.deadline ??= setTimeout(() => release(entry, entry.visit), ENTRY_DEADLINE_MS);
}

function release(entry: RoomEntry, visit: RoomEntryVisit): void {
    if (visit !== entry.visit) return;
    clearTimeout(entry.deadline);
    entry.deadline = undefined;
    entry.ready = true;
    for (const start of entry.pending) {
        // A start can begin a new visit; what is still pending then waits for that one.
        if (visit !== entry.visit) break;
        entry.pending.delete(start);
        start();
    }
}

/**
 * Begin a new visit to a room, as the app opens it again: work deferred for it waits for this visit's conversation to
 * paint, rather than starting at once because an earlier visit painted. Work still waiting waits for this visit, under
 * a deadline of its own, and timelines still shown for the room are told so they notify for it.
 */
export function beginRoomEntryVisit(client: MatrixClient, roomId: string): void {
    const entry = entryFor(client, roomId);
    entry.visit = { client, roomId };
    entry.ready = false;
    clearTimeout(entry.deadline);
    entry.deadline = undefined;
    if (entry.pending.size > 0) armDeadline(entry);
    // A copy: a listener may stop or start listening as it is told.
    for (const listener of Array.from(entry.visitListeners)) listener();
}

/** The room's current visit, for a timeline to notify its paint under; see {@link notifyRoomEntryReady}. */
export function currentRoomEntryVisit(client: MatrixClient, roomId: string): RoomEntryVisit {
    return entryFor(client, roomId).visit;
}

/** Call `listener` each time a new visit to the room begins, until the returned function is called. */
export function onRoomEntryVisit(client: MatrixClient, roomId: string, listener: () => void): () => void {
    const listeners = entryFor(client, roomId).visitListeners;
    listeners.add(listener);
    return () => {
        entries.get(client)?.get(roomId)?.visitListeners.delete(listener);
        listeners.delete(listener);
    };
}

/**
 * Release automatic roster work after the destination's initial timeline has painted, for the visit the paint was
 * scheduled under. A paint from an earlier visit, such as from a timeline being taken down, releases nothing.
 */
export function notifyRoomEntryReady(client: MatrixClient, roomId: string, visit: RoomEntryVisit): void {
    release(entryFor(client, roomId), visit);
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
    const wait = (): void => {
        entry.pending.add(start);
        armDeadline(entry);
    };
    const start = (): void => {
        const visit = entry.visit;
        // Queue a task so a paint notification never imports a large roster synchronously.
        task = setTimeout(() => {
            task = undefined;
            // A Room the SDK created after the work was scheduled is the destination, not a replacement.
            entry.room ??= client.getRoom(roomId);
            if (client.getRoom(roomId) !== entry.room) return;
            // Released for a visit that has since been followed by another not yet painted: wait for that one.
            if (entry.visit !== visit && !entry.ready) {
                wait();
                return;
            }
            work();
        }, 0);
    };
    if (entry.ready) start();
    else wait();
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
