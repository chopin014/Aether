/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
    ClientEvent,
    ConditionKind,
    EventType,
    type IPushRules,
    MatrixEvent,
    type MatrixClient,
    NotificationCountType,
    PushRuleActionName,
    PushRuleKind,
    ReceiptType,
    Room,
    RoomEvent,
    TweakName,
} from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";
import {
    SlidingSync,
    SlidingSyncEvent,
    SlidingSyncState,
    type MSC3575RoomData,
    type MSC3575SlidingSyncResponse,
} from "matrix-js-sdk/src/sliding-sync";
// These tests cover how the engine works with the SDK's sliding sync, so they use the real implementation.
// oxlint-disable-next-line no-restricted-imports
import { SlidingSyncSdk } from "matrix-js-sdk/src/sliding-sync-sdk";

import { createClientWithCreds } from "../../utils/createMatrixClient";
import { NotificationCountEngine } from "./NotificationCountEngine";
import { CountConfidence } from "./RoomCountLedger";

const roomId = "!room:example.org";
const me = "@alice:example.org";
const bob = "@bob:example.org";

type TimelineEvent = NonNullable<MSC3575RoomData["timeline"]>[number];

function message(id: string, body = id, sender = bob, extra: Record<string, unknown> = {}): TimelineEvent {
    return {
        type: EventType.RoomMessage,
        sender,
        room_id: roomId,
        event_id: id,
        origin_server_ts: 1,
        content: { msgtype: "m.text", body, ...extra },
    };
}

function reply(id: string, root: string): TimelineEvent {
    return message(id, id, bob, { "m.relates_to": { rel_type: "m.thread", event_id: root } });
}

const requiredState: MSC3575RoomData["required_state"] = [
    { type: EventType.RoomCreate, state_key: "", sender: me, event_id: "$create", origin_server_ts: 0, content: {} },
    {
        type: EventType.RoomMember,
        state_key: me,
        sender: me,
        event_id: "$member",
        origin_server_ts: 0,
        content: { membership: "join" },
    },
];

/** Every message notifies; one that says "alice" highlights too. */
const pushRules: IPushRules = {
    global: {
        [PushRuleKind.Override]: [
            {
                rule_id: ".m.rule.contains_display_name",
                default: true,
                enabled: true,
                conditions: [{ kind: ConditionKind.ContainsDisplayName }],
                actions: [PushRuleActionName.Notify, { set_tweak: TweakName.Highlight }],
            },
        ],
        [PushRuleKind.ContentSpecific]: [
            {
                rule_id: "alice",
                default: false,
                enabled: true,
                pattern: "alice",
                actions: [PushRuleActionName.Notify, { set_tweak: TweakName.Highlight }],
            },
        ],
        [PushRuleKind.RoomSpecific]: [],
        [PushRuleKind.SenderSpecific]: [],
        [PushRuleKind.Underride]: [
            {
                rule_id: ".m.rule.message",
                default: true,
                enabled: true,
                conditions: [{ kind: ConditionKind.EventMatch, key: "type", pattern: "m.room.message" }],
                actions: [PushRuleActionName.Notify],
            },
        ],
    },
};

function receipt(eventId: string, threadId?: string, type = ReceiptType.Read): MatrixEvent {
    return new MatrixEvent({
        type: EventType.Receipt,
        room_id: roomId,
        content: { [eventId]: { [type]: { [me]: { ts: 1, ...(threadId ? { thread_id: threadId } : {}) } } } },
    });
}

