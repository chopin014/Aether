/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
    ClientEvent,
    EventTimeline,
    EventTimelineSet,
    EventType,
    MatrixError,
    RoomEvent,
    SyncState,
    type MatrixClient,
} from "matrix-js-sdk/src/matrix";
import { type QueryDict } from "matrix-js-sdk/src/utils";
import { logger } from "matrix-js-sdk/src/logger";
import {
    ExtensionState,
    SlidingSync,
    SlidingSyncEvent,
    type Extension,
    type MSC3575RoomData,
    type MSC3575SlidingSyncResponse,
    type SlidingSyncSnapshot,
} from "matrix-js-sdk/src/sliding-sync";
// These tests cover Aether's patch to the SDK's sliding sync, so they use the real implementation.
// oxlint-disable-next-line no-restricted-imports
import { SlidingSyncSdk } from "matrix-js-sdk/src/sliding-sync-sdk";

import { createClientWithCreds } from "../utils/createMatrixClient";

type SyncCryptoCallbacks = NonNullable<ConstructorParameters<typeof SlidingSyncSdk>[3]["cryptoCallbacks"]>;

const roomId = "!room:example.org";
const userId = "@alice:example.org";

function message(id: string, ts: number): NonNullable<MSC3575RoomData["timeline"]>[number] {
    return {
        type: EventType.RoomMessage,
        sender: userId,
        room_id: roomId,
        event_id: id,
        origin_server_ts: ts,
        content: { msgtype: "m.text", body: id },
    };
}

const requiredState: MSC3575RoomData["required_state"] = [
    {
        type: EventType.RoomCreate,
        state_key: "",
        sender: userId,
        event_id: "$create",
        origin_server_ts: 0,
        content: {},
    },
    {
        type: EventType.RoomMember,
        state_key: userId,
        sender: userId,
        event_id: "$member",
        origin_server_ts: 0,
        content: { membership: "join" },
    },
];

function makeClient(): MatrixClient {
    const client = createClientWithCreds({ homeserverUrl: "https://example.org", userId, accessToken: "token" });
    client.pushRules = { global: {} };
    return client;
}

describe("sliding sync timelines with gaps", () => {
    afterEach(() => vi.restoreAllMocks());

    async function setup() {
        const client = makeClient();
        const sync = new SlidingSync("https://example.org", new Map(), {}, client, 1000);
        const api = new SlidingSyncSdk(sync, client, { lazyLoadMembers: true }, { logger });
        const receive = async (data: Partial<MSC3575RoomData>): Promise<void> => {
            await sync.emitPromised(SlidingSyncEvent.RoomData, roomId, {
                required_state: [],
                timeline: [],
                ...data,
                name: "Room",
            });
        };
        await receive({ initial: true, required_state: requiredState, timeline: [message("$a", 1), message("$b", 2)] });
        const room = client.getRoom(roomId)!;
        const timelineIds = (): string[] =>
            room
                .getLiveTimeline()
                .getEvents()
                .filter((event) => event.getType() === EventType.RoomMessage)
                .map((event) => event.getId()!);
        return { client, sync, api, room, receive, timelineIds };
    }

    it("starts a new live timeline when a limited response skips events", async () => {
        const { room, receive, timelineIds, api } = await setup();
        const reset = vi.fn();
        room.on(RoomEvent.TimelineReset, reset);

        await receive({ limited: true, prev_batch: "gap", timeline: [message("$e", 5)] });

        // The skipped events are not hidden between $b and $e: history starts again at $e, paginating into the gap.
        expect(timelineIds()).toEqual(["$e"]);
        expect(room.getLiveTimeline().getPaginationToken(EventTimeline.BACKWARDS)).toBe("gap");
        expect(room.findEventById("$a")).toBeUndefined();
        expect(reset).toHaveBeenCalledTimes(1);
        api.stop();
    });

    it("appends a limited response that continues the known timeline, keeping its pagination token", async () => {
        const { room, receive, timelineIds, api } = await setup();
        const before = room.getLiveTimeline().getPaginationToken(EventTimeline.BACKWARDS);
        const reset = vi.fn();
        room.on(RoomEvent.TimelineReset, reset);

        await receive({ limited: true, prev_batch: "inside", timeline: [message("$b", 2), message("$c", 3)] });

        expect(timelineIds()).toEqual(["$a", "$b", "$c"]);
        expect(room.getLiveTimeline().getPaginationToken(EventTimeline.BACKWARDS)).toBe(before);
        expect(reset).not.toHaveBeenCalled();
        api.stop();
    });

    it("appends an unlimited response, and sets the token of a timeline's first limited response", async () => {
        const { receive, timelineIds, api, client } = await setup();
        await receive({ timeline: [message("$c", 3)] });
        expect(timelineIds()).toEqual(["$a", "$b", "$c"]);

        const otherId = "!other:example.org";
        const sync = (api as unknown as { slidingSync: SlidingSync }).slidingSync;
        await sync.emitPromised(SlidingSyncEvent.RoomData, otherId, {
            name: "Other",
            initial: true,
            limited: true,
            prev_batch: "first",
            required_state: requiredState.map((event) => ({ ...event, room_id: otherId })),
            timeline: [{ ...message("$x", 9), room_id: otherId }],
        });
        expect(client.getRoom(otherId)!.getLiveTimeline().getPaginationToken(EventTimeline.BACKWARDS)).toBe("first");
        api.stop();
    });
});

