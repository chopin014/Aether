/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
    ClientEvent,
    EventType,
    Room,
    SyncState,
    type ClientEventHandlerMap,
    type IPushRules,
    type ISyncResponse,
} from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";
// Test the actual patched sync implementation rather than an application mock.
// oxlint-disable-next-line no-restricted-imports
import { SyncApi, type SyncApiOptions } from "matrix-js-sdk/src/sync";

import { createClientWithCreds } from "../utils/createMatrixClient";

const roomId = "!room:example.com";
const userId = "@user:example.com";
const readerId = "@reader:example.com";

function setup(
    initialPushRulesPromise: Promise<IPushRules | undefined>,
    savedSync?: ISyncResponse,
    cryptoCallbacks?: SyncApiOptions["cryptoCallbacks"],
) {
    const client = createClientWithCreds({ homeserverUrl: "http://example.com", userId, accessToken: "token" });
    vi.spyOn(client.store, "getSavedSyncToken").mockResolvedValue(savedSync ? savedSync.next_batch : null);
    vi.spyOn(client.store, "getSavedSync").mockResolvedValue(
        savedSync ? { nextBatch: savedSync.next_batch, roomsData: savedSync.rooms!, accountData: [] } : null,
    );
    vi.spyOn(client, "storeClientOptions").mockResolvedValue(undefined);
    vi.spyOn(client, "getOrCreateFilter").mockResolvedValue("filter");
    const http = Promise.withResolvers<ISyncResponse>();
    const request = vi.spyOn(client.http, "authedRequest").mockImplementation(() => http.promise);
    const fetchRules = vi.spyOn(client, "getPushRules");
    const api = new SyncApi(client, { initialPushRulesPromise }, { logger, cryptoCallbacks });
    return { client, api, http, request, fetchRules };
}

describe("regular sync with pending push rules", () => {
    afterEach(() => vi.restoreAllMocks());

    it("processes cached sync while pending push rules have not answered", async () => {
        const fixture = setup(new Promise(() => {}), {
            next_batch: "cached-token",
            rooms: {
                join: {
                    [roomId]: {
                        state: {
                            events: [
                                {
                                    type: EventType.RoomMember,
                                    state_key: userId,
                                    sender: userId,
                                    event_id: "$membership",
                                    origin_server_ts: 1,
                                    content: { membership: "join" },
                                },
                                {
                                    type: EventType.RoomName,
                                    state_key: "",
                                    sender: userId,
                                    event_id: "$name",
                                    origin_server_ts: 2,
                                    content: { name: "Cached" },
                                },
                            ],
                        },
                        timeline: { events: [], prev_batch: null, limited: false },
                        ephemeral: { events: [] },
                        account_data: { events: [] },
                        unread_notifications: {},
                        summary: { "m.heroes": [] },
                    },
                },
                invite: {},
                leave: {},
                knock: {},
            },
            account_data: { events: [] },
        });
        void fixture.api.sync();
        await vi.waitFor(() => expect(fixture.client.getRoom(roomId)?.name).toBe("Cached"));
        expect(fixture.fetchRules).not.toHaveBeenCalled();
        fixture.api.stop();
    });

    it("uses pending push rules once they arrive instead of fetching them again", async () => {
        const rules = Promise.withResolvers<IPushRules | undefined>();
        const fixture = setup(rules.promise);
        const running = fixture.api.sync();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(fixture.request).not.toHaveBeenCalled();
        rules.resolve({ global: { override: [] } });
        await vi.waitFor(() => expect(fixture.request).toHaveBeenCalledOnce());
        expect(fixture.fetchRules).not.toHaveBeenCalled();
        expect(fixture.client.pushRules?.global.override).toEqual([]);
        fixture.api.stop();
        fixture.http.reject(new DOMException("Stopped", "AbortError"));
        await running;
    });

    it("fetches push rules itself when the prefetch failed", async () => {
        const fixture = setup(Promise.resolve(undefined));
        fixture.fetchRules.mockResolvedValue({ global: {} });
        const running = fixture.api.sync();
        await vi.waitFor(() => expect(fixture.request).toHaveBeenCalledOnce());
        expect(fixture.fetchRules).toHaveBeenCalledOnce();
        fixture.api.stop();
        fixture.http.reject(new DOMException("Stopped", "AbortError"));
        await running;
    });
});