describe("NotificationCountEngine", () => {
    const stops: Array<() => void> = [];
    afterEach(() => {
        stops.splice(0).forEach((stop) => stop());
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    async function setup() {
        const client: MatrixClient = createClientWithCreds({
            homeserverUrl: "https://example.org",
            userId: me,
            accessToken: "token",
        });
        client.setPushRules(pushRules);
        const sync = new SlidingSync("https://example.org", new Map(), {}, client, 1000);
        const api = new SlidingSyncSdk(sync, client, { lazyLoadMembers: true }, { logger });
        const engine = new NotificationCountEngine(client, sync);
        engine.start();
        stops.push(() => {
            engine.stop();
            api.stop();
        });

        /** One sync response for the room: its timeline, then its receipts, as the server sends them. */
        const respond = async (
            data: Partial<MSC3575RoomData>,
            receipts: MatrixEvent[] = [],
            { pauseBeforeReceipts = false } = {},
        ): Promise<void> => {
            const roomData: MSC3575RoomData = { required_state: [], timeline: [], ...data, name: "Room" };
            const response: MSC3575SlidingSyncResponse = {
                pos: "1",
                lists: {},
                rooms: { [roomId]: roomData },
                extensions: {},
            };
            sync.emit(SlidingSyncEvent.Lifecycle, SlidingSyncState.RequestFinished, response);
            await sync.emitPromised(SlidingSyncEvent.RoomData, roomId, roomData);
            sync.emit(SlidingSyncEvent.Lifecycle, SlidingSyncState.Complete, response);
            // Applying a response can take a while; other work runs meanwhile.
            if (pauseBeforeReceipts) await new Promise((resolve) => setTimeout(resolve, 0));
            const room = client.getRoom(roomId)!;
            for (const event of receipts) room.addReceipt(event);
            sync.emit(SlidingSyncEvent.Applied, response);
        };
        const counts = () => {
            const room = client.getRoom(roomId)!;
            return {
                total: room.getRoomUnreadNotificationCount(NotificationCountType.Total),
                highlight: room.getRoomUnreadNotificationCount(NotificationCountType.Highlight),
            };
        };
        /** Let the engine publish what is not tied to a sync response. */
        const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
        return { client, sync, engine, respond, counts, settle };
    }

    it("counts the messages after the user's receipt, ignoring the server's dummy counts", async () => {
        const { respond, counts, engine } = await setup();

        await respond(
            {
                initial: true,
                required_state: requiredState,
                timeline: [message("$a"), message("$b"), message("$c", "hi alice")],
                notification_count: 0,
                highlight_count: 0,
            },
            [receipt("$a")],
        );

        expect(counts()).toEqual({ total: 2, highlight: 1 });
        expect(engine.getCounts(roomId)?.main.confidence).toBe(CountConfidence.Exact);
    });

    it("publishes a response's counts only once its receipts are applied too", async () => {
        const { client, respond } = await setup();
        await respond({ initial: true, required_state: requiredState, timeline: [message("$a"), message("$b")] }, [
            receipt("$b"),
        ]);
        const changes: number[] = [];
        client.getRoom(roomId)!.on(RoomEvent.UnreadNotifications, (counts) => changes.push(counts?.total ?? -1));

        await respond({ timeline: [message("$c")] }, [receipt("$c")], { pauseBeforeReceipts: true });

        // The new message never shows as unread: it was read in the same response.
        expect(changes).toEqual([]);
    });

    it("counts nothing for certain in a room restored from this device until the server sends its receipts", async () => {
        const { client, respond, counts, engine, settle } = await setup();
        const room = new Room(roomId, client, me);
        room.updateMyMembership("join");
        client.store.storeRoom(room);

        // The receipts saved with it may not have been all there were.
        engine.onSyncTimeline(room, [new MatrixEvent(message("$a"))], {
            limited: false,
            initial: true,
            expanded: false,
            fromSnapshot: true,
        });
        engine.onSavedRoomApplied(room);
        await settle();
        expect(counts()).toEqual({ total: 0, highlight: 0 });
        expect(engine.getCounts(roomId)?.main.confidence).toBe(CountConfidence.Unknown);

        await respond({ initial: true, required_state: requiredState, timeline: [message("$a")] }, []);
        expect(counts()).toEqual({ total: 1, highlight: 0 });
    });

    it("gives a lower bound for a room never read, as the join is older than what is known", async () => {
        const { respond, counts, engine } = await setup();

        await respond({ initial: true, required_state: requiredState, timeline: [message("$a")] });

        expect(counts()).toEqual({ total: 1, highlight: 0 });
        expect(engine.getCounts(roomId)?.main.confidence).toBe(CountConfidence.LowerBound);
    });

    it("adds new messages as they arrive, and clears them when the user reads", async () => {
        const { client, respond, counts, settle } = await setup();
        await respond({ initial: true, required_state: requiredState, timeline: [message("$a")] }, [receipt("$a")]);
        expect(counts()).toEqual({ total: 0, highlight: 0 });

        await respond({ timeline: [message("$b")] });
        await respond({ timeline: [message("$c", "alice?")] });
        expect(counts()).toEqual({ total: 2, highlight: 1 });

        // Read on this device: the local echo of the receipt is enough.
        const room = client.getRoom(roomId)!;
        room.addLocalEchoReceipt(me, room.findEventById("$c")!, ReceiptType.Read, true);
        await settle();
        expect(counts()).toEqual({ total: 0, highlight: 0 });
    });

    it("spreads the evaluation of a long backlog over several tasks", async () => {
        const { respond, counts, settle } = await setup();
        // Each look at the clock is a millisecond later, so every pass soon runs out of time.
        let now = 0;
        vi.spyOn(performance, "now").mockImplementation(() => ++now);
        const timeline = Array.from({ length: 60 }, (_, i) => message(`$m${i}`));

        await respond({ initial: true, required_state: requiredState, timeline }, [receipt("$m0")]);
        // Not published half evaluated.
        expect(counts().total).toBe(0);

        for (let i = 0; i < 10 && counts().total === 0; i++) await settle();
        expect(counts().total).toBe(59);
    });

    it("stops counting at the user's own message", async () => {
        const { respond, counts } = await setup();

        await respond(
            {
                initial: true,
                required_state: requiredState,
                timeline: [message("$a"), message("$mine", "reply", me), message("$b")],
            },
            [],
        );

        expect(counts()).toEqual({ total: 1, highlight: 0 });
    });

    it("gives a lower bound across a gap, and an exact count once history fills it", async () => {
        const { client, respond, counts, engine } = await setup();
        await respond({ initial: true, required_state: requiredState, timeline: [message("$a")] }, [receipt("$a")]);

        await respond({ limited: true, prev_batch: "gap", timeline: [message("$d")] });
        expect(counts()).toEqual({ total: 1, highlight: 0 });
        expect(engine.getCounts(roomId)?.main.confidence).toBe(CountConfidence.LowerBound);

        const room = client.getRoom(roomId)!;
        vi.spyOn(client, "createMessagesRequest").mockResolvedValue({
            chunk: [message("$c", "alice"), message("$b"), message("$a")],
            start: "gap",
            end: "older",
        });
        await client.paginateEventTimeline(room.getLiveTimeline(), { backwards: true, limit: 3 });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(counts()).toEqual({ total: 3, highlight: 1 });
        expect(engine.getCounts(roomId)?.main.confidence).toBe(CountConfidence.Exact);
    });

    it("counts thread replies in their thread", async () => {
        const { client, respond, engine } = await setup();

        await respond(
            {
                initial: true,
                required_state: requiredState,
                timeline: [message("$root"), reply("$r1", "$root"), message("$m"), reply("$r2", "$root")],
            },
            [receipt("$m", "main"), receipt("$r1", "$root")],
        );

        const room = client.getRoom(roomId)!;
        expect(room.getRoomUnreadNotificationCount(NotificationCountType.Total)).toBe(0);
        expect(room.getThreadUnreadNotificationCount("$root", NotificationCountType.Total)).toBe(1);
        expect(room.getUnreadNotificationCount(NotificationCountType.Total)).toBe(1);
        expect(engine.getCounts(roomId)?.threads.get("$root")?.confidence).toBe(CountConfidence.Exact);
    });

    it("stops counting a redacted message", async () => {
        const { client, respond, counts, settle } = await setup();
        await respond({ initial: true, required_state: requiredState, timeline: [message("$a"), message("$b")] }, [
            receipt("$a"),
        ]);
        expect(counts().total).toBe(1);

        const redaction = new MatrixEvent({
            type: EventType.RoomRedaction,
            sender: bob,
            room_id: roomId,
            event_id: "$redaction",
            redacts: "$b",
            content: { redacts: "$b" },
        });
        await client.getRoom(roomId)!.addLiveEvents([redaction], { addToState: false });
        await settle();

        expect(counts().total).toBe(0);
    });

    it("evaluates every message again when the push rules change", async () => {
        const { client, respond, counts, settle } = await setup();
        await respond({ initial: true, required_state: requiredState, timeline: [message("$a"), message("$b")] }, [
            receipt("$a"),
        ]);
        expect(counts().total).toBe(1);

        const silent: IPushRules = { global: { ...pushRules.global, [PushRuleKind.Underride]: [] } };
        client.setPushRules(silent);
        client.emit(ClientEvent.AccountData, new MatrixEvent({ type: EventType.PushRules, content: silent }));
        await settle();

        expect(counts().total).toBe(0);
    });

    it("counts an encrypted message once it is decrypted", async () => {
        const { client, respond, counts, engine, settle } = await setup();
        vi.spyOn(client, "decryptEventIfNeeded").mockResolvedValue();
        await respond(
            {
                initial: true,
                required_state: requiredState,
                timeline: [
                    message("$a"),
                    {
                        type: EventType.RoomMessageEncrypted,
                        sender: bob,
                        room_id: roomId,
                        event_id: "$secret",
                        origin_server_ts: 1,
                        content: { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "x" },
                    },
                ],
            },
            [receipt("$a")],
        );
        expect(counts()).toEqual({ total: 0, highlight: 0 });
        expect(engine.getCounts(roomId)?.main.confidence).toBe(CountConfidence.Unknown);

        const event = client.getRoom(roomId)!.findEventById("$secret")!;
        // A stand-in for the crypto backend: only its decryption is used.
        const crypto = {
            decryptEvent: async () => ({
                clearEvent: { type: EventType.RoomMessage, content: { msgtype: "m.text", body: "hello alice" } },
            }),
        } as unknown as Parameters<MatrixEvent["attemptDecryption"]>[0];
        await event.attemptDecryption(crypto);
        await settle();

        expect(counts()).toEqual({ total: 1, highlight: 1 });
        expect(engine.getCounts(roomId)?.main.confidence).toBe(CountConfidence.Exact);
    });

    it("applies a redaction of an event the room no longer has, such as one from before a gap", async () => {
        const { respond, counts, engine } = await setup();
        await respond({ initial: true, required_state: requiredState, timeline: [message("$a"), message("$b")] }, [
            receipt("$a"),
        ]);
        // The room starts its timeline again at $d; the ledger keeps $b, as last seen.
        await respond({ limited: true, prev_batch: "gap", timeline: [message("$d")] });
        expect(counts().total).toBe(2);
        expect(engine.getCounts(roomId)?.main.confidence).toBe(CountConfidence.LastKnown);

        const redaction: TimelineEvent = {
            type: EventType.RoomRedaction,
            sender: bob,
            room_id: roomId,
            event_id: "$redaction",
            origin_server_ts: 1,
            // Where room version 11 has it.
            content: { redacts: "$b" },
        };
        await respond({ timeline: [redaction] });

        expect(counts().total).toBe(1);
    });

    it("evaluates a room's messages again when what the push rules read about it changes", async () => {
        const { respond, counts } = await setup();
        const named = (name: string, id: string): MSC3575RoomData["required_state"][number] => ({
            type: EventType.RoomMember,
            state_key: me,
            sender: me,
            event_id: id,
            origin_server_ts: 1,
            content: { membership: "join", displayname: name },
        });
        await respond(
            {
                initial: true,
                required_state: [...requiredState.slice(0, 1), named("Al", "$named")],
                timeline: [message("$a"), message("$b", "hello Bobby")],
            },
            [receipt("$a")],
        );
        expect(counts()).toEqual({ total: 1, highlight: 0 });

        // The user's name in the room becomes one the message mentions.
        await respond({ required_state: [named("Bobby", "$renamed")] });

        expect(counts()).toEqual({ total: 1, highlight: 1 });
    });

    it("asks to decrypt an event once, not again on every pass", async () => {
        const { client, respond, counts, settle } = await setup();
        const decrypt = vi.spyOn(client, "decryptEventIfNeeded").mockResolvedValue();
        const encrypted = (id: string): TimelineEvent => ({
            type: EventType.RoomMessageEncrypted,
            sender: bob,
            room_id: roomId,
            event_id: id,
            origin_server_ts: 1,
            content: { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "x" },
        });
        await respond(
            {
                initial: true,
                required_state: requiredState,
                timeline: [message("$a"), message("$b"), encrypted("$x"), encrypted("$y")],
            },
            [receipt("$a")],
        );
        const asked = decrypt.mock.calls.filter(([event]) => ["$x", "$y"].includes(event.getId()!)).length;
        await respond({ timeline: [message("$c")] });
        await settle();

        expect(decrypt.mock.calls.filter(([event]) => ["$x", "$y"].includes(event.getId()!))).toHaveLength(asked);
        expect(counts().total).toBe(2);
    });

    it("clears the counts of a room the user leaves", async () => {
        const { client, respond, counts } = await setup();
        await respond({ initial: true, required_state: requiredState, timeline: [message("$a")] }, []);
        expect(counts().total).toBe(1);

        client.getRoom(roomId)!.updateMyMembership("leave");

        expect(counts().total).toBe(0);
        expect(client.hasLocalNotificationCounts()).toBe(true);
    });

    it("lets go of the client when stopped", async () => {
        const { client, engine } = await setup();
        engine.stop();

        expect(client.getRoomHistoryObserver()).toBeUndefined();
    });
});