describe("sliding sync requests", () => {
    afterEach(() => vi.restoreAllMocks());

    interface Request {
        qps: QueryDict;
        body: Record<string, unknown>;
        reply: (response: Partial<MSC3575SlidingSyncResponse>) => void;
        fail: (error: Error) => void;
        signal?: AbortSignal;
        at: number;
    }

    function setup(extension?: Extension<object, object>) {
        const client = makeClient();
        const requests: Request[] = [];
        vi.spyOn(client.http, "authedRequest").mockImplementation(((
            _method: unknown,
            _path: unknown,
            qps: QueryDict,
            body: Record<string, unknown>,
            opts: { abortSignal?: AbortSignal },
        ) => {
            const { promise, resolve, reject } = Promise.withResolvers<MSC3575SlidingSyncResponse>();
            opts.abortSignal?.addEventListener("abort", () => {
                const error = new Error("aborted");
                error.name = "AbortError";
                reject(error);
            });
            requests.push({
                qps: { ...qps },
                body: structuredClone(body),
                reply: (response) => resolve({ pos: "next", lists: {}, rooms: {}, extensions: {}, ...response }),
                fail: reject,
                signal: opts.abortSignal,
                at: performance.now(),
            });
            return promise;
        }) as never);
        const nextRequest = async (count: number): Promise<Request> => {
            await vi.waitFor(() => expect(requests.length).toBeGreaterThanOrEqual(count), { timeout: 3000 });
            return requests[count - 1];
        };
        const sync = new SlidingSync(
            "https://example.org",
            new Map([["all", { ranges: [[0, 9]], timeline_limit: 1 }]]),
            {},
            client,
            20_000,
        );
        if (extension) sync.registerExtension(extension);
        void sync.start();
        return { sync, requests, nextRequest };
    }

    it("asks for an immediate answer when the request changed, and long-polls otherwise", async () => {
        const { sync, nextRequest } = setup();
        const first = await nextRequest(1);
        expect(first.qps.timeout).toBeUndefined();
        first.reply({ pos: "1" });

        const second = await nextRequest(2);
        expect(second.qps).toEqual({ pos: "1", timeout: 20_000 });

        // A new subscription interrupts the long poll and is answered straight away.
        sync.modifyRoomSubscriptions(new Set([roomId]));
        const third = await nextRequest(3);
        expect(third.qps).toEqual({ pos: "1" });
        expect(third.body.room_subscriptions).toHaveProperty([roomId]);
        expect(sync.isRoomSubscriptionConfirmed(roomId)).toBe(false);
        third.reply({ pos: "2" });

        const fourth = await nextRequest(4);
        expect(sync.isRoomSubscriptionConfirmed(roomId)).toBe(true);
        expect(fourth.qps).toEqual({ pos: "2", timeout: 20_000 });
        sync.stop();
    });

    describe("room subscriptions", () => {
        const pinned = { timeline_limit: 50, required_state: [["m.room.pinned_events", ""]] };
        const channel = { timeline_limit: 1, required_state: [["m.room.create", ""]] };

        it("sends every subscription in full with every request, as the server keeps none", async () => {
            const { sync, nextRequest } = setup();
            sync.addCustomSubscription("pinned", pinned);
            sync.useCustomSubscription(roomId, "pinned");
            sync.modifyRoomSubscriptions(new Set([roomId]));
            const first = await nextRequest(1);
            expect(first.body.room_subscriptions).toEqual({ [roomId]: pinned });
            first.reply({ pos: "1" });

            // Unchanged requests long-poll, and still carry the subscription.
            const second = await nextRequest(2);
            expect(second.qps.timeout).toBe(20_000);
            expect(second.body.room_subscriptions).toEqual({ [roomId]: pinned });
            second.reply({ pos: "2" });
            const third = await nextRequest(3);
            expect(third.qps.timeout).toBe(20_000);
            expect(third.body.room_subscriptions).toEqual({ [roomId]: pinned });
            expect(third.body).not.toHaveProperty("unsubscribe_rooms");
            sync.stop();
        });

        it("unsubscribes a room by leaving it out, and sends none when there are none", async () => {
            const { sync, nextRequest } = setup();
            sync.modifyRoomSubscriptions(new Set([roomId, "!other:example.org"]));
            (await nextRequest(1)).reply({ pos: "1" });
            await nextRequest(2);

            sync.modifyRoomSubscriptions(new Set(["!other:example.org"]));
            const third = await nextRequest(3);
            expect(third.qps.timeout).toBeUndefined();
            expect(Object.keys(third.body.room_subscriptions as object)).toEqual(["!other:example.org"]);
            expect(third.body).not.toHaveProperty("unsubscribe_rooms");
            third.reply({ pos: "2" });
            await nextRequest(4);

            sync.modifyRoomSubscriptions(new Set());
            const fifth = await nextRequest(5);
            expect(fifth.body).not.toHaveProperty("room_subscriptions");
            expect(fifth.body).not.toHaveProperty("unsubscribe_rooms");
            sync.stop();
        });

        it("confirms a subscription only once a request carrying it, as it is now, is answered", async () => {
            const { sync, nextRequest } = setup();
            sync.addCustomSubscription("pinned", pinned);
            sync.addCustomSubscription("channel", channel);
            sync.useCustomSubscription(roomId, "channel");
            sync.modifyRoomSubscriptions(new Set([roomId]));
            const first = await nextRequest(1);

            // Changed while the request carrying the old subscription is out: its answer confirms the old one only.
            sync.useCustomSubscription(roomId, "pinned");
            first.reply({ pos: "1" });
            const second = await nextRequest(2);
            expect(sync.isRoomSubscriptionConfirmed(roomId)).toBe(false);
            expect(second.body.room_subscriptions).toEqual({ [roomId]: pinned });
            second.reply({ pos: "2" });
            await nextRequest(3);
            expect(sync.isRoomSubscriptionConfirmed(roomId)).toBe(true);
            sync.stop();
        });

        it("does not let an answer to a request sent before a room was subscribed again confirm it", async () => {
            const { sync, nextRequest } = setup();
            sync.modifyRoomSubscriptions(new Set([roomId]));
            const first = await nextRequest(1);
            first.reply({ pos: "1" });
            const second = await nextRequest(2);
            expect(sync.isRoomSubscriptionConfirmed(roomId)).toBe(true);

            // Answered, then unsubscribed and subscribed again before the answer is taken up: that request carried
            // the room's subscription from before, so it says nothing of the new one.
            const applied = Promise.withResolvers<MSC3575SlidingSyncResponse>();
            sync.once(SlidingSyncEvent.Applied, (response) => applied.resolve(response));
            second.reply({ pos: "2" });
            sync.modifyRoomSubscriptions(new Set());
            sync.modifyRoomSubscriptions(new Set([roomId]));
            expect(sync.isRoomSubscriptionConfirmed(roomId)).toBe(false);
            const response = await applied.promise;
            expect(sync.getRequestForResponse(response)?.roomSubscriptions.has(roomId)).toBe(true);
            const third = await nextRequest(3);
            expect(sync.isRoomSubscriptionConfirmed(roomId)).toBe(false);
            third.reply({ pos: "3" });
            await nextRequest(4);
            expect(sync.isRoomSubscriptionConfirmed(roomId)).toBe(true);
            sync.stop();
        });

        it("tells whoever applies a response which subscriptions its request carried", async () => {
            const { sync, nextRequest } = setup();
            sync.addCustomSubscription("pinned", pinned);
            sync.useCustomSubscription(roomId, "pinned");
            sync.modifyRoomSubscriptions(new Set([roomId]));
            const applied = Promise.withResolvers<MSC3575SlidingSyncResponse>();
            sync.once(SlidingSyncEvent.Applied, (response) => applied.resolve(response));
            (await nextRequest(1)).reply({ pos: "1" });

            const response = await applied.promise;
            expect(sync.getRequestForResponse(response)?.roomSubscriptions).toEqual(new Map([[roomId, pinned]]));
            // Changed afterwards: what the request carried stays as it was.
            sync.modifyRoomSubscriptions(new Set(["!other:example.org"]));
            expect(sync.getRequestForResponse(response)?.roomSubscriptions).toEqual(new Map([[roomId, pinned]]));
            expect(sync.getRequestForResponse({ pos: "x", lists: {}, rooms: {}, extensions: {} })).toBeUndefined();
            sync.stop();
        });
    });

    it("asks for an immediate answer for a change made while extensions are being prepared", async () => {
        const preparing = Promise.withResolvers<void>();
        let prepared = 0;
        const { sync, nextRequest } = setup({
            name: () => "org.example.slow",
            when: () => ExtensionState.PreProcess,
            onRequest: async () => {
                prepared++;
                if (prepared === 2) await preparing.promise;
                return {};
            },
            onResponse: async () => {},
        });
        (await nextRequest(1)).reply({ pos: "1" });
        await vi.waitFor(() => expect(prepared).toBe(2));
        // The subscription changes while the next request is still being prepared.
        sync.modifyRoomSubscriptions(new Set([roomId]));
        preparing.resolve();
        const second = await nextRequest(2);
        expect(second.qps).toEqual({ pos: "1" });
        expect(second.body.room_subscriptions).toHaveProperty([roomId]);
        sync.stop();
    });

    it("backs off when preparing extensions fails after a change, instead of retrying at once", async () => {
        const failing = Promise.withResolvers<void>();
        let prepared = 0;
        const { sync, nextRequest } = setup({
            name: () => "org.example.failing",
            when: () => ExtensionState.PreProcess,
            onRequest: async () => {
                prepared++;
                if (prepared === 1) return {};
                if (prepared === 2) await failing.promise;
                throw new Error("extension unavailable");
            },
            onResponse: async () => {},
        });
        (await nextRequest(1)).reply({ pos: "1" });
        await vi.waitFor(() => expect(prepared).toBe(2));
        // A change interrupts the wait while the extension is still being prepared, then preparation fails.
        sync.modifyRoomSubscriptions(new Set([roomId]));
        failing.resolve();
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(prepared).toBe(2);
        sync.stop();
    });

    it("keeps asking for an immediate answer after a changed request fails", async () => {
        const { sync, nextRequest } = setup();
        (await nextRequest(1)).reply({ pos: "1" });
        await nextRequest(2);
        sync.setListRanges("all", [[0, 99]]);
        const changed = await nextRequest(3);
        expect(changed.qps.timeout).toBeUndefined();
        changed.fail(
            new MatrixError(
                { errcode: "M_LIMIT_EXCEEDED" },
                429,
                undefined,
                undefined,
                new Headers({ "Retry-After": "1" }),
            ),
        );
        // The retry still carries the change, so it is answered immediately too.
        const retry = await nextRequest(4);
        expect(retry.at - changed.at).toBeGreaterThanOrEqual(950);
        expect(retry.qps).toEqual({ pos: "1" });
        sync.stop();
    }, 10_000);

    it("starts afresh straight away when the server forgot the connection", async () => {
        const { sync, nextRequest } = setup();
        (await nextRequest(1)).reply({ pos: "1" });
        const second = await nextRequest(2);
        second.fail(new MatrixError({ errcode: "M_UNKNOWN_POS", error: "Unknown position" }, 400));
        const third = await nextRequest(3);
        expect(third.qps.pos).toBeUndefined();
        expect(third.at - second.at).toBeLessThan(400);
        sync.stop();
    });

    it("backs off before starting afresh when the server keeps rejecting the request", async () => {
        const { sync, nextRequest } = setup();
        const first = await nextRequest(1);
        first.fail(new MatrixError({ errcode: "M_INVALID_PARAM", error: "Bad" }, 400));
        const second = await nextRequest(2);
        expect(second.at - first.at).toBeGreaterThanOrEqual(450);
        second.fail(new MatrixError({ errcode: "M_INVALID_PARAM", error: "Bad" }, 400));
        const third = await nextRequest(3);
        expect(third.at - second.at).toBeGreaterThanOrEqual(950);
        sync.stop();
    }, 10_000);

    it("waits for the server's retry delay when rate limited, and stops promptly while waiting", async () => {
        const { sync, nextRequest, requests } = setup();
        const first = await nextRequest(1);
        first.fail(
            new MatrixError(
                { errcode: "M_LIMIT_EXCEEDED" },
                429,
                undefined,
                undefined,
                new Headers({ "Retry-After": "2" }),
            ),
        );
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(requests).toHaveLength(1);
        sync.stop();
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(requests).toHaveLength(1);
    });
});

