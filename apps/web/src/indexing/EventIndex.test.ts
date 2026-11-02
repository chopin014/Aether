/*
Copyright 2025 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

// @vitest-environment happy-dom

import { vi, describe, it, expect, afterEach, type Mocked } from "vitest";
import {
    Direction,
    type MatrixClient,
    type IEvent,
    MatrixEvent,
    type Room,
    ClientEvent,
    RoomEvent,
    RoomStateEvent,
    SyncState,
} from "matrix-js-sdk/src/matrix";
import { emitPromise, getMockClientWithEventEmitter, mockClientMethodsRooms, mockPlatformPeg } from "test-utils";

import EventIndex from "./EventIndex.ts";
import type BaseEventIndexManager from "./BaseEventIndexManager.ts";
import { type ICrawlerCheckpoint } from "./BaseEventIndexManager.ts";
import SettingsStore from "../settings/SettingsStore.ts";

afterEach(() => {
    vi.restoreAllMocks();
});

describe("EventIndex", () => {
    it("crawls through the loaded checkpoints", async () => {
        const mockIndexingManager = {
            loadCheckpoints: vi.fn(),
            removeCrawlerCheckpoint: vi.fn(),
            isEventIndexEmpty: vi.fn().mockResolvedValue(false),
        } as any as Mocked<BaseEventIndexManager>;
        mockPlatformPeg({ getEventIndexingManager: () => mockIndexingManager });

        const room1 = { roomId: "!room1:id" } as any as Room;
        const room2 = { roomId: "!room2:id" } as any as Room;
        const mockClient = getMockClientWithEventEmitter({
            getEventMapper: () => (obj: Partial<IEvent>) => new MatrixEvent(obj),
            createMessagesRequest: vi.fn(),
            ...mockClientMethodsRooms([room1, room2]),
        });

        vi.spyOn(SettingsStore, "getValueAt").mockImplementation((_level, settingName): any => {
            if (settingName === "crawlerSleepTime") return 0;
            return undefined;
        });

        mockIndexingManager.loadCheckpoints.mockResolvedValue([
            { roomId: "!room1:id", token: "token1", direction: Direction.Backward } as ICrawlerCheckpoint,
            { roomId: "!room2:id", token: "token2", direction: Direction.Forward } as ICrawlerCheckpoint,
        ]);

        const indexer = new EventIndex();
        await indexer.init();
        let changedCheckpointPromise = emitPromise(indexer, "changedCheckpoint") as Promise<Room>;

        indexer.startCrawler();

        // Mock out the /messags request, and wait for the crawler to hit the first room
        const mock1 = mockCreateMessagesRequest(mockClient);
        let changedCheckpoint = await changedCheckpointPromise;
        expect(changedCheckpoint.roomId).toEqual("!room1:id");

        await mock1.called;
        expect(mockClient.createMessagesRequest).toHaveBeenCalledWith("!room1:id", "token1", 100, "b");

        // Continue, and wait for the crawler to hit the second room
        changedCheckpointPromise = emitPromise(indexer, "changedCheckpoint") as Promise<Room>;
        mock1.resolve({ chunk: [] });
        changedCheckpoint = await changedCheckpointPromise;
        expect(changedCheckpoint.roomId).toEqual("!room2:id");

        // Mock out the /messages request again, and wait for it to be called
        const mock2 = mockCreateMessagesRequest(mockClient);
        await mock2.called;
        expect(mockClient.createMessagesRequest).toHaveBeenCalledWith("!room2:id", "token2", 100, "f");
    });

    it("stops the crawler writing once the index has closed, even mid-page", async () => {
        let releaseDelete!: () => void;
        const mockIndexingManager = {
            loadCheckpoints: vi
                .fn()
                .mockResolvedValue([
                    { roomId: "!room1:id", token: "token1", direction: Direction.Backward } as ICrawlerCheckpoint,
                ]),
            removeCrawlerCheckpoint: vi.fn(),
            isEventIndexEmpty: vi.fn().mockResolvedValue(false),
            deleteEvent: vi.fn(() => new Promise<void>((resolve) => (releaseDelete = resolve))),
            addHistoricEvents: vi.fn().mockResolvedValue(false),
            closeEventIndex: vi.fn().mockResolvedValue(undefined),
        } as any as Mocked<BaseEventIndexManager>;
        mockPlatformPeg({ getEventIndexingManager: () => mockIndexingManager });
        const room1 = { roomId: "!room1:id" } as any as Room;
        const mockClient = getMockClientWithEventEmitter({
            getEventMapper: () => (obj: Partial<IEvent>) => new MatrixEvent(obj),
            createMessagesRequest: vi.fn(),
            ...mockClientMethodsRooms([room1]),
        });
        vi.spyOn(SettingsStore, "getValueAt").mockImplementation((_level, settingName): any =>
            settingName === "crawlerSleepTime" ? 0 : undefined,
        );

        const indexer = new EventIndex();
        await indexer.init();
        indexer.startCrawler();
        const page = mockCreateMessagesRequest(mockClient);
        await page.called;
        page.resolve({
            chunk: [
                { type: "m.room.redaction", redacts: "$old", room_id: "!room1:id", event_id: "$r", sender: "@a:id" },
                {
                    type: "m.room.message",
                    room_id: "!room1:id",
                    event_id: "$m",
                    sender: "@a:id",
                    content: { msgtype: "m.text", body: "private history" },
                },
            ],
            end: "token2",
        });
        await vi.waitFor(() => expect(mockIndexingManager.deleteEvent).toHaveBeenCalled());

        await indexer.close();
        releaseDelete();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(mockIndexingManager.addHistoricEvents).not.toHaveBeenCalled();
    });

    it("adds checkpoints for the encrypted rooms after the first sync", async () => {
        const mockIndexingManager = {
            loadCheckpoints: vi.fn().mockResolvedValue([]),
            isEventIndexEmpty: vi.fn().mockResolvedValue(true),
            addCrawlerCheckpoint: vi.fn(),
            removeCrawlerCheckpoint: vi.fn(),
            commitLiveEvents: vi.fn(),
        } as any as Mocked<BaseEventIndexManager>;
        mockPlatformPeg({ getEventIndexingManager: () => mockIndexingManager });

        const room1 = {
            roomId: "!room1:id",
            getLiveTimeline: () => ({
                getPaginationToken: () => "token1",
            }),
        } as any as Room;
        const room2 = {
            roomId: "!room2:id",
            getLiveTimeline: () => ({
                getPaginationToken: () => "token2",
            }),
        } as any as Room;
        const mockCrypto = {
            isEncryptionEnabledInRoom: vi.fn().mockResolvedValue(true),
        };
        const mockClient = getMockClientWithEventEmitter({
            getEventMapper: () => (obj: Partial<IEvent>) => new MatrixEvent(obj),
            createMessagesRequest: vi.fn(),
            getCrypto: () => mockCrypto as any,
            ...mockClientMethodsRooms([room1, room2]),
        });

        const commitLiveEventsCalled = Promise.withResolvers<void>();
        mockIndexingManager.commitLiveEvents.mockImplementation(async () => {
            commitLiveEventsCalled.resolve();
        });

        const indexer = new EventIndex();
        await indexer.init();

        // During the first sync, some events are added to the index, meaning that `isEventIndexEmpty` will now be false.
        mockIndexingManager.isEventIndexEmpty.mockResolvedValue(false);

        // The first sync completes:
        mockClient.emit(ClientEvent.Sync, SyncState.Syncing, null, {});

        // Wait for `commitLiveEvents` to be called, by which time the checkpoints should have been added.
        await commitLiveEventsCalled.promise;
        expect(mockIndexingManager.addCrawlerCheckpoint).toHaveBeenCalledTimes(4);
        expect(mockIndexingManager.addCrawlerCheckpoint).toHaveBeenCalledWith({
            roomId: "!room1:id",
            token: "token1",
            direction: Direction.Backward,
            fullCrawl: true,
        });
        expect(mockIndexingManager.addCrawlerCheckpoint).toHaveBeenCalledWith({
            roomId: "!room1:id",
            token: "token1",
            direction: Direction.Forward,
        });
        expect(mockIndexingManager.addCrawlerCheckpoint).toHaveBeenCalledWith({
            roomId: "!room2:id",
            token: "token2",
            direction: Direction.Backward,
            fullCrawl: true,
        });
        expect(mockIndexingManager.addCrawlerCheckpoint).toHaveBeenCalledWith({
            roomId: "!room2:id",
            token: "token2",
            direction: Direction.Forward,
        });
    });
});

describe("EventIndex opened after startup", () => {
    function setUp() {
        const mockIndexingManager = {
            loadCheckpoints: vi.fn().mockResolvedValue([]),
            isEventIndexEmpty: vi.fn().mockResolvedValue(false),
            addEventToIndex: vi.fn().mockResolvedValue(undefined),
            commitLiveEvents: vi.fn().mockResolvedValue(undefined),
            addCrawlerCheckpoint: vi.fn(),
            removeCrawlerCheckpoint: vi.fn(),
        } as any as Mocked<BaseEventIndexManager>;
        mockPlatformPeg({ getEventIndexingManager: () => mockIndexingManager });
        const room = { roomId: "!room:id" } as any as Room;
        const client = getMockClientWithEventEmitter({
            ...mockClientMethodsRooms([room]),
            isRoomEncrypted: () => true,
            decryptEventIfNeeded: vi.fn().mockResolvedValue(undefined),
        });
        const event = new MatrixEvent({
            type: "m.room.message",
            room_id: "!room:id",
            event_id: "$live",
            sender: "@alice:id",
            content: { msgtype: "m.text", body: "hello" },
        });
        const deliverLiveEvent = (): void => {
            client.emit(RoomEvent.Timeline, event, room, false, false, { liveEvent: true } as any);
        };
        return { mockIndexingManager, client, deliverLiveEvent };
    }

    it("indexes live events that arrived while it was still closed, once it opens", async () => {
        const { mockIndexingManager, deliverLiveEvent } = setUp();
        const indexer = new EventIndex();
        indexer.listenBeforeOpening();

        deliverLiveEvent();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(mockIndexingManager.addEventToIndex).not.toHaveBeenCalled();

        await indexer.init();
        await vi.waitFor(() =>
            expect(mockIndexingManager.addEventToIndex).toHaveBeenCalledWith(
                expect.objectContaining({ event_id: "$live" }),
                expect.anything(),
            ),
        );
        indexer.stopCrawler();
    });

    it("catches up on syncs once, rather than once per sync that happened while closed", async () => {
        const { mockIndexingManager, client } = setUp();
        const indexer = new EventIndex();
        indexer.listenBeforeOpening();

        client.emit(ClientEvent.Sync, SyncState.Syncing, null, {});
        client.emit(ClientEvent.Sync, SyncState.Syncing, SyncState.Syncing, {});
        client.emit(ClientEvent.Sync, SyncState.Syncing, SyncState.Syncing, {});

        await indexer.init();
        await vi.waitFor(() => expect(mockIndexingManager.commitLiveEvents).toHaveBeenCalled());
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(mockIndexingManager.commitLiveEvents).toHaveBeenCalledTimes(1);
        indexer.stopCrawler();
    });

    it("checks held rooms one at a time, so opening does not flood the index's database", async () => {
        const { mockIndexingManager, client } = setUp();
        let running = 0;
        let mostAtOnce = 0;
        (mockIndexingManager as any).isRoomIndexed = vi.fn(async () => {
            running++;
            mostAtOnce = Math.max(mostAtOnce, running);
            await new Promise((resolve) => setTimeout(resolve, 1));
            running--;
            return true;
        });
        const indexer = new EventIndex();
        indexer.listenBeforeOpening();
        const encryption = (roomId: string): MatrixEvent =>
            new MatrixEvent({ type: "m.room.encryption", state_key: "", room_id: roomId, content: {} });
        for (let i = 0; i < 20; i++) {
            client.emit(RoomStateEvent.Events, encryption(`!r${i}:id`), { roomId: `!r${i}:id` } as any, null);
        }

        await indexer.init();
        await vi.waitFor(() => expect((mockIndexingManager as any).isRoomIndexed).toHaveBeenCalledTimes(20));
        expect(mostAtOnce).toBe(1);
        indexer.stopCrawler();
    });

    it("keeps the gap of every timeline reset that happened while it was opening", async () => {
        const { mockIndexingManager, client } = setUp();
        let token = "old";
        const room = {
            roomId: "!room:id",
            getLiveTimeline: () => {
                const atReset = token;
                return { getPaginationToken: () => atReset };
            },
        } as any as Room;
        vi.mocked(client.getRoom).mockReturnValue(room);
        const indexer = new EventIndex();
        indexer.listenBeforeOpening();

        client.emit(RoomEvent.TimelineReset, room, {} as any, true);
        token = "new";
        client.emit(RoomEvent.TimelineReset, room, {} as any, true);

        await indexer.init();
        await vi.waitFor(() => expect(mockIndexingManager.addCrawlerCheckpoint).toHaveBeenCalledTimes(2));
        expect(vi.mocked(mockIndexingManager.addCrawlerCheckpoint).mock.calls.map(([c]) => c.token)).toEqual([
            "old",
            "new",
        ]);
        indexer.stopCrawler();
    });

    it("stops held work when closed, and keeps newer events behind held ones", async () => {
        const { mockIndexingManager, deliverLiveEvent } = setUp();
        const order: string[] = [];
        let releaseFirst!: () => void;
        mockIndexingManager.addEventToIndex.mockImplementationOnce(async (e: any) => {
            order.push("held");
            await new Promise<void>((resolve) => (releaseFirst = resolve));
        });
        mockIndexingManager.addEventToIndex.mockImplementation(async () => void order.push("later"));
        (mockIndexingManager as any).closeEventIndex = vi.fn();
        const indexer = new EventIndex();
        indexer.listenBeforeOpening();
        deliverLiveEvent();
        deliverLiveEvent();

        await indexer.init();
        await vi.waitFor(() => expect(order).toEqual(["held"]));
        deliverLiveEvent();
        const closing = indexer.close();
        releaseFirst();
        await closing;
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(order).toEqual(["held"]);
        expect((mockIndexingManager as any).closeEventIndex).toHaveBeenCalled();
    });

    it("does not write an event whose decryption finishes after the index closed", async () => {
        const { mockIndexingManager, client, deliverLiveEvent } = setUp();
        (mockIndexingManager as any).closeEventIndex = vi.fn();
        let decrypted!: () => void;
        vi.mocked(client.decryptEventIfNeeded).mockReturnValue(new Promise<void>((resolve) => (decrypted = resolve)));
        const indexer = new EventIndex();
        await indexer.init();
        deliverLiveEvent();
        await vi.waitFor(() => expect(client.decryptEventIfNeeded).toHaveBeenCalled());

        const closing = indexer.close();
        decrypted();
        await closing;
        expect(mockIndexingManager.addEventToIndex).not.toHaveBeenCalled();
        expect((mockIndexingManager as any).closeEventIndex).toHaveBeenCalled();
    });

    it("drops what it was holding when it will not open", async () => {
        const { mockIndexingManager, client, deliverLiveEvent } = setUp();
        const indexer = new EventIndex();
        indexer.listenBeforeOpening();
        deliverLiveEvent();

        indexer.abandon();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(mockIndexingManager.addEventToIndex).not.toHaveBeenCalled();
        expect(client.listenerCount(RoomEvent.Timeline)).toBe(0);
    });
});

/**
 * Mock out the `createMessagesRequest` method on the client, with an implementation that will block until a resolver is called.
 *
 * @returns An object with the following properties:
 *  * `called`: A promise that resolves when `createMessagesRequest` is called.
 *  * `resolve`: A function that can be called to allow `createMessagesRequest` to complete.
 */
function mockCreateMessagesRequest(mockClient: Mocked<MatrixClient>): {
    called: Promise<void>;
    resolve: (result: any) => void;
} {
    const messagesCalledPromise = Promise.withResolvers<void>();
    const messagesResultPromise = Promise.withResolvers();
    mockClient.createMessagesRequest.mockImplementationOnce(() => {
        messagesCalledPromise.resolve();
        return messagesResultPromise.promise as any;
    });
    return {
        called: messagesCalledPromise.promise,
        resolve: messagesResultPromise.resolve,
    };
}
