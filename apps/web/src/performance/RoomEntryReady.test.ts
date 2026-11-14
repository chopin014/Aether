/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientEvent, type MatrixClient, type Room, SyncState, TypedEventEmitter } from "matrix-js-sdk/src/matrix";

import { beginRoomEntryVisit, deferRoomEntryWork, deferUntilAccountSync, notifyRoomEntryReady } from "./RoomEntryReady";

const roomId = "!room:example.org";

function fixture(): { client: MatrixClient; replace: () => void } {
    // Only Room identity is needed; no SDK methods run on it.
    let room = {} as Room;
    return {
        client: { getRoom: () => room } as unknown as MatrixClient,
        replace: () => {
            room = {} as Room;
        },
    };
}

describe("RoomEntryReady", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("waits for painted conversation and schedules hydration outside the paint callback", () => {
        const { client } = fixture();
        const work = vi.fn();
        deferRoomEntryWork(client, roomId, work);
        vi.advanceTimersByTime(500);
        expect(work).not.toHaveBeenCalled();
        notifyRoomEntryReady(client, roomId);
        expect(work).not.toHaveBeenCalled();
        vi.advanceTimersByTime(0);
        expect(work).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("bounds waits when a timeline is empty or cannot load", () => {
        const { client } = fixture();
        const work = vi.fn();
        deferRoomEntryWork(client, roomId, work);
        vi.advanceTimersByTime(2999);
        expect(work).not.toHaveBeenCalled();
        vi.advanceTimersByTime(2);
        expect(work).toHaveBeenCalledOnce();
    });

    it("shares a single destination barrier across channel and Space consumers", () => {
        const { client } = fixture();
        const channel = vi.fn();
        const space = vi.fn();
        deferRoomEntryWork(client, roomId, channel);
        deferRoomEntryWork(client, roomId, space);
        expect(vi.getTimerCount()).toBe(1);
        notifyRoomEntryReady(client, roomId);
        vi.runAllTimers();
        expect(channel).toHaveBeenCalledOnce();
        expect(space).toHaveBeenCalledOnce();
    });

    it("cancels an unmounted consumer without blocking remaining consumers", () => {
        const { client } = fixture();
        const stale = vi.fn();
        const current = vi.fn();
        const cancel = deferRoomEntryWork(client, roomId, stale);
        deferRoomEntryWork(client, roomId, current);
        cancel();
        notifyRoomEntryReady(client, roomId);
        vi.runAllTimers();
        expect(stale).not.toHaveBeenCalled();
        expect(current).toHaveBeenCalledOnce();
    });

    it("cancels work already released into the task queue", () => {
        const { client } = fixture();
        const work = vi.fn();
        const cancel = deferRoomEntryWork(client, roomId, work);
        notifyRoomEntryReady(client, roomId);
        cancel();
        vi.runAllTimers();
        expect(work).not.toHaveBeenCalled();
    });

    it("clears the fallback timer when all consumers leave", () => {
        const { client } = fixture();
        deferRoomEntryWork(client, roomId, vi.fn())();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("does not hold later consumers of an already painted Room", () => {
        const { client } = fixture();
        notifyRoomEntryReady(client, roomId);
        const work = vi.fn();
        deferRoomEntryWork(client, roomId, work);
        vi.advanceTimersByTime(0);
        expect(work).toHaveBeenCalledOnce();
    });

    it("waits for the paint of a new visit to a room, not an earlier visit's", () => {
        const { client } = fixture();
        notifyRoomEntryReady(client, roomId);

        beginRoomEntryVisit(client, roomId);
        const work = vi.fn();
        deferRoomEntryWork(client, roomId, work);
        vi.advanceTimersByTime(500);
        expect(work).not.toHaveBeenCalled();

        notifyRoomEntryReady(client, roomId);
        vi.advanceTimersByTime(0);
        expect(work).toHaveBeenCalledOnce();
    });

    it("keeps work already waiting for a room waiting, under its deadline, as a new visit begins", () => {
        const { client } = fixture();
        const work = vi.fn();
        deferRoomEntryWork(client, roomId, work);
        vi.advanceTimersByTime(1000);

        beginRoomEntryVisit(client, roomId);
        vi.advanceTimersByTime(1999);
        expect(work).not.toHaveBeenCalled();
        vi.advanceTimersByTime(2);
        expect(work).toHaveBeenCalledOnce();
    });

    it("begins a visit to a room it knows nothing of without holding anything", () => {
        const { client } = fixture();
        beginRoomEntryVisit(client, roomId);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("isolates clients even when room IDs match", () => {
        const a = fixture();
        const b = fixture();
        const work = vi.fn();
        deferRoomEntryWork(b.client, roomId, work);
        notifyRoomEntryReady(a.client, roomId);
        vi.advanceTimersByTime(0);
        expect(work).not.toHaveBeenCalled();
        notifyRoomEntryReady(b.client, roomId);
        vi.runAllTimers();
        expect(work).toHaveBeenCalledOnce();
    });

    it("discards stale work and readiness when the SDK replaces a Room", () => {
        const { client, replace } = fixture();
        const stale = vi.fn();
        deferRoomEntryWork(client, roomId, stale);
        replace();
        const current = vi.fn();
        deferRoomEntryWork(client, roomId, current);
        notifyRoomEntryReady(client, roomId);
        vi.runAllTimers();
        expect(stale).not.toHaveBeenCalled();
        expect(current).toHaveBeenCalledOnce();
        replace();
        const replacement = vi.fn();
        deferRoomEntryWork(client, roomId, replacement);
        vi.advanceTimersByTime(0);
        expect(replacement).not.toHaveBeenCalled();
    });

    it("runs work without a conversation destination immediately", () => {
        const { client } = fixture();
        const work = vi.fn();
        deferRoomEntryWork(client, undefined, work)();
        expect(work).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("retains work scheduled before the SDK creates the destination Room", () => {
        let room: Room | null = null;
        const client = { getRoom: () => room } as unknown as MatrixClient;
        const work = vi.fn();
        deferRoomEntryWork(client, roomId, work);
        room = {} as Room;
        notifyRoomEntryReady(client, roomId);
        vi.runAllTimers();
        expect(work).toHaveBeenCalledOnce();
    });

    it("runs work the deadline releases after the SDK creates the destination Room", () => {
        let room: Room | null = null;
        const client = { getRoom: () => room } as unknown as MatrixClient;
        const work = vi.fn();
        deferRoomEntryWork(client, roomId, work);
        room = {} as Room;
        vi.advanceTimersByTime(3000);
        vi.runAllTimers();
        expect(work).toHaveBeenCalledOnce();
    });

    it("drops released work if the SDK replaces its Room before the task runs", () => {
        const { client, replace } = fixture();
        const work = vi.fn();
        deferRoomEntryWork(client, roomId, work);
        notifyRoomEntryReady(client, roomId);
        replace();
        vi.runAllTimers();
        expect(work).not.toHaveBeenCalled();
    });
});

describe("deferUntilAccountSync", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    function syncingClient(complete: boolean): MatrixClient {
        // An emitter stands in for the client's sync notifications.
        const emitter = new TypedEventEmitter<ClientEvent.Sync, { [ClientEvent.Sync]: (state: SyncState) => void }>();
        return Object.assign(emitter, { isInitialSyncComplete: () => complete }) as unknown as MatrixClient;
    }

    it("runs immediately once the account has synced", () => {
        const work = vi.fn();
        deferUntilAccountSync(syncingClient(true), work);
        expect(work).toHaveBeenCalledOnce();
    });

    it("waits for the first prepared sync and runs once", () => {
        const client = syncingClient(false);
        const work = vi.fn();
        deferUntilAccountSync(client, work);
        client.emit(ClientEvent.Sync, SyncState.Error, null);
        expect(work).not.toHaveBeenCalled();
        client.emit(ClientEvent.Sync, SyncState.Prepared, null);
        client.emit(ClientEvent.Sync, SyncState.Syncing, null);
        vi.advanceTimersByTime(20_000);
        expect(work).toHaveBeenCalledOnce();
        expect(client.listenerCount(ClientEvent.Sync)).toBe(0);
    });

    it("falls back after a deadline and can be cancelled", () => {
        const client = syncingClient(false);
        const late = vi.fn();
        deferUntilAccountSync(client, late);
        vi.advanceTimersByTime(15_000);
        expect(late).toHaveBeenCalledOnce();
        const cancelled = vi.fn();
        deferUntilAccountSync(client, cancelled)();
        client.emit(ClientEvent.Sync, SyncState.Prepared, null);
        vi.advanceTimersByTime(15_000);
        expect(cancelled).not.toHaveBeenCalled();
        expect(client.listenerCount(ClientEvent.Sync)).toBe(0);
    });
});