describe("sliding sync profile updates (MSC4262)", () => {
    afterEach(() => vi.restoreAllMocks());

    function setup(fields?: string[]) {
        const client = makeClient();
        vi.spyOn(client, "getPushRules").mockResolvedValue({ global: {} } as never);
        const bodies: Record<string, unknown>[] = [];
        const responses: ((response: Partial<MSC3575SlidingSyncResponse>) => void)[] = [];
        vi.spyOn(client.http, "authedRequest").mockImplementation(((
            _method: unknown,
            _path: unknown,
            _qps: unknown,
            body: Record<string, unknown>,
            opts: { abortSignal?: AbortSignal },
        ) => {
            const { promise, resolve, reject } = Promise.withResolvers<MSC3575SlidingSyncResponse>();
            opts.abortSignal?.addEventListener("abort", () => {
                const error = new Error("aborted");
                error.name = "AbortError";
                reject(error);
            });
            bodies.push(structuredClone(body));
            responses.push((response) => resolve({ pos: "1", lists: {}, rooms: {}, extensions: {}, ...response }));
            return promise;
        }) as never);
        const sync = new SlidingSync("https://example.org", new Map(), {}, client, 20_000);
        const api = new SlidingSyncSdk(
            sync,
            client,
            { lazyLoadMembers: true, unstableMSC4429SyncUserProfileFields: fields },
            { logger },
        );
        void api.sync();
        return { client, api, bodies, responses };
    }

    const extensionOf = (body: Record<string, unknown>): unknown =>
        (body.extensions as Record<string, unknown> | undefined)?.["org.matrix.msc4262.profiles"];

    it("asks for the profile fields regular sync asks for", async () => {
        const { api, bodies } = setup(["org.example.status", "m.tz"]);
        await vi.waitFor(() => expect(bodies).toHaveLength(1));
        expect(extensionOf(bodies[0])).toEqual({ enabled: true, fields: ["org.example.status", "m.tz"] });
        api.stop();
    });

    it("asks for no profile updates when no fields are wanted", async () => {
        const { api, bodies } = setup();
        await vi.waitFor(() => expect(bodies).toHaveLength(1));
        expect(extensionOf(bodies[0])).toBeUndefined();
        api.stop();
    });

    it("stores each update over the profile already known, and announces it once stored", async () => {
        const { client, api, responses } = setup(["org.example.status"]);
        await client.store.storeUserProfiles(
            new Map([["@bob:example.org", { "org.example.status": "away", "m.tz": "Europe/Lisbon" }]]),
        );
        const announced: [string, unknown, unknown][] = [];
        client.on(ClientEvent.UserProfileUpdate, async (who, profile) => {
            announced.push([who, profile, await client.store.getUserProfile(who)]);
        });
        await vi.waitFor(() => expect(responses).toHaveLength(1));
        responses[0]({
            extensions: {
                "org.matrix.msc4262.profiles": {
                    users: {
                        "@bob:example.org": { updated: { "org.example.status": "busy" } },
                        "@carol:example.org": null,
                    },
                },
            },
        });
        await vi.waitFor(() => expect(announced).toHaveLength(2));
        expect(announced).toContainEqual([
            "@bob:example.org",
            { "org.example.status": "busy" },
            { "org.example.status": "busy", "m.tz": "Europe/Lisbon" },
        ]);
        // A user whose profile is no longer sent is forgotten.
        expect(announced).toContainEqual(["@carol:example.org", null, undefined]);
        api.stop();
    });

    it("stores a field the server removed as null, alone or with updates, as regular sync does", async () => {
        const { client, api, responses } = setup(["org.example.status", "org.example.call"]);
        await client.store.storeUserProfiles(
            new Map([["@bob:example.org", { "org.example.status": "away", "org.example.call": "!room" }]]),
        );
        const announced: [string, unknown][] = [];
        client.on(ClientEvent.UserProfileUpdate, (who, profile) => announced.push([who, profile]));
        await vi.waitFor(() => expect(responses).toHaveLength(1));
        // The status is cleared on its own.
        responses[0]({
            pos: "1",
            extensions: {
                "org.matrix.msc4262.profiles": { users: { "@bob:example.org": { removed: ["org.example.status"] } } },
            },
        });
        await vi.waitFor(() => expect(announced).toHaveLength(1));
        expect(announced[0]).toEqual(["@bob:example.org", { "org.example.status": null }]);
        expect(await client.store.getUserProfile("@bob:example.org")).toEqual({
            "org.example.status": null,
            "org.example.call": "!room",
        });
        // Then the call ends while a new status is set.
        await vi.waitFor(() => expect(responses).toHaveLength(2));
        responses[1]({
            pos: "2",
            extensions: {
                "org.matrix.msc4262.profiles": {
                    users: {
                        "@bob:example.org": {
                            updated: { "org.example.status": "back" },
                            removed: ["org.example.call"],
                        },
                    },
                },
            },
        });
        await vi.waitFor(() => expect(announced).toHaveLength(2));
        expect(announced[1]).toEqual(["@bob:example.org", { "org.example.status": "back", "org.example.call": null }]);
        api.stop();
    });

    it("writes and announces nothing when the server repeats a profile unchanged, as for each message's sender", async () => {
        const { client, api, responses } = setup(["org.example.status"]);
        await client.store.storeUserProfiles(new Map([["@bob:example.org", { "org.example.status": "away" }]]));
        const write = vi.spyOn(client.store, "storeUserProfiles");
        const announced = vi.fn();
        client.on(ClientEvent.UserProfileUpdate, announced);
        await vi.waitFor(() => expect(responses).toHaveLength(1));
        const repeated = {
            "org.matrix.msc4262.profiles": {
                users: { "@bob:example.org": { updated: { "org.example.status": "away" } } },
            },
        };
        responses[0]({ pos: "1", extensions: repeated });
        await vi.waitFor(() => expect(responses).toHaveLength(2));
        responses[1]({ pos: "2", extensions: repeated });
        await vi.waitFor(() => expect(responses).toHaveLength(3));
        expect(write).not.toHaveBeenCalled();
        expect(announced).not.toHaveBeenCalled();
        api.stop();
    });
});

