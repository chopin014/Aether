/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientEvent, MatrixEvent, RoomEvent, SyncState, TypedEventEmitter } from "matrix-js-sdk/src/matrix";

import MatrixActionCreators from "./MatrixActionCreators";
import dis from "../dispatcher/dispatcher";

describe("MatrixActionCreators", () => {
    let synced = false;
    const client = Object.assign(new TypedEventEmitter<string, any>(), {
        isInitialSyncComplete: () => synced,
        getSyncState: () => (synced ? SyncState.Syncing : null),
    });
    const event = new MatrixEvent({ type: "m.room.message", room_id: "!room:example.org", event_id: "$e" });
    const timelineSet = {};
    const room = { roomId: "!room:example.org", getUnfilteredTimelineSet: () => timelineSet };
    const live = { liveEvent: true, timeline: { getTimelineSet: () => timelineSet } };

    beforeEach(() => {
        synced = false;
        vi.spyOn(dis, "dispatch").mockImplementation(() => {});
        MatrixActionCreators.start(client as any);
    });
    afterEach(() => {
        MatrixActionCreators.stop();
        vi.restoreAllMocks();
    });

    const dispatched = (): string[] => vi.mocked(dis.dispatch).mock.calls.map(([payload]) => payload.action);

    it("does not dispatch per-room updates while the initial sync is being processed", () => {
        client.emit(RoomEvent.Timeline, event, room, false, false, live);
        client.emit(RoomEvent.Receipt, event, room);
        expect(dispatched()).toEqual([]);
    });

    it("dispatches per-room updates once the initial sync is complete", () => {
        synced = true;
        client.emit(RoomEvent.Timeline, event, room, false, false, live);
        expect(dispatched()).toEqual(["MatrixActions.Room.timeline"]);
    });

    it("always dispatches sync state changes", () => {
        client.emit(ClientEvent.Sync, SyncState.Prepared, null, {});
        expect(dispatched()).toEqual(["MatrixActions.sync"]);
    });
});