function cachedRooms(count: number): ISyncResponse {
    return {
        next_batch: "cached-token",
        account_data: { events: [] },
        rooms: {
            join: Object.fromEntries(
                Array.from({ length: count }, (_, index) => {
                    const id = `!cached${index}:example.com`;
                    return [
                        id,
                        {
                            summary: { "m.heroes": [] },
                            unread_notifications: {},
                            state: {
                                events: [
                                    {
                                        type: EventType.RoomMember,
                                        state_key: userId,
                                        sender: userId,
                                        event_id: `$member${index}`,
                                        origin_server_ts: 1,
                                        content: { membership: "join" },
                                    },
                                ],
                            },
                            timeline: {
                                events: [
                                    {
                                        type: EventType.RoomMessage,
                                        sender: userId,
                                        event_id: `$message${index}`,
                                        origin_server_ts: 2,
                                        content: { msgtype: "m.text", body: "Cached text" },
                                    },
                                ],
                                prev_batch: null,
                                limited: false,
                            },
                            account_data: { events: [{ type: "m.tag", content: { tags: { "m.favourite": {} } } }] },
                            ephemeral: {
                                events: [
                                    {
                                        type: EventType.Receipt,
                                        content: {
                                            [`$message${index}`]: { "m.read": { [readerId]: { ts: 2 } } },
                                        },
                                    },
                                ],
                            },
                        },
                    ];
                }),
            ),
            invite: {},
            leave: {},
            knock: {},
        },
    };
}

function beforeFirstReplayTask(callback: () => void): void {
    // Observe the actual posted task before the SDK resumes, independent of timer ordering.
    const OriginalChannel = MessageChannel;
    let first = true;
    vi.stubGlobal(
        "MessageChannel",
        class extends OriginalChannel {
            public constructor() {
                super();
                if (first) {
                    first = false;
                    this.port1.addEventListener("message", callback, { once: true });
                }
            }
        },
    );
}