describe("sliding sync restoring a saved snapshot", () => {
    afterEach(() => vi.restoreAllMocks());

    function setup(
        load: () => Promise<SlidingSyncSnapshot | null>,
        prepare?: (client: MatrixClient) => void,
        cryptoCallbacks?: SyncCryptoCallbacks,
    ) {
        const client = makeClient();
        prepare?.(client);
        vi.spyOn(client, "getPushRules").mockResolvedValue({ global: {} } as never);
        const responses: ((response: Partial<MSC3575SlidingSyncResponse>) => void)[] = [];
        vi.spyOn(client.http, "authedRequest").mockImplementation(((
            _method: unknown,
            _path: unknown,
            _qps: unknown,
            _body: unknown,
            opts: { abortSignal?: AbortSignal },
        ) => {
            const { promise, resolve, reject } = Promise.withResolvers<MSC3575SlidingSyncResponse>();
            opts.abortSignal?.addEventListener("abort", () => {
                const error = new Error("aborted");
                error.name = "AbortError";
                reject(error);
            });
            responses.push((response) => resolve({ pos: "1", lists: {}, rooms: {}, extensions: {}, ...response }));
            return promise;
        }) as never);
        const sync = new SlidingSync("https://example.org", new Map(), {}, client, 20_000);
        const api = new SlidingSyncSdk(
            sync,
            client,
            { lazyLoadMembers: true, slidingSyncSnapshot: load },
            { logger, cryptoCallbacks },
        );
        const states: SyncState[] = [];
        client.on(ClientEvent.Sync, (state) => states.push(state));
        const syncing = api.sync();
        const timelineIds = (): string[] =>
            client
                .getRoom(roomId)!
                .getLiveTimeline()
                .getEvents()
                .filter((event) => event.getType() === EventType.RoomMessage)
                .map((event) => event.getId()!);
        return { client, api, sync, responses, states, timelineIds, syncing };
    }

    const saved = (fields: Partial<MSC3575RoomData> = {}): SlidingSyncSnapshot => ({
        rooms: {
            [roomId]: {
                name: "Saved",
                required_state: requiredState,
                timeline: [message("$a", 1), message("$b", 2)],
                limited: true,
                prev_batch: "saved",
                notification_count: 2,
                ...fields,
            } as MSC3575RoomData,
        },
        accountData: [{ type: EventType.Direct, content: { "@bob:example.org": [roomId] } }],
        receipts: {
            [roomId]: { type: EventType.Receipt, content: { $b: { "m.read": { [userId]: { ts: 2 } } } } },
        },
    });

    it("shows the saved rooms before the first response, and announces Prepared once", async () => {
        const { client, api, responses, states, timelineIds } = setup(async () => saved());
        await vi.waitFor(() => expect(states).toEqual([SyncState.Prepared]));
        expect(timelineIds()).toEqual(["$a", "$b"]);
        const room = client.getRoom(roomId)!;
        expect(room.getLiveTimeline().getPaginationToken(EventTimeline.BACKWARDS)).toBe("saved");
        expect(room.getUnreadNotificationCount()).toBe(2);
        expect(room.getEventReadUpTo(userId)).toBe("$b");
        expect(client.getAccountData(EventType.Direct)?.getContent()).toEqual({ "@bob:example.org": [roomId] });

        await vi.waitFor(() => expect(responses).toHaveLength(1));
        responses[0]({ rooms: { [roomId]: { name: "Saved", required_state: [], timeline: [message("$c", 3)] } } });
        await vi.waitFor(() => expect(timelineIds()).toEqual(["$a", "$b", "$c"]));
        expect(states).toEqual([SyncState.Prepared, SyncState.Syncing]);
        api.stop();
    });

    it("adds no saved events to the notifications", async () => {
        const notifications = new EventTimelineSet(undefined, { timelineSupport: true }, makeClient());
        const { client, api, responses, states } = setup(
            async () => saved(),
            (client) => {
                client.setNotifTimelineSet(notifications);
                vi.spyOn(client, "getPushActionsForEvent").mockReturnValue({
                    notify: true,
                    tweaks: { highlight: true },
                } as never);
            },
        );
        await vi.waitFor(() => expect(states).toContain(SyncState.Prepared));
        await vi.waitFor(() => expect(responses).toHaveLength(1));
        responses[0]({ rooms: { [roomId]: { name: "Saved", required_state: [], timeline: [message("$c", 3)] } } });
        await vi.waitFor(() => expect(states).toContain(SyncState.Syncing));
        expect(
            notifications
                .getLiveTimeline()
                .getEvents()
                .map((event) => event.getId()),
        ).toEqual(["$c"]);
        expect(client.getRoom(roomId)).not.toBeNull();
        api.stop();
    });

    it("sends the first request while the snapshot loads, and applies its response on top of the saved rooms", async () => {
        const loading = Promise.withResolvers<SlidingSyncSnapshot | null>();
        const { client, api, responses, states, timelineIds } = setup(() => loading.promise);
        await vi.waitFor(() => expect(responses).toHaveLength(1));
        responses[0]({
            rooms: {
                [roomId]: {
                    name: "Fresh",
                    required_state: [],
                    timeline: [message("$b", 2), message("$c", 3)],
                    limited: true,
                    prev_batch: "fresh",
                },
            },
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        // Nothing is processed until the saved rooms are in place.
        expect(client.getRoom(roomId)).toBeNull();
        loading.resolve(saved());
        await vi.waitFor(() => expect(timelineIds()).toEqual(["$a", "$b", "$c"]));
        expect(states.slice(0, 2)).toEqual([SyncState.Prepared, SyncState.Syncing]);
        api.stop();
    });

    it("gives a restored timeline without a token the token of a response that reaches its first event", async () => {
        const { client, api, responses, timelineIds } = setup(async () =>
            saved({ limited: false, prev_batch: undefined }),
        );
        await vi.waitFor(() => expect(client.getRoom(roomId)).not.toBeNull());
        const timeline = client.getRoom(roomId)!.getLiveTimeline();
        expect(timeline.getPaginationToken(EventTimeline.BACKWARDS)).toBeNull();
        await vi.waitFor(() => expect(responses).toHaveLength(1));
        responses[0]({
            rooms: {
                [roomId]: {
                    name: "Fresh",
                    initial: true,
                    limited: true,
                    prev_batch: "fresh",
                    required_state: [],
                    timeline: [message("$a", 1), message("$b", 2), message("$c", 3)],
                },
            },
        });
        await vi.waitFor(() => expect(timelineIds()).toEqual(["$a", "$b", "$c"]));
        expect(client.getRoom(roomId)!.getLiveTimeline().getPaginationToken(EventTimeline.BACKWARDS)).toBe("fresh");
        api.stop();
    });

    describe("with many saved rooms", () => {
        const id = (i: number): string => `!r${i}:example.org`;
        const savedRoom = (roomId: string, bump: number, space = false): MSC3575RoomData =>
            ({
                name: roomId,
                bump_stamp: bump,
                required_state: [
                    { ...requiredState[0], room_id: roomId, content: space ? { type: "m.space" } : {} },
                    { ...requiredState[1], room_id: roomId },
                ],
                timeline: space ? [] : [{ ...message(`$saved-${roomId}`, bump), room_id: roomId }],
                limited: true,
                prev_batch: "saved",
            }) as MSC3575RoomData;
        // 30 rooms, the most recent last; a Space that has been quiet; the room opened at start is the oldest.
        const many = (): SlidingSyncSnapshot => ({
            rooms: {
                ...Object.fromEntries(Array.from({ length: 30 }, (_, i) => [id(i), savedRoom(id(i), i + 10)])),
                "!space:example.org": savedRoom("!space:example.org", 0, true),
            },
            priorityRoomIds: [id(0)],
        });
        const messages = (client: MatrixClient, roomId: string): string[] =>
            client
                .getRoom(roomId)!
                .getLiveTimeline()
                .getEvents()
                .filter((event) => event.getType() === EventType.RoomMessage)
                .map((event) => event.getId()!);

        it("shows the room opened at start, the Spaces and the most recent rooms before Prepared, then the rest", async () => {
            let shownFirst: string[] = [];
            let firstStored: string | undefined;
            const { client, api, states } = setup(async () => many());
            client.on(ClientEvent.Room, (room) => (firstStored ??= room.roomId));
            client.on(ClientEvent.Sync, (state) => {
                if (state === SyncState.Prepared) shownFirst = client.getRooms().map((room) => room.roomId);
            });
            await vi.waitFor(() => expect(states).toContain(SyncState.Prepared));
            expect(new Set(shownFirst)).toEqual(
                new Set([id(0), "!space:example.org", ...Array.from({ length: 20 }, (_, i) => id(29 - i))]),
            );
            // The room opened at start is applied before any other, though it is the least active.
            expect(firstStored).toBe(id(0));
            await vi.waitFor(() => expect(client.getRooms()).toHaveLength(31));
            expect(states.filter((state) => state === SyncState.Prepared)).toHaveLength(1);
            api.stop();
        });

        it("applies a room's saved data before live data that arrives while it waits its turn", async () => {
            const { client, api, responses, states } = setup(async () => many());
            await vi.waitFor(() => expect(responses).toHaveLength(1));
            responses[0]({
                rooms: {
                    [id(1)]: {
                        name: id(1),
                        required_state: [],
                        timeline: [{ ...message("$live", 100), room_id: id(1) }],
                    },
                },
            });
            await vi.waitFor(() => expect(states).toContain(SyncState.Syncing));
            expect(messages(client, id(1))).toEqual([`$saved-${id(1)}`, "$live"]);
            api.stop();
        });

        it("applies a saved room someone asks for ahead of its turn", async () => {
            const { client, api, sync, states } = setup(async () => many());
            const storedAfterPrepared: string[] = [];
            let asked: Promise<void> | undefined;
            client.on(ClientEvent.Sync, (state) => {
                if (state !== SyncState.Prepared) return;
                client.on(ClientEvent.Room, (room) => storedAfterPrepared.push(room.roomId));
                // The least active room waits for every other background room.
                expect(client.getRoom(id(0))).not.toBeNull();
                expect(client.getRoom(id(1))).toBeNull();
                expect(sync.hasSavedRoom(id(1))).toBe(true);
                asked = sync.restoreSavedRooms([id(1)]);
            });
            await vi.waitFor(() => expect(states).toContain(SyncState.Prepared));
            await asked;
            expect(messages(client, id(1))).toEqual([`$saved-${id(1)}`]);
            expect(storedAfterPrepared[0]).toBe(id(1));
            // Applied once: the background restore skips it.
            await vi.waitFor(() => expect(client.getRooms()).toHaveLength(31));
            expect(storedAfterPrepared.filter((roomId) => roomId === id(1))).toHaveLength(1);
            expect(messages(client, id(1))).toEqual([`$saved-${id(1)}`]);
            api.stop();
        });

        it("has no saved rooms left once every one is applied", async () => {
            const { client, api, sync } = setup(async () => many());
            await vi.waitFor(() => expect(client.getRooms()).toHaveLength(31));
            await vi.waitFor(() => expect(sync.hasSavedRoom(id(1))).toBe(false));
            // Asking for a room with nothing saved left does nothing.
            await sync.restoreSavedRooms([id(1), "!unknown:example.org"]);
            expect(client.getRoom("!unknown:example.org")).toBeNull();
            api.stop();
        });

        it("lets saved rooms go when the client stops", async () => {
            const { client, api, sync, states } = setup(async () => many());
            // Stopped before the background restore starts.
            client.on(ClientEvent.Sync, (state) => {
                if (state === SyncState.Prepared) api.stop();
            });
            await vi.waitFor(() => expect(states).toContain(SyncState.Prepared));
            expect(sync.hasSavedRoom(id(1))).toBe(false);
            await sync.restoreSavedRooms([id(1)]);
            expect(client.getRoom(id(1))).toBeNull();
        });

        it("does not show a room dropped from the snapshot before its turn", async () => {
            const snapshot = many();
            const { client, api, states } = setup(async () => snapshot);
            client.on(ClientEvent.Sync, (state) => {
                // The client learns the user left this room, before the background restore reaches it.
                if (state === SyncState.Prepared) delete snapshot.rooms[id(1)];
            });
            await vi.waitFor(() => expect(states).toContain(SyncState.Prepared));
            await vi.waitFor(() => expect(client.getRooms()).toHaveLength(30));
            expect(client.getRoom(id(1))).toBeNull();
            api.stop();
        });

        /** A saved room that is encrypted, so applying it waits on the crypto layer. */
        const encrypted = (roomId: string, bump: number): MSC3575RoomData => {
            const data = savedRoom(roomId, bump);
            data.required_state = [
                ...data.required_state,
                {
                    type: EventType.RoomEncryption,
                    state_key: "",
                    sender: userId,
                    room_id: roomId,
                    event_id: `$encryption-${roomId}`,
                    origin_server_ts: 0,
                    content: { algorithm: "m.megolm.v1.aes-sha2" },
                },
            ];
            return data;
        };
        /** Crypto callbacks that hold a room's encryption event until released. */
        const holdCrypto = (heldRoomId: string): { callbacks: SyncCryptoCallbacks; release: () => void } => {
            const held = Promise.withResolvers<void>();
            const callbacks = {
                onCryptoEvent: async (room: { roomId: string }) => {
                    if (room.roomId === heldRoomId) await held.promise;
                },
                onSyncCompleted: () => {},
                preprocessToDeviceMessages: async (events: unknown[]) => events,
                processKeyCounts: async () => {},
                processSyncChanges: async () => [],
                onDeviceListsChanged: async () => {},
                markAllTrackedUsersAsDirty: async () => {},
            } as unknown as SyncCryptoCallbacks;
            return { callbacks, release: () => held.resolve() };
        };

        it("applies nothing more to a client stopped while a saved room waits on the crypto layer", async () => {
            const snapshot = many();
            snapshot.rooms[id(0)] = encrypted(id(0), 10);
            snapshot.roomAccountData = { [id(0)]: [{ type: "m.tag", content: { tags: { "u.work": {} } } }] };
            const crypto = holdCrypto(id(0));
            const { client, api, states } = setup(async () => snapshot, undefined, crypto.callbacks);
            const heard: string[] = [];
            client.on(ClientEvent.Event, (event) => heard.push(event.getId()!));
            await vi.waitFor(() => expect(heard).toContain(`$encryption-${id(0)}`));
            api.stop();
            const afterStop = heard.length;
            crypto.release();
            await new Promise((resolve) => setTimeout(resolve, 50));
            // The saved message after the encryption event, the account data and the other rooms never arrive.
            expect(heard).toHaveLength(afterStop);
            expect(client.getRoom(id(0))?.getAccountData("m.tag")).toBeUndefined();
            expect(states).not.toContain(SyncState.Prepared);
            expect(client.getRooms().map((room) => room.roomId)).toEqual([id(0)]);
        });

        it("drops live data that waited on a saved room's restore when the client stops", async () => {
            const snapshot = many();
            snapshot.rooms[id(1)] = encrypted(id(1), 11);
            const crypto = holdCrypto(id(1));
            // Note live data as it arrives, so the client is stopped while it waits on the saved data.
            type RoomDataHandler = (roomId: string, data: MSC3575RoomData, fromSnapshot?: boolean) => Promise<void>;
            const prototype = SlidingSyncSdk.prototype as unknown as { onRoomData: RoomDataHandler };
            const onRoomData = prototype.onRoomData;
            const liveRooms: string[] = [];
            vi.spyOn(prototype, "onRoomData").mockImplementation(function (this: unknown, roomId, data, fromSnapshot) {
                if (!fromSnapshot) liveRooms.push(roomId);
                return onRoomData.call(this, roomId, data, fromSnapshot);
            });
            const { client, api, responses } = setup(async () => snapshot, undefined, crypto.callbacks);
            await vi.waitFor(() => expect(responses).toHaveLength(1));
            // Live data for a room waiting its turn; applying its saved data waits on the crypto layer.
            responses[0]({
                rooms: {
                    [id(1)]: {
                        name: id(1),
                        required_state: [],
                        timeline: [{ ...message("$live", 100), room_id: id(1) }],
                    },
                },
            });
            await vi.waitFor(() => expect(liveRooms).toContain(id(1)));
            api.stop();
            crypto.release();
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(messages(client, id(1))).not.toContain("$live");
        });

        it("adds live events to the notifications while saved rooms are still being applied", async () => {
            const notifications = new EventTimelineSet(undefined, { timelineSupport: true }, makeClient());
            const { api, responses, states } = setup(
                async () => many(),
                (client) => {
                    client.setNotifTimelineSet(notifications);
                    vi.spyOn(client, "getPushActionsForEvent").mockReturnValue({
                        notify: true,
                        tweaks: { highlight: true },
                    } as never);
                },
            );
            await vi.waitFor(() => expect(responses).toHaveLength(1));
            responses[0]({
                rooms: {
                    [id(29)]: {
                        name: id(29),
                        required_state: [],
                        timeline: [{ ...message("$mention", 100), room_id: id(29) }],
                    },
                },
            });
            await vi.waitFor(() => expect(states).toContain(SyncState.Syncing));
            expect(
                notifications
                    .getLiveTimeline()
                    .getEvents()
                    .map((event) => event.getId()),
            ).toEqual(["$mention"]);
            api.stop();
        });
    });

    it("sends the first request without waiting to mark device lists out of date, and applies its changes after", async () => {
        const marking = Promise.withResolvers<void>();
        const deviceLists = vi.fn();
        const callbacks = {
            onCryptoEvent: async () => {},
            onSyncCompleted: () => {},
            preprocessToDeviceMessages: async (events: unknown[]) => events,
            processKeyCounts: async () => {},
            processSyncChanges: async (changes: { deviceLists?: unknown }) => {
                deviceLists(changes.deviceLists);
                return [];
            },
            onDeviceListsChanged: async () => {},
            markAllTrackedUsersAsDirty: () => marking.promise,
        } as unknown as SyncCryptoCallbacks;
        const { api, responses } = setup(async () => null, undefined, callbacks);
        await vi.waitFor(() => expect(responses).toHaveLength(1));
        responses[0]({ extensions: { e2ee: { device_lists: { changed: ["@bob:example.org"], left: [] } } } });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(deviceLists).not.toHaveBeenCalled();
        marking.resolve();
        await vi.waitFor(() => expect(deviceLists).toHaveBeenCalledWith({ changed: ["@bob:example.org"], left: [] }));
        api.stop();
    });

    it("holds a response's device lists until marking device lists out of date succeeds, trying again", async () => {
        const marks = vi.fn().mockRejectedValueOnce(new Error("store busy")).mockResolvedValue(undefined);
        const deviceLists = vi.fn();
        const callbacks = {
            onCryptoEvent: async () => {},
            onSyncCompleted: () => {},
            preprocessToDeviceMessages: async (events: unknown[]) => events,
            processKeyCounts: async () => {},
            processSyncChanges: async (changes: { deviceLists?: unknown }) => {
                deviceLists(changes.deviceLists);
                return [];
            },
            onDeviceListsChanged: async () => {},
            markAllTrackedUsersAsDirty: marks,
        } as unknown as SyncCryptoCallbacks;
        const { api, responses } = setup(async () => null, undefined, callbacks);
        await vi.waitFor(() => expect(responses).toHaveLength(1));
        responses[0]({ pos: "1", extensions: { e2ee: { device_lists: { changed: ["@bob:example.org"], left: [] } } } });
        // The first marking failed: the changes wait while it is made again.
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(deviceLists).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(marks).toHaveBeenCalledTimes(2), { timeout: 3000 });
        await vi.waitFor(() => expect(deviceLists).toHaveBeenCalledWith({ changed: ["@bob:example.org"], left: [] }));
        // Later requests do not mark again.
        await vi.waitFor(() => expect(responses).toHaveLength(2));
        responses[1]({ pos: "2" });
        await vi.waitFor(() => expect(responses).toHaveLength(3));
        expect(marks).toHaveBeenCalledTimes(2);
        api.stop();
    });

    describe("when the client stops while device lists are being marked out of date", () => {
        const callbacks = (marks: () => Promise<void>, deviceLists: (lists: unknown) => void): SyncCryptoCallbacks =>
            ({
                onCryptoEvent: async () => {},
                onSyncCompleted: () => {},
                preprocessToDeviceMessages: async (events: unknown[]) => events,
                processKeyCounts: async () => {},
                processSyncChanges: async (changes: { deviceLists?: unknown }) => {
                    deviceLists(changes.deviceLists);
                    return [];
                },
                onDeviceListsChanged: async () => {},
                markAllTrackedUsersAsDirty: marks,
            }) as unknown as SyncCryptoCallbacks;
        const changes = { extensions: { e2ee: { device_lists: { changed: ["@bob:example.org"], left: [] } } } };

        it("stops waiting for a marking that never ends, and drops the held changes", async () => {
            const deviceLists = vi.fn();
            const { api, responses, syncing } = setup(
                async () => null,
                undefined,
                callbacks(() => new Promise<void>(() => {}), deviceLists),
            );
            await vi.waitFor(() => expect(responses).toHaveLength(1));
            responses[0]({ pos: "1", ...changes });
            await new Promise((resolve) => setTimeout(resolve, 20));
            api.stop();
            await syncing;
            expect(deviceLists).not.toHaveBeenCalled();
        });

        it("stops waiting to try a failed marking again", async () => {
            const deviceLists = vi.fn();
            const marks = vi.fn().mockRejectedValue(new Error("store busy"));
            const { api, responses, syncing } = setup(async () => null, undefined, callbacks(marks, deviceLists));
            await vi.waitFor(() => expect(responses).toHaveLength(1));
            responses[0]({ pos: "1", ...changes });
            await vi.waitFor(() => expect(marks).toHaveBeenCalledTimes(1));
            await new Promise((resolve) => setTimeout(resolve, 20));
            const stopped = Date.now();
            api.stop();
            await syncing;
            // Well within the half second before the next attempt.
            expect(Date.now() - stopped).toBeLessThan(400);
            await new Promise((resolve) => setTimeout(resolve, 600));
            expect(marks).toHaveBeenCalledTimes(1);
            expect(deviceLists).not.toHaveBeenCalled();
        });
    });

    it("starts normally when the snapshot cannot be loaded", async () => {
        const { api, responses, states } = setup(async () => {
            throw new Error("storage broken");
        });
        await vi.waitFor(() => expect(responses).toHaveLength(1));
        expect(states).toEqual([]);
        responses[0]({});
        await vi.waitFor(() => expect(states).toEqual([SyncState.Prepared, SyncState.Syncing]));
        api.stop();
    });
});
