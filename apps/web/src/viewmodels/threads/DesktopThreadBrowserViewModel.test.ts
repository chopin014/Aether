/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    EventTimelineSet,
    FeatureSupport,
    EventTimeline,
    Thread,
    MatrixEventEvent,
    PendingEventOrdering,
    Room,
    RoomEvent,
    type MatrixClient,
} from "matrix-js-sdk/src/matrix";
import { mkMessage, stubClient } from "test-utils";
import { mkThread } from "test-utils/threads";

import { DesktopThreadBrowserViewModel } from "./DesktopThreadBrowserViewModel";

async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("DesktopThreadBrowserViewModel", () => {
    let client: MatrixClient;
    let room: Room;
    let all: EventTimelineSet;
    let mine: EventTimelineSet;
    let vm: DesktopThreadBrowserViewModel;
    const onOpen = vi.fn();
    const onCreate = vi.fn();
    const createVm = () => new DesktopThreadBrowserViewModel({ client, room, onOpen, onCreate });

    beforeEach(() => {
        client = stubClient();
        vi.spyOn(client, "supportsThreads").mockReturnValue(true);
        Thread.hasServerSideSupport = FeatureSupport.Stable;
        room = new Room("!threads:example.org", client, client.getSafeUserId(), {
            pendingEventOrdering: PendingEventOrdering.Detached,
        });
        all = new EventTimelineSet(room, { timelineSupport: true });
        mine = new EventTimelineSet(room, { timelineSupport: true });
        Object.defineProperty(room, "threadsTimelineSets", { value: [all, mine] });
        vi.spyOn(room, "createThreadsTimelineSets").mockResolvedValue([all, mine]);
        vi.spyOn(room, "fetchRoomThreads").mockResolvedValue();
        vi.spyOn(room, "getMyMembership").mockReturnValue("join");
        vi.spyOn(room.currentState, "maySendEvent").mockReturnValue(true);
        onOpen.mockClear();
        onCreate.mockClear();
    });
    afterEach(() => {
        vm?.dispose();
        Thread.hasServerSideSupport = FeatureSupport.None;
    });

    function addThread(user = client.getSafeUserId(), ts = 10) {
        return mkThread({ room, client, authorId: user, participantUserIds: [user], ts });
    }

    it("loads actual roots, filters title and preview, and opens the same root", async () => {
        const { rootEvent } = addThread();
        vm = createVm();
        await settle();
        expect(vm.getSnapshot()).toMatchObject({ loading: false, error: false, canCreate: true });
        expect(vm.getSnapshot().rows[0]).toMatchObject({ id: rootEvent.getId(), replies: expect.any(Number) });
        vm.setQuery("missing phrase");
        expect(vm.getSnapshot().rows).toEqual([]);
        vm.setQuery(rootEvent.getContent().body);
        expect(vm.getSnapshot().rows).toHaveLength(1);
        vm.openThread(rootEvent.getId()!);
        expect(onOpen).toHaveBeenCalledWith(rootEvent);
        vm.createThread();
        expect(onCreate).toHaveBeenCalledOnce();
    });

    it("shows only participated threads in My threads and sorts by latest activity", async () => {
        addThread(client.getSafeUserId(), 50);
        addThread("@other:example.org", 100);
        vm = createVm();
        await settle();
        expect(vm.getSnapshot().rows).toHaveLength(2);
        expect(vm.getSnapshot().rows[0].preview).toContain("other");
        vm.setFilter("mine");
        expect(vm.getSnapshot().rows).toHaveLength(1);
        expect(vm.getSnapshot().rows[0].preview).not.toContain("other");
    });

    it("paginates the selected SDK timeline and keeps newly loaded pages searchable", async () => {
        all.getLiveTimeline().setPaginationToken("older", EventTimeline.BACKWARDS);
        vm = createVm();
        await settle();
        expect(vm.getSnapshot().hasMore).toBe(true);
        vi.mocked(client.paginateEventTimeline).mockImplementation(async () => {
            addThread();
            all.getLiveTimeline().setPaginationToken(null, EventTimeline.BACKWARDS);
            return false;
        });
        await vm.loadMore();
        expect(client.paginateEventTimeline).toHaveBeenCalledWith(all.getLiveTimeline(), {
            backwards: true,
            limit: 30,
        });
        expect(vm.getSnapshot().hasMore).toBe(false);
        expect(vm.getSnapshot().rows).toHaveLength(1);
    });

    it("reports initial load errors and retries without unhandled rejections", async () => {
        vi.mocked(room.fetchRoomThreads).mockRejectedValueOnce(new Error("offline"));
        vm = createVm();
        await settle();
        expect(vm.getSnapshot()).toMatchObject({ loading: false, error: true });
        await vm.retry();
        expect(vm.getSnapshot()).toMatchObject({ loading: false, error: false });
    });

    it("retries pagination failures while retaining the current rows", async () => {
        addThread();
        vm = createVm();
        await settle();
        vi.mocked(client.paginateEventTimeline).mockRejectedValueOnce(new Error("offline"));
        await vm.loadMore();
        expect(vm.getSnapshot()).toMatchObject({ error: true, loading: false });
        expect(vm.getSnapshot().rows).toHaveLength(1);
        await vm.retry();
        expect(vm.getSnapshot().error).toBe(false);
    });

    it("updates edited, decrypted and redacted root labels and removes listeners on disposal", async () => {
        const { rootEvent } = addThread();
        vm = createVm();
        await settle();
        rootEvent.getContent().body = "Changed root";
        rootEvent.emit(MatrixEventEvent.Replaced, rootEvent);
        await settle();
        expect(vm.getSnapshot().rows[0].title).toContain("Changed root");
        rootEvent.getContent().body = "Decrypted root";
        rootEvent.emit(MatrixEventEvent.Decrypted, rootEvent);
        await settle();
        expect(vm.getSnapshot().rows[0].title).toContain("Decrypted root");
        const redaction = mkMessage({ room: room.roomId, user: client.getSafeUserId(), event: true });
        rootEvent.markLocallyRedacted(redaction);
        await settle();
        expect(vm.getSnapshot().rows[0].title).not.toContain("Decrypted root");
        vm.dispose();
        expect(rootEvent.listenerCount(MatrixEventEvent.Replaced)).toBe(0);
    });

    it("does not publish stale results or attach listeners after disposal or room changes", async () => {
        let finish!: () => void;
        vi.mocked(room.fetchRoomThreads).mockReturnValue(
            new Promise<void>((resolve) => {
                finish = resolve;
            }),
        );
        const receiptListeners = room.listenerCount(RoomEvent.Receipt);
        vm = createVm();
        await settle();
        const listener = vi.fn();
        vm.subscribe(listener);
        vm.dispose();
        finish();
        await settle();
        expect(listener).not.toHaveBeenCalled();
        expect(room.listenerCount(RoomEvent.Receipt)).toBe(receiptListeners);
        expect(all.listenerCount(RoomEvent.Timeline)).toBe(0);
    });

    it("ignores a pagination failure from the previously selected filter", async () => {
        vm = createVm();
        await settle();
        let fail!: (reason: Error) => void;
        vi.mocked(client.paginateEventTimeline).mockReturnValueOnce(
            new Promise((_, reject) => {
                fail = reject;
            }),
        );
        const loading = vm.loadMore();
        vm.setFilter("mine");
        fail(new Error("old filter failed"));
        await loading;
        expect(vm.getSnapshot()).toMatchObject({ filter: "mine", error: false, loading: false });
    });

    it("does not offer creation without room send permissions", async () => {
        vi.mocked(room.currentState.maySendEvent).mockReturnValue(false);
        vm = createVm();
        await settle();
        vm.createThread();
        expect(vm.getSnapshot().canCreate).toBe(false);
        expect(onCreate).not.toHaveBeenCalled();
    });
});
