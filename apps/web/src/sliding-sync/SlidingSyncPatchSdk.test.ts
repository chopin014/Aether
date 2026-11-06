/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { EventTimeline, EventType, MatrixError, RoomEvent, type MatrixClient } from "matrix-js-sdk/src/matrix";
import { type QueryDict } from "matrix-js-sdk/src/utils";
import { logger } from "matrix-js-sdk/src/logger";
import {
    ExtensionState,
    SlidingSync,
    SlidingSyncEvent,
    type Extension,
    type MSC3575RoomData,
    type MSC3575SlidingSyncResponse,
} from "matrix-js-sdk/src/sliding-sync";
// These tests cover Aether's patch to the SDK's sliding sync, so they use the real implementation.
// oxlint-disable-next-line no-restricted-imports
import { SlidingSyncSdk } from "matrix-js-sdk/src/sliding-sync-sdk";

import { createClientWithCreds } from "../utils/createMatrixClient";

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
