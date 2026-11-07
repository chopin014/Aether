/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
    type AnyMemberCountCondition,
    ClientEvent,
    ConditionKind,
    EventTimeline,
    EventType,
    type IPushRule,
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
    type SlidingSyncSnapshot,
} from "matrix-js-sdk/src/sliding-sync";
// These tests cover how the engine works with the SDK's sliding sync, so they use the real implementation.
// oxlint-disable-next-line no-restricted-imports
import { SlidingSyncSdk } from "matrix-js-sdk/src/sliding-sync-sdk";

import { createClientWithCreds } from "../../utils/createMatrixClient";
import { type CountRecoveryLimits } from "./CountRecovery";
import { NotificationCountEngine } from "./NotificationCountEngine";
import { CountConfidence, RoomCountLedger, type SavedLedger } from "./RoomCountLedger";

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

/** No history is fetched to fill gaps, but where a test asks for it. */
const NO_RECOVERY = { sessionPages: 0 };

describe("NotificationCountEngine", () => {
    const stops: Array<() => void> = [];
    afterEach(() => {
        stops.splice(0).forEach((stop) => stop());
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    async function setup(recovery: Partial<CountRecoveryLimits> = NO_RECOVERY) {
        const client: MatrixClient = createClientWithCreds({
            homeserverUrl: "https://example.org",
            userId: me,
            accessToken: "token",
        });
        client.setPushRules(pushRules);
        const sync = new SlidingSync("https://example.org", new Map(), {}, client, 1000);
        const api = new SlidingSyncSdk(sync, client, { lazyLoadMembers: true }, { logger });
        const engine = new NotificationCountEngine(client, sync, recovery);
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
        /** A sync response without this room. */
        const respondWithoutRoom = (): void => {
            const response: MSC3575SlidingSyncResponse = { pos: "1", lists: {}, rooms: {}, extensions: {} };
            sync.emit(SlidingSyncEvent.Lifecycle, SlidingSyncState.RequestFinished, response);
            sync.emit(SlidingSyncEvent.Lifecycle, SlidingSyncState.Complete, response);
            sync.emit(SlidingSyncEvent.Applied, response);
        };
        return { client, sync, engine, respond, respondWithoutRoom, counts, settle };
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

    it("fetches a little history to fill a gap by itself, once sync is live", async () => {
        const { client, respond, counts, engine } = await setup({ pagesPerGap: 2 });
        const request = vi.spyOn(client, "createMessagesRequest").mockResolvedValue({
            chunk: [message("$c", "alice"), message("$b"), message("$a")],
            start: "gap",
            end: "older",
        });
        await respond({ initial: true, required_state: requiredState, timeline: [message("$a")] }, [receipt("$a")]);

        // A sync that skipped $b and $c.
        await respond({ limited: true, prev_batch: "gap", timeline: [message("$d")] });

        await vi.waitFor(() => expect(engine.getCounts(roomId)?.main.confidence).toBe(CountConfidence.Exact));
        expect(counts()).toEqual({ total: 3, highlight: 1 });
        expect(request).toHaveBeenCalledTimes(1);
        expect(request).toHaveBeenCalledWith(roomId, "gap", 50, "b");
        // The history went to the counts only, not to the room's timeline.
        expect(client.getRoom(roomId)!.findEventById("$b")).toBeUndefined();
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

        const before = new MatrixEvent({ type: EventType.PushRules, content: pushRules });
        // The same rules again, as on a new connection: nothing is evaluated again.
        const evaluate = vi.spyOn(client.pushProcessor, "actionsForEvent");
        client.emit(
            ClientEvent.AccountData,
            new MatrixEvent({ type: EventType.PushRules, content: pushRules }),
            before,
        );
        await settle();
        expect(evaluate).not.toHaveBeenCalled();

        const silent: IPushRules = { global: { ...pushRules.global, [PushRuleKind.Underride]: [] } };
        client.setPushRules(silent);
        client.emit(ClientEvent.AccountData, new MatrixEvent({ type: EventType.PushRules, content: silent }), before);
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

    it("does not place a receipt made here for an event sync has not brought, until sync brings it", async () => {
        const { client, respond, respondWithoutRoom, counts, engine, settle } = await setup();
        await respond(
            { initial: true, required_state: requiredState, timeline: [message("$a"), message("$b"), message("$c")] },
            [receipt("$a")],
        );
        expect(counts().total).toBe(2);

        // Read on this device up to a newer message opened from a link, which sync has not brought yet.
        const room = client.getRoom(roomId)!;
        room.addLocalEchoReceipt(me, new MatrixEvent(message("$n")), ReceiptType.Read, true);
        await settle();
        expect(counts().total).toBe(0);
        expect(engine.getCounts(roomId)?.main.confidence).toBe(CountConfidence.Unknown);

        // Neither a response made before the receipt reached the server, nor one without this room, places it.
        await respond({ timeline: [message("$d")] });
        respondWithoutRoom();
        await settle();
        expect(counts().total).toBe(0);
        expect(engine.getCounts(roomId)?.main.confidence).toBe(CountConfidence.Unknown);

        // Nor do the user's own messages, even more of them at once than are kept of receipts made here.
        await respond({ timeline: [1, 2, 3, 4, 5].map((i) => message(`$mine${i}`, "hello", me)) });
        expect(engine.getCounts(roomId)?.main.confidence).toBe(CountConfidence.Unknown);

        // Sync brings it, with the server's echo of the receipt: everything up to it is read.
        await respond({ timeline: [message("$n")] }, [receipt("$n")]);
        expect(counts().total).toBe(0);
        expect(engine.getCounts(roomId)?.main.confidence).toBe(CountConfidence.Exact);
    });

    it("takes marking a room read at the user's own last message as reading its threads too", async () => {
        const { client, respond, engine, settle } = await setup();
        await respond(
            {
                initial: true,
                required_state: requiredState,
                timeline: [message("$root"), reply("$r1", "$root"), message("$mine", "hello", me)],
            },
            [receipt("$root", "main")],
        );
        expect(engine.getCounts(roomId)?.threads.get("$root")?.total).toBe(1);

        // As "mark as read" does: a receipt without a thread, for the last message, the user's own.
        const room = client.getRoom(roomId)!;
        room.addLocalEchoReceipt(me, room.findEventById("$mine")!, ReceiptType.Read, true);
        await settle();

        expect(engine.getCounts(roomId)?.threads.get("$root")?.total).toBe(0);
        expect(room.getThreadUnreadNotificationCount("$root", NotificationCountType.Total)).toBe(0);
    });

    it("ignores the receipts the SDK makes up for the user's own events, including in a thread's history", async () => {
        const { client, respond, counts, engine, settle } = await setup();
        await respond({ initial: true, required_state: requiredState, timeline: [message("$root"), message("$b")] }, [
            receipt("$root"),
        ]);
        const room = client.getRoom(roomId)!;
        const made: Array<{ synthetic?: boolean; implicit?: boolean }> = [];
        room.on(RoomEvent.Receipt, (_event, _room, synthetic, implicit) => made.push({ synthetic, implicit }));

        // Replies of the user's in the thread, more than receipts made here are kept for, loaded forwards as the
        // thread's history: the SDK makes a receipt up for each before the events reach the thread.
        const thread = room.createThread("$root", room.findEventById("$root"), [], true);
        const replies = Array.from({ length: 6 }, (_, i) => ({
            ...message(`$mine${i}`, "hello", me, { "m.relates_to": { rel_type: "m.thread", event_id: "$root" } }),
            origin_server_ts: 10 + i,
        }));
        vi.spyOn(client, "fetchRelations").mockResolvedValue({ chunk: replies } as never);
        // As for a thread opened at an older reply.
        const older = thread.timelineSet.addTimeline();
        older.setPaginationToken("later", EventTimeline.FORWARDS);
        await client.paginateEventTimeline(older, { backwards: false, limit: 6 });
        await settle();

        expect(made.length).toBeGreaterThan(0);
        expect(made.every(({ synthetic, implicit }) => synthetic && implicit)).toBe(true);
        expect(counts().total).toBe(1);
        expect(engine.getCounts(roomId)?.main.confidence).toBe(CountConfidence.Exact);
        expect(engine.getCounts(roomId)?.threads.get("$root")?.confidence ?? CountConfidence.Exact).not.toBe(
            CountConfidence.Unknown,
        );
    });

    it("lets the server's receipt take the place of one made here that it did not keep", async () => {
        const { client, respond, counts, engine, settle } = await setup();
        await respond(
            { initial: true, required_state: requiredState, timeline: [message("$a"), message("$b"), message("$c")] },
            [receipt("$b")],
        );
        const room = client.getRoom(roomId)!;
        // Read here up to an old message opened from a link: the server keeps its newer receipt.
        room.addLocalEchoReceipt(me, new MatrixEvent(message("$old")), ReceiptType.Read, true);
        // The user's own messages meanwhile do not hold it up.
        await respond({ timeline: [message("$mine", "hello", me)] });
        await settle();
        expect(engine.getCounts(roomId)?.main.confidence).toBe(CountConfidence.Unknown);

        await respond({ timeline: [message("$d")] }, [receipt("$b")]);
        expect(counts().total).toBe(1);
        expect(engine.getCounts(roomId)?.main.confidence).toBe(CountConfidence.Exact);
    });

    it("evaluates a room's messages again when its member count changes what the push rules match", async () => {
        const { client, respond, counts } = await setup();
        // Messages notify only in rooms of two, as with the default rule for direct messages.
        client.setPushRules({
            global: {
                ...pushRules.global,
                [PushRuleKind.Underride]: [
                    {
                        rule_id: ".m.rule.room_one_to_one",
                        default: true,
                        enabled: true,
                        conditions: [
                            { kind: ConditionKind.RoomMemberCount, is: "2" },
                            { kind: ConditionKind.EventMatch, key: "type", pattern: "m.room.message" },
                        ],
                        actions: [PushRuleActionName.Notify],
                    },
                ],
            },
        });
        await respond(
            { initial: true, required_state: requiredState, joined_count: 2, timeline: [message("$a"), message("$b")] },
            [receipt("$a")],
        );
        expect(counts().total).toBe(1);

        await respond({ joined_count: 3 });

        expect(counts().total).toBe(0);
    });

    it("evaluates a room's messages again when its power levels change", async () => {
        const { client, respond } = await setup();
        const powerLevels = (id: string): MSC3575RoomData["required_state"][number] => ({
            type: EventType.RoomPowerLevels,
            state_key: "",
            sender: me,
            event_id: id,
            origin_server_ts: 1,
            content: { users: { [me]: 100 } },
        });
        await respond(
            {
                initial: true,
                required_state: [...requiredState, powerLevels("$levels")],
                timeline: [message("$a"), message("$b")],
            },
            [receipt("$a")],
        );
        const evaluate = vi.spyOn(client.pushProcessor, "actionsForEvent");

        // Who may notify everyone can change what a message does.
        await respond({ required_state: [powerLevels("$new-levels")] });

        expect(evaluate.mock.calls.map(([event]) => event.getId())).toContain("$b");
    });

    it("clears the counts of a room the user leaves", async () => {
        const { client, respond, counts } = await setup();
        await respond({ initial: true, required_state: requiredState, timeline: [message("$a")] }, []);
        expect(counts().total).toBe(1);

        client.getRoom(roomId)!.updateMyMembership("leave");

        expect(counts().total).toBe(0);
        expect(client.hasLocalNotificationCounts()).toBe(true);
    });

    /** A second session restoring what the first saved, as at the next start, with a server that never answers. */
    function restoreSession(saved: SavedLedger, snapshot: SlidingSyncSnapshot, rules: IPushRules = pushRules) {
        const client: MatrixClient = createClientWithCreds({
            homeserverUrl: "https://example.org",
            userId: me,
            accessToken: "token",
        });
        // As the real one does: the rules are processed as the client sets them.
        vi.spyOn(client, "getPushRules").mockImplementation(async () => {
            client.setPushRules(rules);
            return client.pushRules!;
        });
        vi.spyOn(client.http, "authedRequest").mockImplementation(() => new Promise(() => {}));
        const sync = new SlidingSync("https://example.org", new Map(), {}, client, 20_000);
        const api = new SlidingSyncSdk(
            sync,
            client,
            { lazyLoadMembers: true, slidingSyncSnapshot: async () => snapshot },
            { logger },
        );
        const engine = new NotificationCountEngine(client, sync, NO_RECOVERY);
        engine.start();
        engine.useSaved(new Map([[roomId, saved]]));
        stops.push(() => {
            engine.stop();
            api.stop();
        });
        const read = (room: Room): { total: number; highlight: number } => ({
            total: room.getRoomUnreadNotificationCount(NotificationCountType.Total),
            highlight: room.getRoomUnreadNotificationCount(NotificationCountType.Highlight),
        });
        const announced = Promise.withResolvers<{ total: number; highlight: number }>();
        client.on(ClientEvent.Room, (room) => announced.resolve(read(room)));
        // Once the room's saved account data and receipts are applied too.
        const applied = Promise.withResolvers<void>();
        const onSavedRoomApplied = engine.onSavedRoomApplied.bind(engine);
        vi.spyOn(engine, "onSavedRoomApplied").mockImplementation((room) => {
            onSavedRoomApplied(room);
            applied.resolve();
        });
        void api.sync();
        return { client, engine, announced: announced.promise, applied: applied.promise, read };
    }

    it("announces a restored room with its saved counts, before the server answers", async () => {
        // The last session: two unread messages after the receipt, one a mention.
        const first = await setup();
        await first.respond(
            {
                initial: true,
                required_state: requiredState,
                timeline: [message("$a"), message("$b"), message("$c", "hi alice")],
            },
            [receipt("$a")],
        );
        const saved = first.engine.save(roomId) as SavedLedger;

        // The saved room keeps only its newest event; the saved ledger knows the rest. Its saved push rules are
        // applied again too, which changes nothing.
        const { engine, announced } = restoreSession(saved, {
            rooms: {
                [roomId]: { name: "Saved", required_state: requiredState, timeline: [message("$c", "hi alice")] },
            },
            accountData: [{ type: EventType.PushRules, content: pushRules }],
        });

        // Already there when the room is announced.
        await expect(announced).resolves.toEqual({ total: 2, highlight: 1 });
        expect(engine.getCounts(roomId)?.main.confidence).toBe(CountConfidence.Exact);
    });

    it("keeps a restored room's receipts made here as they were, though the SDK replays them as saved", async () => {
        const first = await setup();
        await first.respond(
            { initial: true, required_state: requiredState, timeline: [message("$a"), message("$b")] },
            [receipt("$a")],
        );
        // Read here up to a message opened from a link, which sync had not brought.
        first.client.getRoom(roomId)!.addLocalEchoReceipt(me, new MatrixEvent(message("$n")), ReceiptType.Read, true);
        await first.settle();
        const saved = first.engine.save(roomId) as SavedLedger;

        // The rooms' saved receipts include it, without saying it was made here.
        const { client, engine, applied, read } = restoreSession(saved, {
            rooms: { [roomId]: { name: "Saved", required_state: requiredState, timeline: [message("$b")] } },
            accountData: [],
            receipts: { [roomId]: { type: EventType.Receipt, content: { $n: { "m.read": { [me]: { ts: 2 } } } } } },
        });
        await applied;
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(read(client.getRoom(roomId)!)).toEqual({ total: 0, highlight: 0 });
        expect(engine.getCounts(roomId)?.main.confidence).toBe(CountConfidence.Unknown);
    });

    it("keeps a restored room's saved counts when the same push rules come in another order", async () => {
        // Rules whose member count conditions give different answers, and which match no message here.
        const sizes = (is: AnyMemberCountCondition, id: string): IPushRule => ({
            rule_id: id,
            default: false,
            enabled: true,
            conditions: [
                { kind: ConditionKind.RoomMemberCount, is },
                { kind: ConditionKind.EventMatch, key: "type", pattern: "org.example.never" },
            ],
            actions: [],
        });
        const ordered: IPushRules = {
            global: {
                ...pushRules.global,
                [PushRuleKind.Override]: [...pushRules.global[PushRuleKind.Override]!, sizes(">5", "big")],
                [PushRuleKind.Underride]: [...pushRules.global[PushRuleKind.Underride]!, sizes("1", "alone")],
            },
        };
        const { underride, ...rest } = ordered.global;
        const reordered: IPushRules = { global: { underride, ...rest } };
        const first = await setup();
        first.client.setPushRules(ordered);
        await first.respond(
            { initial: true, required_state: requiredState, timeline: [message("$a"), message("$b"), message("$c")] },
            [receipt("$a")],
        );
        const saved = first.engine.save(roomId) as SavedLedger;

        const { engine, announced } = restoreSession(
            saved,
            { rooms: { [roomId]: { name: "Saved", required_state: requiredState, timeline: [message("$c")] } } },
            reordered,
        );

        // $b is known only from what was saved: had its result been forgotten, it would not count.
        await expect(announced).resolves.toEqual({ total: 2, highlight: 0 });
        expect(engine.getCounts(roomId)?.main.confidence).toBe(CountConfidence.Exact);
    });

    it("evaluates a saved ledger again once restored with other push rules", async () => {
        const first = await setup();
        await first.respond(
            { initial: true, required_state: requiredState, timeline: [message("$a"), message("$b")] },
            [receipt("$a")],
        );
        const saved = first.engine.save(roomId) as SavedLedger;
        const { client, engine, counts, settle } = await setup();
        engine.useSaved(new Map([[roomId, saved]]));

        // The rules changed while away: nothing notifies any more.
        client.setPushRules({ global: { ...pushRules.global, [PushRuleKind.Underride]: [] } });
        const room = new Room(roomId, client, me);
        room.updateMyMembership("join");
        client.store.storeRoom(room);
        engine.onSyncTimeline(room, [new MatrixEvent(message("$b"))], {
            limited: false,
            initial: true,
            expanded: false,
            fromSnapshot: true,
        });
        await settle();

        expect(counts().total).toBe(0);
    });

    it("publishes what is ready when asked, or when stopped, and leaves a half-applied response unfinished", async () => {
        const { client, engine, respond, sync, counts } = await setup();
        await respond({ initial: true, required_state: requiredState, timeline: [message("$a"), message("$b")] }, [
            receipt("$a"),
        ]);
        // Read here: published at the next task, unless asked to before, such as when the page closes.
        const room = client.getRoom(roomId)!;
        room.addLocalEchoReceipt(me, room.findEventById("$b")!, ReceiptType.Read, true);
        expect(engine.save(roomId)).toBe("pending");
        // Out of time at once: it stays waiting, keeping its last saved record.
        engine.finishPending(-1);
        expect(engine.save(roomId)).toBe("pending");
        engine.finishPending();
        expect(counts().total).toBe(0);
        expect(engine.save(roomId)).not.toBe("pending");

        // Half way through a response when sync stops: its room is never finished.
        const response: MSC3575SlidingSyncResponse = { pos: "2", lists: {}, rooms: {}, extensions: {} };
        sync.emit(SlidingSyncEvent.Lifecycle, SlidingSyncState.RequestFinished, response);
        engine.onSyncTimeline(room, [new MatrixEvent(message("$c"))], {
            limited: false,
            initial: false,
            expanded: false,
            fromSnapshot: false,
        });
        engine.stop();
        expect(engine.save(roomId)).toBe("unfinished");
    });

    it("gives a room's ledger to save only as it was when its counts were published", async () => {
        const { client, engine, respond, sync } = await setup();
        const changed = vi.fn();
        engine.setChangeListener(changed);
        await respond({ initial: true, required_state: requiredState, timeline: [message("$a"), message("$b")] }, [
            receipt("$a"),
        ]);
        expect(changed).toHaveBeenCalledWith(roomId);
        const saved = engine.save(roomId) as SavedLedger;
        expect(RoomCountLedger.restore(saved)?.compute().main.total).toBe(1);

        // Half way through a response, the room's ledger waits.
        const response: MSC3575SlidingSyncResponse = { pos: "2", lists: {}, rooms: {}, extensions: {} };
        sync.emit(SlidingSyncEvent.Lifecycle, SlidingSyncState.RequestFinished, response);
        engine.onSyncTimeline(client.getRoom(roomId)!, [new MatrixEvent(message("$c"))], {
            limited: false,
            initial: false,
            expanded: false,
            fromSnapshot: false,
        });
        expect(engine.save(roomId)).toBe("pending");
        sync.emit(SlidingSyncEvent.Applied, response);
        expect(engine.save(roomId)).not.toBe("pending");
        expect(engine.save("!unknown:example.org")).toBeUndefined();
    });

    it("lets go of the client when stopped", async () => {
        const { client, engine } = await setup();
        engine.stop();

        expect(client.getRoomHistoryObserver()).toBeUndefined();
    });
});
