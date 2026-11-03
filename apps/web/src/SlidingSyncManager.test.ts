/*
Copyright 2024 New Vector Ltd.
Copyright 2022 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach } from "vitest";
import { type SlidingSync, SlidingSyncEvent, SlidingSyncState } from "matrix-js-sdk/src/sliding-sync";
import { ClientEvent, type MatrixClient, MatrixEvent, Room } from "matrix-js-sdk/src/matrix";
import fetchMock from "@fetch-mock/vitest";
import EventEmitter from "node:events";
import { waitFor } from "test-utils-rtl";
import { mkStubRoom, stubClient } from "test-utils";

import { SlidingSyncManager } from "./SlidingSyncManager";

class MockSlidingSync extends EventEmitter {
    lists = {};
    listModifiedCount = 0;
    terminated = false;
    needsResend = false;
    modifyRoomSubscriptions = vi.fn();
    getRoomSubscriptions = vi.fn();
    useCustomSubscription = vi.fn();
    getListParams = vi.fn();
    setList = vi.fn();
    setListRanges = vi.fn();
    getListData = vi.fn();
    extensions = vi.fn();
    desiredRoomSubscriptions = vi.fn();
}

describe("SlidingSyncManager", () => {
    let manager: SlidingSyncManager;
    let slidingSync: SlidingSync;
    let client: MatrixClient;

    beforeEach(() => {
        slidingSync = new MockSlidingSync() as unknown as SlidingSync;
        manager = new SlidingSyncManager();
        client = stubClient();
        // by default the client has no rooms: stubClient magically makes rooms annoyingly.
        vi.mocked(client.getRoom).mockReturnValue(null);
        (manager as any).configure(client, "invalid");
        manager.slidingSync = slidingSync;
        fetchMock.get("https://proxy/client/server.json", {});
    });

    it("starts with small lists then restores recent messages after the first response", async () => {
        const sync = await manager.setup(client);
        for (const name of ["spaces", "invites", "favourites", "dms", "untagged"]) {
            expect(sync?.getListParams(name)?.ranges).toEqual([[0, 0]]);
        }
        expect(sync?.getListParams("untagged")?.timeline_limit).toBe(1);
        sync!.emit(SlidingSyncEvent.Lifecycle, SlidingSyncState.Complete, null);
        await vi.waitFor(() => expect(sync?.getListParams("untagged")?.timeline_limit).toBe(20));
        for (const name of ["favourites", "dms", "untagged"]) {
            expect(sync?.getListParams(name)).toEqual(
                expect.objectContaining({
                    timeline_limit: 20,
                    required_state: expect.arrayContaining([["m.room.member", "$LAZY"]]),
                }),
            );
        }
        expect(sync?.getListParams("spaces")?.timeline_limit).toBe(0);
    });

    it.each([false, true])(
        "prioritises an unknown destination then restores its subscription (encrypted=%s)",
        async (encrypted) => {
            const roomId = "!destination:example.org";
            const sync = (await manager.setup(client, roomId))!;
            const internals = sync as unknown as {
                roomIdToCustomSubscription: Map<string, string>;
                customSubscriptions: Map<string, { timeline_limit: number; required_state: string[][] }>;
            };
            const subscription = (): { timeline_limit: number; required_state: string[][] } =>
                internals.customSubscriptions.get(internals.roomIdToCustomSubscription.get(roomId)!)!;
            expect(sync.getRoomSubscriptions()).toEqual(new Set([roomId]));
            for (const name of ["spaces", "invites", "favourites", "dms", "untagged"]) {
                expect(sync.getListParams(name)).toBeNull();
            }
            expect(subscription()).toMatchObject({
                timeline_limit: 50,
                required_state: expect.arrayContaining([
                    ["m.room.encryption", ""],
                    ["m.room.member", "$ME"],
                    ["m.room.member", "$LAZY"],
                    ["m.space.child", "*"],
                    ["m.space.parent", "*"],
                ]),
            });
            expect(subscription().required_state).not.toContainEqual(["*", "*"]);
            // RoomView may request visibility before discovery. It must not replace bootstrap state with all members.
            await manager.setRoomVisible(roomId);
            expect(subscription().timeline_limit).toBe(50);
            const room = new Room(roomId, client, client.getUserId()!);
            room.getLiveTimeline().initialiseState([
                new MatrixEvent({
                    type: "m.room.create",
                    state_key: "",
                    content: {},
                    event_id: "$create",
                    room_id: roomId,
                    sender: client.getUserId()!,
                }),
                ...(encrypted
                    ? [
                          new MatrixEvent({
                              type: "m.room.encryption",
                              state_key: "",
                              event_id: "$encryption",
                              room_id: roomId,
                              sender: client.getUserId()!,
                              content: { algorithm: "m.megolm.v1.aes-sha2" },
                          }),
                      ]
                    : []),
            ]);
            vi.mocked(client.getRoom).mockReturnValue(room);
            sync.emit(SlidingSyncEvent.Lifecycle, SlidingSyncState.Complete, null);
            await vi.waitFor(() =>
                expect(internals.roomIdToCustomSubscription.get(roomId)).toBe(encrypted ? "encrypted" : "unencrypted"),
            );
            expect(subscription().required_state.some(([type, key]) => type === "*" && key === "*")).toBe(encrypted);
            expect(sync.getListParams("spaces")?.required_state).toContainEqual(["m.space.child", "*"]);
            expect(sync.getListParams("untagged")?.ranges).toEqual([[0, 10]]);
        },
    );

    it("keeps an undiscovered destination small until a later response supplies its encryption state", async () => {
        const roomId = "!delayed:example.org";
        const sync = (await manager.setup(client, roomId))!;
        const selectSubscription = vi.spyOn(sync, "useCustomSubscription");
        sync.emit(SlidingSyncEvent.Lifecycle, SlidingSyncState.Complete, null);
        await vi.waitFor(() => expect(sync.getListParams("untagged")?.timeline_limit).toBe(20));
        expect(selectSubscription).not.toHaveBeenCalled();
        await manager.setRoomVisible(roomId);
        expect(selectSubscription).not.toHaveBeenCalled();

        const room = new Room(roomId, client, client.getUserId()!);
        vi.mocked(client.getRoom).mockReturnValue(room);
        sync.emit(SlidingSyncEvent.Lifecycle, SlidingSyncState.Complete, null);
        await vi.waitFor(() => expect(selectSubscription).toHaveBeenCalledWith(roomId, "unencrypted"));
    });

    it.each([false, true])(
        "discovers unknown rooms after background lists finish (encrypted=%s)",
        async (encrypted) => {
            const sync = (await manager.setup(client))!;
            sync.emit(SlidingSyncEvent.Lifecycle, SlidingSyncState.Complete, null);
            await vi.waitFor(() => expect(sync.getListParams("untagged")?.timeline_limit).toBe(20));
            sync.emit(SlidingSyncEvent.Lifecycle, SlidingSyncState.Complete, null);
            await new Promise((resolve) => setTimeout(resolve, 60));
            expect(sync.listenerCount(SlidingSyncEvent.Lifecycle)).toBe(0);
            const roomId = "!new:example.org";
            const selectSubscription = vi.spyOn(sync, "useCustomSubscription");
            const visible = manager.setRoomVisible(roomId);
            await vi.waitFor(() => expect(selectSubscription).toHaveBeenCalledWith(roomId, "bootstrap"));
            const room = new Room(roomId, client, client.getUserId()!);
            vi.spyOn(room, "hasEncryptionStateEvent").mockReturnValue(encrypted);
            vi.mocked(client.getRoom).mockReturnValue(room);
            client.emit(ClientEvent.Room, room);
            await visible;
            expect(selectSubscription).toHaveBeenLastCalledWith(roomId, encrypted ? "encrypted" : "unencrypted");
        },
    );

    it("settles obsolete discovery requests without changing a replacement client", async () => {
        const sync = (await manager.setup(client))!;
        const roomId = "!old:example.org";
        const visible = manager.setRoomVisible(roomId);
        await vi.waitFor(() => expect(sync.getRoomSubscriptions()).toContain(roomId));
        const oldClient = client;
        const nextClient = stubClient();
        const current = (await manager.setup(nextClient))!;
        const selectSubscription = vi.spyOn(current, "useCustomSubscription");
        await visible;
        oldClient.emit(ClientEvent.Room, new Room(roomId, oldClient, oldClient.getUserId()!));
        expect(selectSubscription).not.toHaveBeenCalled();
    });

    it("retains bootstrap after a failed response and restores lists after retry", async () => {
        const sync = (await manager.setup(client))!;
        sync.emit(SlidingSyncEvent.Lifecycle, SlidingSyncState.RequestFinished, null, new Error("offline"));
        sync.emit(SlidingSyncEvent.Lifecycle, SlidingSyncState.Complete, null, new Error("offline"));
        await new Promise((resolve) => setTimeout(resolve, 60));
        expect(sync.getListParams("untagged")?.timeline_limit).toBe(1);
        sync.emit(SlidingSyncEvent.Lifecycle, SlidingSyncState.Complete, null);
        await vi.waitFor(() => expect(sync.getListParams("untagged")?.timeline_limit).toBe(20));
    });

    it("does not restore an obsolete sync after setup is replaced", async () => {
        const previous = (await manager.setup(client))!;
        previous.emit(SlidingSyncEvent.Lifecycle, SlidingSyncState.Complete, null);
        const current = (await manager.setup(client))!;
        await new Promise((resolve) => setTimeout(resolve, 60));
        expect(current.getListParams("untagged")?.timeline_limit).toBe(1);
        expect(previous.getListParams("untagged")?.timeline_limit).toBe(1);
    });

    describe("setRoomVisible", () => {
        it("adds a subscription for the room", async () => {
            const roomId = "!room:id";
            vi.mocked(client.getRoom).mockReturnValue(mkStubRoom(roomId, "foo", client));
            const subs = new Set<string>();
            vi.mocked(slidingSync.getRoomSubscriptions).mockReturnValue(subs);
            await manager.setRoomVisible(roomId);
            expect(slidingSync.modifyRoomSubscriptions).toHaveBeenCalledWith(new Set<string>([roomId]));
        });

        it("adds a custom subscription for a lazy-loadable room", async () => {
            const roomId = "!lazy:id";
            const room = new Room(roomId, client, client.getUserId()!);
            room.getLiveTimeline().initialiseState([
                new MatrixEvent({
                    type: "m.room.create",
                    state_key: "",
                    event_id: "$abc123",
                    sender: client.getUserId()!,
                    content: {
                        creator: client.getUserId()!,
                    },
                }),
            ]);
            vi.mocked(client.getRoom).mockImplementation((r?: string): Room | null => {
                if (roomId === r) {
                    return room;
                }
                return null;
            });
            const subs = new Set<string>();
            vi.mocked(slidingSync.getRoomSubscriptions).mockReturnValue(subs);
            await manager.setRoomVisible(roomId);
            expect(slidingSync.modifyRoomSubscriptions).toHaveBeenCalledWith(new Set<string>([roomId]));
            // we aren't prescriptive about what the sub name is.
            expect(slidingSync.useCustomSubscription).toHaveBeenCalledWith(roomId, expect.anything());
        });

        it("waits if the room is not yet known", async () => {
            const roomId = "!room:id";
            vi.mocked(client.getRoom).mockReturnValue(null);
            const subs = new Set<string>();
            vi.mocked(slidingSync.getRoomSubscriptions).mockReturnValue(subs);

            const setVisibleDone = vi.fn();
            const setVisibleProm = manager.setRoomVisible(roomId).then(setVisibleDone);

            await waitFor(() => expect(client.getRoom).toHaveBeenCalledWith(roomId));

            expect(setVisibleDone).not.toHaveBeenCalled();

            const stubRoom = mkStubRoom(roomId, "foo", client);
            vi.mocked(client.getRoom).mockReturnValue(stubRoom);
            client.emit(ClientEvent.Room, stubRoom);

            await waitFor(() => expect(setVisibleDone).toHaveBeenCalled());
            await setVisibleProm;
        });
    });

    describe("ensureListRegistered", () => {
        it("creates a new list based on the key", async () => {
            const listKey = "key";
            vi.mocked(slidingSync.getListParams).mockReturnValue(null);
            await manager.ensureListRegistered(listKey, {
                sort: ["by_recency"],
            });
            expect(slidingSync.setList).toHaveBeenCalledWith(
                listKey,
                expect.objectContaining({
                    sort: ["by_recency"],
                    timeline_limit: 20,
                    required_state: expect.arrayContaining([["m.room.member", "$LAZY"]]),
                }),
            );
        });

        it("updates an existing list based on the key", async () => {
            const listKey = "key";
            vi.mocked(slidingSync.getListParams).mockReturnValue({
                ranges: [[0, 42]],
            });
            await manager.ensureListRegistered(listKey, {
                sort: ["by_recency"],
            });
            expect(slidingSync.setList).toHaveBeenCalledWith(
                listKey,
                expect.objectContaining({
                    sort: ["by_recency"],
                    ranges: [[0, 42]],
                }),
            );
        });

        it("updates ranges on an existing list based on the key if there's no other changes", async () => {
            const listKey = "key";
            vi.mocked(slidingSync.getListParams).mockReturnValue({
                ranges: [[0, 42]],
            });
            await manager.ensureListRegistered(listKey, {
                ranges: [[0, 52]],
            });
            expect(slidingSync.setList).not.toHaveBeenCalled();
            expect(slidingSync.setListRanges).toHaveBeenCalledWith(listKey, [[0, 52]]);
        });

        it("no-ops for idential changes", async () => {
            const listKey = "key";
            vi.mocked(slidingSync.getListParams).mockReturnValue({
                ranges: [[0, 42]],
                sort: ["by_recency"],
            });
            await manager.ensureListRegistered(listKey, {
                ranges: [[0, 42]],
                sort: ["by_recency"],
            });
            expect(slidingSync.setList).not.toHaveBeenCalled();
            expect(slidingSync.setListRanges).not.toHaveBeenCalled();
        });
    });

    describe("startSpidering", () => {
        it("requests in expanding batchSizes", async () => {
            const gapMs = 1;
            const batchSize = 10;
            vi.mocked(slidingSync.getListData).mockImplementation((key) => {
                return {
                    joinedCount: 64,
                    roomIndexToRoomId: {},
                };
            });
            await (manager as any).startSpidering(slidingSync, batchSize, gapMs);

            // we expect calls for 10,19 -> 20,29 -> 30,39 -> 40,49 -> 50,59 -> 60,69
            const wantWindows = [
                [0, 10],
                [0, 20],
                [0, 30],
                [0, 40],
                [0, 50],
                [0, 60],
                [0, 63],
            ];

            for (let i = 1; i < wantWindows.length; ++i) {
                // each time we emit, it should expand the range of all 5 lists by 10 until
                // they all include all the rooms (64), which is 6 emits.
                slidingSync.emit(SlidingSyncEvent.Lifecycle, SlidingSyncState.Complete, null, undefined);
                await waitFor(() => expect(slidingSync.getListData).toHaveBeenCalledTimes(i * 5));
                expect(slidingSync.setListRanges).toHaveBeenCalledTimes(i * 5);
                expect(slidingSync.setListRanges).toHaveBeenCalledWith("spaces", [wantWindows[i]]);
            }
        });
        it.each([0, 11])("does not expand a complete range with %s rooms", async (count) => {
            const gapMs = 1;
            const batchSize = 10;
            vi.mocked(slidingSync.getListData).mockImplementation((key) => {
                return {
                    joinedCount: count,
                    roomIndexToRoomId: {},
                };
            });
            await (manager as any).startSpidering(slidingSync, batchSize, gapMs);
            slidingSync.emit(SlidingSyncEvent.Lifecycle, SlidingSyncState.Complete, null, undefined);
            await waitFor(() => expect(slidingSync.getListData).toHaveBeenCalledTimes(5));
            // should not have needed to expand the range
            expect(slidingSync.setListRanges).not.toHaveBeenCalled();
        });
    });
    describe("checkSupport", () => {
        beforeEach(() => {
            SlidingSyncManager.serverSupportsSlidingSync = false;
        });
        it("shorts out if the server has 'native' sliding sync support", async () => {
            vi.spyOn(manager, "nativeSlidingSyncSupport").mockResolvedValue(true);
            expect(SlidingSyncManager.serverSupportsSlidingSync).toBeFalsy();
            await manager.checkSupport(client);
            expect(SlidingSyncManager.serverSupportsSlidingSync).toBeTruthy();
        });
    });
    describe("setup", () => {
        let untypedManager: any;

        beforeEach(() => {
            untypedManager = manager;
            vi.spyOn(untypedManager, "configure");
            vi.spyOn(untypedManager, "startSpidering");
        });
        it("uses the baseUrl", async () => {
            await manager.setup(client);
            expect(untypedManager.configure).toHaveBeenCalled();
            expect(untypedManager.configure).toHaveBeenCalledWith(client, client.baseUrl, undefined);
            expect(untypedManager.startSpidering).toHaveBeenCalled();
        });
    });
});
