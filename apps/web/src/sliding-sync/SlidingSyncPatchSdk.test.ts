/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
    ClientEvent,
    ConnectionError,
    ContentHelpers,
    EventTimeline,
    EventTimelineSet,
    EventType,
    M_BEACON,
    M_BEACON_INFO,
    MatrixError,
    MatrixEvent,
    MatrixEventEvent,
    Room,
    RoomEvent,
    RoomStateEvent,
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

describe("relations to events the room has only as state", () => {
    afterEach(() => vi.restoreAllMocks());

    // Someone else in the room, whose call membership is from before the user could see the room's history: sliding
    // sync sends it as state only.
    const bob = "@bob:example.org";
    const callMember = {
        type: "org.matrix.msc3401.call.member",
        state_key: `_${bob}_DEVICE`,
        sender: bob,
        event_id: "$bob-call",
        origin_server_ts: 0,
        content: { application: "m.call", call_id: "" },
    };

    function reaction(id: string, target: string): NonNullable<MSC3575RoomData["timeline"]>[number] {
        return {
            type: EventType.Reaction,
            sender: bob,
            room_id: roomId,
            event_id: id,
            origin_server_ts: 5,
            content: { "m.relates_to": { rel_type: "m.annotation", event_id: target, key: "🖐️" } },
        };
    }

    async function setup() {
        const client = makeClient();
        // Threads decide where a relation lives, so they are on, as in the app.
        vi.spyOn(client, "supportsThreads").mockReturnValue(true);
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
        await receive({ initial: true, required_state: [...requiredState, callMember], timeline: [message("$a", 1)] });
        const room = client.getRoom(roomId)!;
        const timelineIds = (): string[] =>
            room
                .getLiveTimeline()
                .getEvents()
                .map((event) => event.getId()!);
        return { api, client, room, receive, timelineIds };
    }

    it("keeps a reaction to a state event the timeline does not hold, such as a raised hand in a call", async () => {
        const { api, room, receive, timelineIds } = await setup();
        expect(room.findEventById("$bob-call")).toBeUndefined();
        const onTimeline = vi.fn();
        room.on(RoomEvent.Timeline, onTimeline);

        await receive({ timeline: [reaction("$hand", "$bob-call")] });

        expect(timelineIds()).toContain("$hand");
        // Announced like any new event, which is how a call hears of it.
        expect(onTimeline.mock.calls.some(([event]) => event.getId() === "$hand")).toBe(true);
        const relations = room.relations.getChildEventsForEvent("$bob-call", "m.annotation", EventType.Reaction);
        expect(relations?.getRelations().map((event) => event.getId())).toEqual(["$hand"]);
        api.stop();
    });

    it("takes a live reaction to such an event as it is, fetching nothing and notifying nobody", async () => {
        const { api, client, room, receive } = await setup();
        // The default rules, under which a reaction does not notify.
        client.setPushRules({ global: {} });
        const fetch = vi.spyOn(client, "fetchRoomEvent");

        await receive({ timeline: [reaction("$hand", "$bob-call")], num_live: 1 });

        const hand = room.findEventById("$hand");
        expect(hand).toBeDefined();
        expect(fetch).not.toHaveBeenCalled();
        expect(client.getPushActionsForEvent(hand!)?.notify).toBe(false);
        api.stop();
    });

    it("still sets aside a relation to an event the room does not know at all", async () => {
        const { api, receive, timelineIds } = await setup();

        await receive({ timeline: [reaction("$lost", "$nowhere")] });

        expect(timelineIds()).not.toContain("$lost");
        api.stop();
    });

    it("does not look through the room's members for an event a relation is to", async () => {
        const { api, receive, timelineIds } = await setup();

        // The user's own membership is state the timeline does not hold, but members are not searched.
        await receive({ timeline: [reaction("$odd", "$member")] });

        expect(timelineIds()).not.toContain("$odd");
        api.stop();
    });
});

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
        await receive({
            initial: true,
            required_state: [...requiredState],
            timeline: [message("$a", 1), message("$b", 2)],
        });
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

    function setup(extension?: Extension<object, object>, processingReady?: Promise<void>) {
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
        void sync.start(processingReady);
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

        it("discards an answer to a request cancelled before it was taken up, and asks again", async () => {
            const { sync, nextRequest } = setup();
            sync.modifyRoomSubscriptions(new Set([roomId]));
            (await nextRequest(1)).reply({ pos: "1" });
            const second = await nextRequest(2);
            expect(sync.isRoomSubscriptionConfirmed(roomId)).toBe(true);
            const applied = vi.fn();
            sync.on(SlidingSyncEvent.Applied, applied);

            // Answered, then unsubscribed and subscribed again before the answer is taken up.
            second.reply({ pos: "2" });
            sync.modifyRoomSubscriptions(new Set());
            sync.modifyRoomSubscriptions(new Set([roomId]));
            const third = await nextRequest(3);
            // The answer was to a request that no longer stood: asked again from where it was sent.
            expect(applied).not.toHaveBeenCalled();
            expect(third.qps.pos).toBe("1");
            expect(sync.isRoomSubscriptionConfirmed(roomId)).toBe(false);
            third.reply({ pos: "3" });
            await nextRequest(4);
            expect(sync.isRoomSubscriptionConfirmed(roomId)).toBe(true);
            sync.stop();
        });

        it("discards an answer cancelled while it waited for the startup gate", async () => {
            const gate = Promise.withResolvers<void>();
            const { sync, nextRequest } = setup(undefined, gate.promise);
            const applied = vi.fn();
            sync.on(SlidingSyncEvent.Applied, applied);
            const first = await nextRequest(1);
            first.reply({ pos: "1" });
            await new Promise((resolve) => setTimeout(resolve, 0));
            // Changed while the answer waits for the client to be ready to apply it.
            sync.modifyRoomSubscriptions(new Set([roomId]));
            gate.resolve();
            const second = await nextRequest(2);
            expect(applied).not.toHaveBeenCalled();
            expect(second.qps.pos).toBeUndefined();
            expect(second.body.room_subscriptions).toHaveProperty([roomId]);
            expect(sync.isRoomSubscriptionConfirmed(roomId)).toBe(false);
            sync.stop();
        });

        it("confirms a room switched back to an earlier subscription only once that is answered again", async () => {
            const { sync, nextRequest } = setup();
            sync.addCustomSubscription("pinned", pinned);
            sync.addCustomSubscription("channel", channel);
            sync.useCustomSubscription(roomId, "pinned");
            sync.modifyRoomSubscriptions(new Set([roomId]));
            (await nextRequest(1)).reply({ pos: "1" });
            await nextRequest(2);
            expect(sync.isRoomSubscriptionConfirmed(roomId)).toBe(true);

            sync.useCustomSubscription(roomId, "channel");
            sync.useCustomSubscription(roomId, "pinned");
            expect(sync.isRoomSubscriptionConfirmed(roomId)).toBe(false);
            sync.modifyRoomSubscriptions(new Set([roomId]));
            const third = await nextRequest(3);
            third.reply({ pos: "2" });
            await nextRequest(4);
            expect(sync.isRoomSubscriptionConfirmed(roomId)).toBe(true);
            sync.stop();
        });

        it("confirms a room on the default subscription again only once a changed default is answered", async () => {
            const { sync, nextRequest } = setup();
            sync.modifyRoomSubscriptions(new Set([roomId]));
            (await nextRequest(1)).reply({ pos: "1" });
            await nextRequest(2);
            expect(sync.isRoomSubscriptionConfirmed(roomId)).toBe(true);

            sync.modifyRoomSubscriptionInfo(pinned);
            expect(sync.isRoomSubscriptionConfirmed(roomId)).toBe(false);
            const third = await nextRequest(3);
            expect(third.body.room_subscriptions).toEqual({ [roomId]: pinned });
            third.reply({ pos: "2" });
            await nextRequest(4);
            expect(sync.isRoomSubscriptionConfirmed(roomId)).toBe(true);
            sync.stop();
        });

        it("takes a custom subscription added after a room asked for it as a change of the room's", async () => {
            const { sync, nextRequest } = setup();
            sync.useCustomSubscription(roomId, "pinned");
            sync.modifyRoomSubscriptions(new Set([roomId]));
            const first = await nextRequest(1);
            // Unknown until now, so the default was sent.
            expect(first.body.room_subscriptions).toEqual({ [roomId]: {} });
            first.reply({ pos: "1" });
            await nextRequest(2);
            expect(sync.isRoomSubscriptionConfirmed(roomId)).toBe(true);

            sync.addCustomSubscription("pinned", pinned);
            expect(sync.isRoomSubscriptionConfirmed(roomId)).toBe(false);
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
            // Changed afterwards, even the subscription itself: what the request carried stays as it was, frozen.
            sync.modifyRoomSubscriptions(new Set(["!other:example.org"]));
            pinned.timeline_limit = 1;
            pinned.required_state.push(["m.room.topic", ""]);
            try {
                const carried = sync.getRequestForResponse(response)?.roomSubscriptions.get(roomId);
                expect(carried).toEqual({ timeline_limit: 50, required_state: [["m.room.pinned_events", ""]] });
                expect(Object.isFrozen(carried)).toBe(true);
                expect(Object.isFrozen(carried?.required_state)).toBe(true);
            } finally {
                pinned.timeline_limit = 50;
                pinned.required_state.pop();
            }
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
                required_state: [...requiredState],
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
        /** Crypto callbacks that hold a room's encryption event until released, noting when they are reached. */
        const holdCrypto = (
            heldRoomId: string,
        ): { callbacks: SyncCryptoCallbacks; reached: () => boolean; release: () => void } => {
            const held = Promise.withResolvers<void>();
            let reached = false;
            const callbacks = {
                onCryptoEvent: async (room: { roomId: string }) => {
                    if (room.roomId !== heldRoomId) return;
                    reached = true;
                    await held.promise;
                },
                onSyncCompleted: () => {},
                preprocessToDeviceMessages: async (events: unknown[]) => events,
                processKeyCounts: async () => {},
                processSyncChanges: async () => [],
                onDeviceListsChanged: async () => {},
                markAllTrackedUsersAsDirty: async () => {},
            } as unknown as SyncCryptoCallbacks;
            return { callbacks, reached: () => reached, release: () => held.resolve() };
        };

        it("applies nothing more to a client stopped while a saved room waits on the crypto layer", async () => {
            const snapshot = many();
            snapshot.rooms[id(0)] = encrypted(id(0), 10);
            snapshot.roomAccountData = { [id(0)]: [{ type: "m.tag", content: { tags: { "u.work": {} } } }] };
            const crypto = holdCrypto(id(0));
            const { client, api, states } = setup(async () => snapshot, undefined, crypto.callbacks);
            const heard: string[] = [];
            client.on(ClientEvent.Event, (event) => heard.push(event.getId()!));
            // The crypto layer learns of the room's encryption before the room's state or events are added.
            await vi.waitFor(() => expect(crypto.reached()).toBe(true));
            api.stop();
            crypto.release();
            await new Promise((resolve) => setTimeout(resolve, 50));
            // The room's events, its account data and the other rooms never arrive.
            expect(heard).toEqual([]);
            expect(client.getRoom(id(0))?.getAccountData("m.tag")).toBeUndefined();
            expect(states).not.toContain(SyncState.Prepared);
            expect(client.getRooms()).toEqual([]);
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
            expect(crypto.reached()).toBe(true);
            api.stop();
            crypto.release();
            await new Promise((resolve) => setTimeout(resolve, 50));
            // The room, still waiting on the crypto layer when the client stopped, is never shown.
            expect(client.getRoom(id(1))).toBeNull();
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

describe("polls under sliding sync", () => {
    afterEach(() => vi.restoreAllMocks());

    const bob = "@bob:example.org";
    const pollStart = (id: string, ts: number): NonNullable<MSC3575RoomData["timeline"]>[number] => ({
        type: "org.matrix.msc3381.poll.start",
        sender: userId,
        room_id: roomId,
        event_id: id,
        origin_server_ts: ts,
        content: {
            "org.matrix.msc3381.poll.start": {
                question: { "org.matrix.msc1767.text": "Lunch?" },
                kind: "org.matrix.msc3381.poll.disclosed",
                max_selections: 1,
                answers: [
                    { "id": "yes", "org.matrix.msc1767.text": "Yes" },
                    { "id": "no", "org.matrix.msc1767.text": "No" },
                ],
            },
            "org.matrix.msc1767.text": "Lunch?",
        },
    });
    const vote = (id: string, poll: string, answer: string): NonNullable<MSC3575RoomData["timeline"]>[number] => ({
        type: "org.matrix.msc3381.poll.response",
        sender: bob,
        room_id: roomId,
        event_id: id,
        origin_server_ts: 10,
        content: {
            "m.relates_to": { rel_type: "m.reference", event_id: poll },
            "org.matrix.msc3381.poll.response": { answers: [answer] },
        },
    });

    async function setup(timeline: NonNullable<MSC3575RoomData["timeline"]>) {
        const client = makeClient();
        vi.spyOn(client, "relations").mockResolvedValue({ events: [], nextBatch: null, originalEvent: null });
        const sync = new SlidingSync("https://example.org", new Map(), {}, client, 1000);
        new SlidingSyncSdk(sync, client, { lazyLoadMembers: true }, { logger });
        const receive = async (data: Partial<MSC3575RoomData>): Promise<void> => {
            await sync.emitPromised(SlidingSyncEvent.RoomData, roomId, {
                required_state: [],
                timeline: [],
                ...data,
                name: "Room",
            });
        };
        await receive({ initial: true, required_state: [...requiredState], timeline });
        return { client, room: client.getRoom(roomId)!, receive };
    }

    it("counts a vote that arrives while the poll is shown", async () => {
        // As /sync v2 does, a poll's start and its responses are gathered from the timeline into the room's polls.
        const { room, receive } = await setup([pollStart("$poll", 1)]);
        const poll = room.polls.get("$poll");
        expect(poll).toBeDefined();
        const responses = await poll!.getResponses();
        expect(responses.getRelations()).toHaveLength(0);

        await receive({ timeline: [vote("$vote", "$poll", "yes")], num_live: 1 });

        expect(responses.getRelations().map((event) => event.getId())).toEqual(["$vote"]);
    });

    it("finds a poll in older history the server sends for a room it already showed", async () => {
        const { room, receive } = await setup([message("$latest", 5)]);
        expect(room.polls.size).toBe(0);

        // A larger timeline limit brings older events, before the one already shown.
        await receive({ timeline: [pollStart("$older", 1), message("$latest", 5)], expanded_timeline: true });

        expect(room.polls.has("$older")).toBe(true);
    });
});

describe("live locations", () => {
    it("gives a share that arrives as state the locations already in the timeline", async () => {
        // As when a listed room is opened: its latest events came with the list, its shares with its subscription.
        const client = makeClient();
        const sync = new SlidingSync("https://example.org", new Map(), {}, client, 1000);
        new SlidingSyncSdk(sync, client, { lazyLoadMembers: true }, { logger });
        const receive = async (data: Partial<MSC3575RoomData>): Promise<void> => {
            await sync.emitPromised(SlidingSyncEvent.RoomData, roomId, {
                required_state: [],
                timeline: [],
                ...data,
                name: "Room",
            });
        };
        const now = Date.now();
        const share = {
            type: M_BEACON_INFO.name,
            state_key: userId,
            sender: userId,
            room_id: roomId,
            event_id: "$share",
            origin_server_ts: now,
            content: ContentHelpers.makeBeaconInfoContent(3_600_000, true, "Walk", undefined, now),
        };
        const location = {
            type: M_BEACON.name,
            sender: userId,
            room_id: roomId,
            event_id: "$location",
            origin_server_ts: now,
            content: ContentHelpers.makeBeaconContent("geo:51.5,-0.1", now, "$share"),
        };
        await receive({ initial: true, required_state: [...requiredState], timeline: [share, location] });
        const room = client.getRoom(roomId)!;
        expect(room.currentState.beacons.size).toBe(0);

        await receive({ required_state: [share] });

        const [beacon] = room.currentState.beacons.values();
        expect(beacon?.beaconInfoId).toBe("$share");
        await vi.waitFor(() => expect(beacon.latestLocationEvent?.getId()).toBe("$location"));
    });

    it("does not give a location to a share that replaced the one it names while it was decrypted", async () => {
        const client = makeClient();
        const room = new Room(roomId, client, userId);
        const now = Date.now();
        const share = (eventId: string, start: number): MatrixEvent =>
            new MatrixEvent({
                type: M_BEACON_INFO.name,
                state_key: userId,
                sender: userId,
                room_id: roomId,
                event_id: eventId,
                origin_server_ts: start,
                content: ContentHelpers.makeBeaconInfoContent(3_600_000, true, "Walk", undefined, start),
            });
        room.currentState.setStateEvents([share("$first", now - 1000)]);
        const [beacon] = room.currentState.beacons.values();
        // The location for the first share takes a while to decrypt.
        const decrypted = Promise.withResolvers<void>();
        vi.spyOn(client, "decryptEventIfNeeded").mockReturnValue(decrypted.promise);
        const location = new MatrixEvent({
            type: M_BEACON.name,
            sender: userId,
            room_id: roomId,
            event_id: "$location",
            origin_server_ts: now + 10,
            content: ContentHelpers.makeBeaconContent("geo:51.5,-0.1", now + 10, "$first"),
        });
        const processing = room.currentState.processBeaconEvents([location], client);

        // A new share replaces the first, as the same person's share in the same room.
        room.currentState.setStateEvents([share("$second", now)]);
        decrypted.resolve();
        await processing;

        expect(beacon.beaconInfoId).toBe("$second");
        expect(beacon.latestLocationEvent).toBeUndefined();
    });

    it("reads a location update that follows another event in the same batch", async () => {
        // Sliding sync now hands each timeline to the beacon processing, as /sync v2 does, and a timeline mixes
        // locations with everything else.
        const client = makeClient();
        const room = new Room(roomId, client, userId);
        const now = Date.now();
        room.currentState.setStateEvents([
            new MatrixEvent({
                type: M_BEACON_INFO.name,
                state_key: userId,
                sender: userId,
                room_id: roomId,
                event_id: "$share",
                origin_server_ts: now,
                content: ContentHelpers.makeBeaconInfoContent(3_600_000, true, "Walk", undefined, now),
            }),
        ]);
        const [beacon] = room.currentState.beacons.values();
        expect(beacon).toBeDefined();

        const chat = new MatrixEvent({ ...message("$chat", now), room_id: roomId });
        const location = new MatrixEvent({
            type: M_BEACON.name,
            sender: userId,
            room_id: roomId,
            event_id: "$location",
            origin_server_ts: now,
            content: ContentHelpers.makeBeaconContent("geo:51.5,-0.1", now, "$share"),
        });
        await room.currentState.processBeaconEvents([chat, location], client);

        expect(beacon.latestLocationEvent?.getId()).toBe("$location");
    });
});

describe("a lost sliding sync connection", () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("is retried soon at first, then every 5 seconds, and reported from the third failure", async () => {
        // As /sync v2 does, so the room status bar says the connection is lost as promptly.
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        const client = makeClient();
        vi.spyOn(client, "getPushRules").mockResolvedValue({ global: {} } as never);
        const requests: number[] = [];
        vi.spyOn(client.http, "authedRequest").mockImplementation(((_method: unknown, path: unknown) => {
            if (String(path).includes("sync")) requests.push(Date.now());
            return Promise.reject(new MatrixError({ errcode: "M_UNKNOWN", error: "Server unwell" }, 500));
        }) as never);
        const states: SyncState[] = [];
        client.on(ClientEvent.Sync, (state) => states.push(state));
        const sync = new SlidingSync("https://example.org", new Map(), {}, client, 20_000);
        const api = new SlidingSyncSdk(sync, client, { lazyLoadMembers: true }, { logger });
        void api.sync();
        await vi.advanceTimersByTimeAsync(0);
        expect(requests).toHaveLength(1);
        const start = requests[0];

        await vi.advanceTimersByTimeAsync(2_000);
        expect(requests).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(4_000);
        expect(requests).toHaveLength(3);
        expect(states.filter((state) => state === SyncState.Reconnecting)).toHaveLength(2);
        expect(states.at(-1)).toBe(SyncState.Error);

        await vi.advanceTimersByTimeAsync(5_000);
        expect(requests).toHaveLength(4);
        expect(requests.map((at) => at - start)).toEqual([0, 2_000, 6_000, 11_000]);
        api.stop();
    });

    it("is reported when requests fail without an answer, such as with no connection", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        const client = makeClient();
        vi.spyOn(client, "getPushRules").mockResolvedValue({ global: {} } as never);
        vi.spyOn(client.http, "authedRequest").mockImplementation((() =>
            Promise.reject(new ConnectionError("Network unreachable"))) as never);
        const states: SyncState[] = [];
        client.on(ClientEvent.Sync, (state) => states.push(state));
        const sync = new SlidingSync("https://example.org", new Map(), {}, client, 20_000);
        const api = new SlidingSyncSdk(sync, client, { lazyLoadMembers: true }, { logger });
        void api.sync();
        await vi.advanceTimersByTimeAsync(6_000);
        expect(states).toEqual([SyncState.Reconnecting, SyncState.Reconnecting, SyncState.Error]);
        api.stop();
    });
});

describe("encrypted rooms under sliding sync", () => {
    afterEach(() => vi.restoreAllMocks());

    /** Encryption that, as MSC4362 lets a room choose, covers the room's state too. */
    const encryption = {
        type: EventType.RoomEncryption,
        state_key: "",
        sender: userId,
        event_id: "$encryption",
        origin_server_ts: 0,
        content: { "algorithm": "m.megolm.v1.aes-sha2", "io.element.msc4362.encrypt_state_events": true },
    };
    /** State encrypted as MSC4362 sends it: its type and state key packed into the state key. */
    const encryptedState = (eventId: string, packedKey: string): MSC3575RoomData["required_state"][number] => ({
        type: EventType.RoomMessageEncrypted,
        state_key: packedKey,
        sender: userId,
        event_id: eventId,
        origin_server_ts: 1,
        content: { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "secret", session_id: "session" },
    });
    /** The room's name, encrypted. */
    const encryptedName = (eventId: string): MSC3575RoomData["required_state"][number] =>
        encryptedState(eventId, `${EventType.RoomName}:`);

    function setup() {
        const client = makeClient();
        // What happened, in order: the crypto layer setting up the room, and the room's state changing.
        const order: string[] = [];
        client.on(RoomStateEvent.Events, (event) => order.push(`state ${event.getType()}`));
        const callbacks = {
            onCryptoEvent: async (_room: Room, event: MatrixEvent) => {
                await Promise.resolve();
                order.push(`crypto ${event.getType()}`);
            },
            onSyncCompleted: () => {},
            preprocessToDeviceMessages: async (events: unknown[]) => events,
            processKeyCounts: async () => {},
            processSyncChanges: async () => [],
            onDeviceListsChanged: async () => {},
            markAllTrackedUsersAsDirty: async () => {},
        } as unknown as SyncCryptoCallbacks;
        // Decrypts an event a moment later, as the crypto layer does: to the room's name, unless told otherwise. Until
        // it is given the key for `$undecryptable`, it cannot decrypt that event.
        const withheld = new Set(["$undecryptable"]);
        const clear = new Map<string, object>();
        const crypto = {
            decryptEvent: async (event: MatrixEvent) => {
                await new Promise((resolve) => setTimeout(resolve, 0));
                if (withheld.has(event.getId()!)) throw new Error("no key");
                const clearEvent = clear.get(event.getId()!) ?? {
                    type: EventType.RoomName,
                    state_key: "",
                    content: { name: "Secret plans" },
                };
                return { clearEvent };
            },
        } as unknown as Parameters<MatrixEvent["attemptDecryption"]>[0];
        // Every event the crypto layer was asked to decrypt.
        const decrypting: MatrixEvent[] = [];
        vi.spyOn(client, "decryptEventIfNeeded").mockImplementation((event) => {
            decrypting.push(event);
            if (event.shouldAttemptDecryption()) void event.attemptDecryption(crypto);
            return event.getDecryptionPromise() ?? Promise.resolve();
        });
        const sync = new SlidingSync("https://example.org", new Map(), {}, client, 1000);
        const api = new SlidingSyncSdk(sync, client, { lazyLoadMembers: true }, { logger, cryptoCallbacks: callbacks });
        // The server has no name to send for a room whose name is encrypted.
        const receive = async (data: Partial<MSC3575RoomData>): Promise<void> => {
            await sync.emitPromised(SlidingSyncEvent.RoomData, roomId, {
                required_state: [],
                timeline: [],
                ...data,
                name: "",
            });
        };
        /** The key for an event arrives, and the crypto layer tries the event again, as it does. */
        const keyArrives = async (event: MatrixEvent): Promise<void> => {
            withheld.delete(event.getId()!);
            await event.attemptDecryption(crypto, { isRetry: true });
        };
        return { api, client, order, receive, keyArrives, withheld, clear, decrypting };
    }

    it("sets up the room's encryption before its state says the room is encrypted", async () => {
        // As /sync v2 does: a new room's creator sends its name once the room is encrypted, and the name must then be
        // encrypted as the room asks, not sent in the clear.
        const { order, receive } = setup();

        await receive({ initial: true, required_state: [...requiredState, encryption] });

        const crypto = order.indexOf(`crypto ${EventType.RoomEncryption}`);
        expect(crypto).toBeGreaterThanOrEqual(0);
        expect(crypto).toBeLessThan(order.indexOf(`state ${EventType.RoomEncryption}`));
    });

    it("sets up encryption that arrives with the timeline before the room's state changes", async () => {
        const { order, receive } = setup();
        await receive({ initial: true, required_state: requiredState });

        await receive({ required_state: [encryption], timeline: [{ ...encryption, room_id: roomId }], num_live: 1 });

        expect(order.filter((entry) => entry.includes(EventType.RoomEncryption))).toEqual([
            `crypto ${EventType.RoomEncryption}`,
            `state ${EventType.RoomEncryption}`,
        ]);
    });

    it("adds an encrypted state event to the room's state under what it decrypts to", async () => {
        const { client, receive } = setup();

        await receive({ initial: true, required_state: [...requiredState, encryption, encryptedName("$name")] });

        const room = client.getRoom(roomId)!;
        expect(room.currentState.getStateEvents(EventType.RoomName, "")?.getId()).toBe("$name");
        expect(room.currentState.getStateEvents(EventType.RoomMessageEncrypted)).toEqual([]);
        expect(room.name).toBe("Secret plans");
    });

    it("decrypts a state event in the timeline before anyone hears of it", async () => {
        const { client, receive } = setup();
        await receive({ initial: true, required_state: [...requiredState, encryption] });
        const heard: string[] = [];
        client.on(ClientEvent.Event, (event) => heard.push(`${event.getId()} ${event.getType()}`));

        await receive({
            required_state: [encryptedName("$renamed")],
            timeline: [{ ...encryptedName("$renamed"), room_id: roomId }],
            num_live: 1,
        });

        expect(heard).toContain(`$renamed ${EventType.RoomName}`);
        const [live] = client.getRoom(roomId)!.getLiveTimeline().getEvents().slice(-1);
        expect(live.getId()).toBe("$renamed");
        expect(live.getType()).toBe(EventType.RoomName);
    });

    it("leaves a state event it cannot decrypt out of the room's state, and still tells listeners of it", async () => {
        const { client, receive } = setup();
        const heard: string[] = [];
        client.on(ClientEvent.Event, (event) => heard.push(event.getId()!));

        await receive({
            initial: true,
            required_state: [...requiredState, encryption, encryptedName("$undecryptable")],
        });

        const room = client.getRoom(roomId)!;
        // Undecrypted, it has neither a type nor a state key the room's state could file it under.
        expect(room.currentState.getStateEvents(EventType.RoomMessageEncrypted)).toEqual([]);
        expect(room.currentState.getStateEvents(EventType.RoomMessage)).toEqual([]);
        expect(room.currentState.getStateEvents(EventType.RoomName)).toEqual([]);
        expect(heard).toContain("$undecryptable");
    });

    it("adds a state event it could not decrypt to the room's state once its keys arrive", async () => {
        const { client, receive, keyArrives } = setup();
        const heard: MatrixEvent[] = [];
        client.on(ClientEvent.Event, (event) => heard.push(event));
        await receive({
            initial: true,
            required_state: [...requiredState, encryption, encryptedName("$undecryptable")],
        });
        const room = client.getRoom(roomId)!;
        expect(room.currentState.getStateEvents(EventType.RoomName)).toEqual([]);

        await keyArrives(heard.find((event) => event.getId() === "$undecryptable")!);

        expect(room.currentState.getStateEvents(EventType.RoomName, "")?.getId()).toBe("$undecryptable");
        expect(room.name).toBe("Secret plans");
    });

    it("keeps newer state over a state event whose keys arrive later", async () => {
        const { client, receive, keyArrives } = setup();
        const heard: MatrixEvent[] = [];
        client.on(ClientEvent.Event, (event) => heard.push(event));
        await receive({
            initial: true,
            required_state: [...requiredState, encryption, encryptedName("$undecryptable")],
        });
        const room = client.getRoom(roomId)!;

        // The room is renamed, and the new name can be decrypted, before the key for the old one arrives.
        await receive({ required_state: [encryptedName("$renamed")] });
        expect(room.currentState.getStateEvents(EventType.RoomName, "")?.getId()).toBe("$renamed");
        await keyArrives(heard.find((event) => event.getId() === "$undecryptable")!);

        expect(room.currentState.getStateEvents(EventType.RoomName, "")?.getId()).toBe("$renamed");
    });

    it("adds no state whose keys arrive after the client stopped", async () => {
        const { api, client, receive, keyArrives } = setup();
        const heard: MatrixEvent[] = [];
        client.on(ClientEvent.Event, (event) => heard.push(event));
        await receive({
            initial: true,
            required_state: [...requiredState, encryption, encryptedName("$undecryptable")],
        });

        api.stop();
        await keyArrives(heard.find((event) => event.getId() === "$undecryptable")!);

        expect(client.getRoom(roomId)!.currentState.getStateEvents(EventType.RoomName)).toEqual([]);
    });

    it("tells listeners of no more of a room's events once one of them stops the client", async () => {
        const { api, client, receive } = setup();
        const heard: string[] = [];
        client.on(ClientEvent.Event, (event) => {
            heard.push(event.getId()!);
            api.stop();
        });
        const decryptCriticalEvents = vi.spyOn(Room.prototype, "decryptCriticalEvents");

        await receive({ initial: true, required_state: [...requiredState, encryption], timeline: [message("$a", 1)] });

        expect(heard).toHaveLength(1);
        expect(decryptCriticalEvents).not.toHaveBeenCalled();
    });

    it("keeps an invitation's state over state whose keys arrive later", async () => {
        const { client, receive, keyArrives } = setup();
        const heard: MatrixEvent[] = [];
        client.on(ClientEvent.Event, (event) => heard.push(event));
        await receive({
            initial: true,
            required_state: [...requiredState, encryption, encryptedName("$undecryptable")],
        });

        // The user left, and is invited back: the invitation brings the room's state as it is now.
        await receive({
            invite_state: [
                {
                    type: EventType.RoomName,
                    state_key: "",
                    sender: userId,
                    event_id: "$invited",
                    origin_server_ts: 2,
                    content: { name: "Invited" },
                },
            ],
        });
        await keyArrives(heard.find((event) => event.getId() === "$undecryptable")!);

        expect(client.getRoom(roomId)!.currentState.getStateEvents(EventType.RoomName, "")?.getContent()).toEqual({
            name: "Invited",
        });
    });

    it("adds nothing once a listener told of the decryption first stops the client", async () => {
        const { api, client, receive, keyArrives } = setup();
        const heard: MatrixEvent[] = [];
        client.on(ClientEvent.Event, (event) => heard.push(event));
        await receive({
            initial: true,
            required_state: [...requiredState, encryption, encryptedName("$undecryptable")],
        });
        client.on(MatrixEventEvent.Decrypted, () => api.stop());

        await keyArrives(heard.find((event) => event.getId() === "$undecryptable")!);

        expect(client.getRoom(roomId)!.currentState.getStateEvents(EventType.RoomName)).toEqual([]);
    });

    it("stops waiting for the keys of a forgotten room's state", async () => {
        const { client, receive, keyArrives } = setup();
        const heard: MatrixEvent[] = [];
        client.on(ClientEvent.Event, (event) => heard.push(event));
        await receive({
            initial: true,
            required_state: [...requiredState, encryption, encryptedName("$undecryptable")],
        });
        const room = client.getRoom(roomId)!;
        const name = heard.find((event) => event.getId() === "$undecryptable")!;
        const listeners = name.listenerCount(MatrixEventEvent.Decrypted);

        client.store.removeRoom(roomId);
        client.emit(ClientEvent.DeleteRoom, roomId);

        // Nothing holds on to the forgotten room, which is not changed when the keys arrive.
        expect(name.listenerCount(MatrixEventEvent.Decrypted)).toBe(listeners - 1);
        await keyArrives(name);
        expect(room.currentState.getStateEvents(EventType.RoomName)).toEqual([]);
    });

    it("tells apart state whose type and state key join to the same text", async () => {
        // `org.example.foo` with state key `x:`, and `org.example.foo:x` with an empty state key, are packed alike.
        const { client, receive, keyArrives, clear } = setup();
        const heard: MatrixEvent[] = [];
        client.on(ClientEvent.Event, (event) => heard.push(event));
        clear.set("$undecryptable", { type: "org.example.foo", state_key: "x:", content: { first: true } });
        await receive({
            initial: true,
            required_state: [...requiredState, encryption, encryptedState("$undecryptable", "org.example.foo:x:")],
        });

        await receive({
            required_state: [
                {
                    type: "org.example.foo:x",
                    state_key: "",
                    sender: userId,
                    event_id: "$other",
                    origin_server_ts: 2,
                    content: {},
                },
            ],
        });
        await keyArrives(heard.find((event) => event.getId() === "$undecryptable")!);

        const room = client.getRoom(roomId)!;
        expect(room.currentState.getStateEvents("org.example.foo", "x:")?.getId()).toBe("$undecryptable");
        expect(room.currentState.getStateEvents("org.example.foo:x", "")?.getId()).toBe("$other");
    });

    it("adds state whose keys arrive while its room is first being added", async () => {
        const { client, receive, keyArrives, decrypting } = setup();
        // The keys arrive while the room's events are being added, before the room is stored.
        const addLiveEvents = Room.prototype.addLiveEvents;
        vi.spyOn(Room.prototype, "addLiveEvents").mockImplementation(async function (
            this: Room,
            ...args: Parameters<Room["addLiveEvents"]>
        ) {
            const name = decrypting.find((event) => event.getId() === "$undecryptable");
            if (name?.isDecryptionFailure()) await keyArrives(name);
            return addLiveEvents.apply(this, args);
        });

        await receive({
            initial: true,
            required_state: [...requiredState, encryption, encryptedName("$undecryptable")],
            timeline: [{ ...message("$a", 1), room_id: roomId }],
        });

        expect(client.getRoom(roomId)!.currentState.getStateEvents(EventType.RoomName, "")?.getId()).toBe(
            "$undecryptable",
        );
    });

    it("gives a live location share decrypted once its keys arrive the locations already in the timeline", async () => {
        const { client, receive, keyArrives, withheld, clear, decrypting } = setup();
        const now = Date.now();
        withheld.add("$share");
        clear.set("$share", {
            type: M_BEACON_INFO.name,
            state_key: userId,
            content: ContentHelpers.makeBeaconInfoContent(3_600_000, true, "Walk", undefined, now),
        });
        const location = {
            type: M_BEACON.name,
            sender: userId,
            room_id: roomId,
            event_id: "$location",
            origin_server_ts: now,
            content: ContentHelpers.makeBeaconContent("geo:51.5,-0.1", now, "$share"),
        };
        await receive({
            initial: true,
            required_state: [...requiredState, encryption, encryptedState("$share", `${M_BEACON_INFO.name}:${userId}`)],
            timeline: [location],
        });
        const room = client.getRoom(roomId)!;
        expect(room.currentState.beacons.size).toBe(0);

        await keyArrives(decrypting.find((event) => event.getId() === "$share")!);

        const [beacon] = room.currentState.beacons.values();
        expect(beacon?.beaconInfoId).toBe("$share");
        await vi.waitFor(() => expect(beacon.latestLocationEvent?.getId()).toBe("$location"));
    });

    it("lets go of a room that could not be added, changing nothing of it when its keys arrive", async () => {
        const { client, receive, keyArrives, decrypting } = setup();
        // Adding the room's events fails, before the room is stored.
        const addLiveEvents = vi.spyOn(Room.prototype, "addLiveEvents").mockRejectedValueOnce(new Error("broken"));
        await receive({
            initial: true,
            required_state: [...requiredState, encryption, encryptedName("$undecryptable")],
            timeline: [{ ...message("$a", 1), room_id: roomId }],
        });
        const orphan = addLiveEvents.mock.contexts[0] as Room;
        expect(orphan).toBeInstanceOf(Room);
        expect(client.getRoom(roomId)).toBeNull();

        await keyArrives(decrypting.find((event) => event.getId() === "$undecryptable")!);

        expect(orphan.currentState.getStateEvents(EventType.RoomName)).toEqual([]);
    });

    describe("given encrypted and plain state for the same in one response", () => {
        // In a room that encrypts its state, the encrypted event is the one to trust.
        const plainName = {
            type: EventType.RoomName,
            state_key: "",
            sender: userId,
            event_id: "$plain",
            origin_server_ts: 2,
            content: { name: "Plain" },
        };
        const both = (encryptedId: string, encryptedFirst: boolean): MSC3575RoomData["required_state"] =>
            encryptedFirst ? [encryptedName(encryptedId), plainName] : [plainName, encryptedName(encryptedId)];

        it.each([true, false])(
            "keeps the encrypted one when its keys are here (encrypted first: %s)",
            async (first) => {
                const { client, receive } = setup();

                await receive({
                    initial: true,
                    required_state: [...requiredState, encryption, ...both("$name", first)],
                });

                expect(client.getRoom(roomId)!.currentState.getStateEvents(EventType.RoomName, "")?.getId()).toBe(
                    "$name",
                );
            },
        );

        it.each([true, false])("keeps the encrypted one once its keys arrive (encrypted first: %s)", async (first) => {
            const { client, receive, keyArrives, decrypting } = setup();
            await receive({
                initial: true,
                required_state: [...requiredState, encryption, ...both("$undecryptable", first)],
            });
            const room = client.getRoom(roomId)!;
            expect(room.currentState.getStateEvents(EventType.RoomName, "")?.getId()).toBe("$plain");

            await keyArrives(decrypting.find((event) => event.getId() === "$undecryptable")!);

            expect(room.currentState.getStateEvents(EventType.RoomName, "")?.getId()).toBe("$undecryptable");
        });
    });
});