describe("cached sync replay batches", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it("offers a real task between batches while preserving live gating and room data", async () => {
        const saved = cachedRooms(17);
        const fixture = setup(Promise.resolve({ global: {} }), saved);
        const savedReady = Promise.withResolvers<Awaited<ReturnType<typeof fixture.client.store.getSavedSync>>>();
        const savedValue = await fixture.client.store.getSavedSync();
        vi.mocked(fixture.client.store.getSavedSync).mockReturnValue(savedReady.promise);
        const followingHttp = Promise.withResolvers<ISyncResponse>();
        fixture.request.mockReset().mockReturnValueOnce(fixture.http.promise).mockReturnValue(followingHttp.promise);
        const existingId = "!cached9:example.com";
        const existing = new Room(existingId, fixture.client, userId);
        fixture.client.store.storeRoom(existing);
        const order: string[] = [];
        const boundary = Promise.withResolvers<void>();
        const onSync: ClientEventHandlerMap[ClientEvent.Sync] = (state, _previous, data) => {
            if (state === SyncState.Prepared && data?.fromCache) order.push("prepared");
        };
        const onEvent: ClientEventHandlerMap[ClientEvent.Event] = (event) => {
            if (event.getId() === "$live") order.push("live");
        };
        const onRoom: ClientEventHandlerMap[ClientEvent.Room] = (room) => {
            order.push(room.roomId);
        };
        fixture.client.on(ClientEvent.Sync, onSync);
        fixture.client.on(ClientEvent.Event, onEvent);
        fixture.client.on(ClientEvent.Room, onRoom);
        beforeFirstReplayTask(() => {
            try {
                expect(fixture.client.getRoom("!cached8:example.com")).toBeNull();
                expect(order).not.toContain("prepared");
                const live = cachedRooms(1);
                const joined = live.rooms.join["!cached0:example.com"];
                joined.state = { events: [] };
                joined.ephemeral = { events: [] };
                joined.timeline.events[0].event_id = "$live";
                live.rooms.join = { [existingId]: joined };
                live.next_batch = "live-token";
                fixture.http.resolve(live);
                boundary.resolve();
            } catch (error) {
                boundary.reject(error);
            }
        });
        const running = fixture.api.sync();
        try {
            await vi.waitFor(() => expect(fixture.request).toHaveBeenCalledOnce());
            savedReady.resolve(savedValue);
            await boundary.promise;
            expect(order).not.toContain("live");
            await vi.waitFor(() => expect(order).toContain("live"));
            expect(order.indexOf("prepared")).toBeGreaterThan(order.indexOf("!cached16:example.com"));
            expect(order.indexOf("live")).toBeGreaterThan(order.indexOf("prepared"));
            expect(fixture.client.getRoom(existingId)).toBe(existing);
            expect(order).not.toContain(existingId);
            expect(
                existing
                    .getLiveTimeline()
                    .getEvents()
                    .map((event) => event.getId()),
            ).toEqual(["$message9", "$live"]);
            expect(existing.getMyMembership()).toBe("join");
            expect(existing.getReadReceiptForUserId(readerId)?.eventId).toBe("$message9");
            expect(existing.getAccountData("m.tag")?.getContent()).toEqual({ tags: { "m.favourite": {} } });
        } finally {
            fixture.api.stop();
            fixture.http.resolve(cachedRooms(0));
            followingHttp.resolve(cachedRooms(0));
            await running;
            fixture.client.off(ClientEvent.Sync, onSync);
            fixture.client.off(ClientEvent.Event, onEvent);
            fixture.client.off(ClientEvent.Room, onRoom);
        }
    });

    it("stops at a batch boundary without publishing the remaining rooms or cached PREPARED", async () => {
        const fixture = setup(Promise.resolve({ global: {} }), cachedRooms(17));
        const prepared = vi.fn();
        const onSync = (state: SyncState): void => {
            if (state === SyncState.Prepared) prepared();
        };
        let published = 0;
        const onRoom = (): void => {
            published++;
        };
        fixture.client.on(ClientEvent.Sync, onSync);
        fixture.client.on(ClientEvent.Room, onRoom);
        beforeFirstReplayTask(() => {
            fixture.api.stop();
            fixture.http.resolve(cachedRooms(0));
        });
        try {
            await fixture.api.sync();
            expect(published).toBe(8);
            expect(fixture.client.getRoom("!cached8:example.com")).toBeNull();
            expect(prepared).not.toHaveBeenCalled();
        } finally {
            fixture.api.stop();
            fixture.http.resolve(cachedRooms(0));
            fixture.client.off(ClientEvent.Sync, onSync);
            fixture.client.off(ClientEvent.Room, onRoom);
        }
    });

    it("starts later batches while an earlier room is waiting for crypto", async () => {
        const saved = cachedRooms(17);
        for (const [id, room] of Object.entries(saved.rooms.join)) {
            room.state!.events.push({
                type: EventType.RoomEncryption,
                state_key: "",
                sender: userId,
                event_id: `$encryption${id}`,
                origin_server_ts: 1,
                content: { algorithm: "m.megolm.v1.aes-sha2" },
            });
        }
        const firstCrypto = Promise.withResolvers<void>();
        const onCryptoEvent = vi.fn((room: Room) =>
            room.roomId === "!cached0:example.com" ? firstCrypto.promise : Promise.resolve(),
        );
        const fixture = setup(Promise.resolve({ global: {} }), saved, {
            onCryptoEvent,
            processSyncChanges: vi.fn().mockResolvedValue([]),
            onSyncCompleted: vi.fn(),
            markAllTrackedUsersAsDirty: vi.fn().mockResolvedValue(undefined),
        });
        const prepared = vi.fn();
        const onSync = (state: SyncState): void => {
            if (state === SyncState.Prepared) prepared();
        };
        fixture.client.on(ClientEvent.Sync, onSync);
        const running = fixture.api.sync();
        try {
            await vi.waitFor(() => expect(onCryptoEvent).toHaveBeenCalledTimes(17));
            expect(fixture.client.getRoom("!cached0:example.com")).toBeNull();
            expect(fixture.client.getRoom("!cached16:example.com")).not.toBeNull();
            expect(prepared).not.toHaveBeenCalled();
            firstCrypto.resolve();
            await vi.waitFor(() => expect(prepared).toHaveBeenCalledOnce());
        } finally {
            firstCrypto.resolve();
            fixture.api.stop();
            fixture.http.resolve(cachedRooms(0));
            await running;
            fixture.client.off(ClientEvent.Sync, onSync);
        }
    });
});
