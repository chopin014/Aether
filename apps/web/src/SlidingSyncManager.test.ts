/*
Copyright 2024 New Vector Ltd.
Copyright 2022 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import {
    type SlidingSync,
    SlidingSyncEvent,
    SlidingSyncState,
    type MSC3575RoomData,
    type MSC3575SlidingSyncResponse,
} from "matrix-js-sdk/src/sliding-sync";
import {
    ClientEvent,
    EventType,
    createClient,
    type MatrixClient,
    MatrixEvent,
    Room,
    RoomEvent,
    RoomStateEvent,
} from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";
import { KnownMembership } from "matrix-js-sdk/src/types";
import { MatrixRTCSessionManagerEvents } from "matrix-js-sdk/src/matrixrtc";
// The real SDK adapter verifies state-to-call discovery, beyond checking request parameters.
// oxlint-disable-next-line no-restricted-imports
import { SlidingSyncSdk } from "matrix-js-sdk/src/sliding-sync-sdk";
import fetchMock from "@fetch-mock/vitest";
import EventEmitter from "node:events";
import { waitFor } from "test-utils-rtl";
import { mkStubRoom, stubClient } from "test-utils";

import { MAX_STATE_READ_ROOMS, SlidingSyncManager } from "./SlidingSyncManager";
import { SlidingSyncCache } from "./sliding-sync/SlidingSyncCache";
import { CATALOG_STATE } from "./sliding-sync/roomStateProfiles";
import { type RoomSubscriptionLeases } from "./sliding-sync/RoomSubscriptionLeases";
import { DEMAND_LINGER_MS, RoomStateUnavailableError } from "./sliding-sync/RoomStateDemands";
import { JitsiCallMemberEventType } from "./call-types";

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
    hasSavedRoom = vi.fn().mockReturnValue(false);
    restoreSavedRooms = vi.fn().mockResolvedValue(undefined);
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

    describe("adaptive initial timeline", () => {
        const roomId = "!adaptive:example.org";
        const userId = "@alice:example.org";
        const memberEvent = {
            type: EventType.RoomMember,
            state_key: userId,
            sender: userId,
            room_id: roomId,
            event_id: "$member",
            origin_server_ts: 1,
            content: { membership: "join" },
        };
        const textEvent = {
            type: EventType.RoomMessage,
            sender: userId,
            room_id: roomId,
            event_id: "$text",
            origin_server_ts: 0,
            content: { msgtype: "m.text", body: "Conversation" },
        };
        const data = (timeline: MSC3575RoomData["timeline"]): MSC3575RoomData => ({
            name: "Adaptive room",
            initial: true,
            timeline,
            required_state: [
                {
                    type: EventType.RoomCreate,
                    state_key: "",
                    sender: userId,
                    event_id: "$create",
                    origin_server_ts: 0,
                    content: {},
                },
                memberEvent,
            ],
        });
        const complete = (sync: SlidingSync, rooms: Record<string, MSC3575RoomData>) =>
            sync.emit(SlidingSyncEvent.Lifecycle, SlidingSyncState.Complete, {
                pos: "next",
                lists: {},
                extensions: {},
                rooms,
            });

        it("expands once, waits for processed SDK room data, and delays background lists", async () => {
            client = createClient({ baseUrl: "https://example.org", userId, deviceId: "ALICE", accessToken: "test" });
            client.pushRules = { global: {} };
            const sync = (await manager.setup(client, roomId))!;
            const api = new SlidingSyncSdk(sync, client, { lazyLoadMembers: true }, { logger });
            try {
                const preparation = manager.initialTimelinePreparation(client, roomId)!;
                const settled = vi.fn();
                void preparation.then(settled);
                const select = vi.spyOn(sync, "useCustomSubscription");
                const first = data([memberEvent]);
                await sync.emitPromised(SlidingSyncEvent.RoomData, roomId, first);
                complete(sync, { [roomId]: first });
                await new Promise((resolve) => setTimeout(resolve, 70));
                expect(settled).not.toHaveBeenCalled();
                expect(select).toHaveBeenCalledWith(roomId, "bootstrap-expanded");
                expect(sync.getListParams("untagged")).toBeNull();
                complete(sync, {});
                await Promise.resolve();
                expect(settled).not.toHaveBeenCalled();
                const expanded = { ...data([textEvent, memberEvent]), initial: false, expanded_timeline: true };
                await sync.emitPromised(SlidingSyncEvent.RoomData, roomId, expanded);
                expect(settled).not.toHaveBeenCalled();
                expect(
                    client
                        .getRoom(roomId)!
                        .getLiveTimeline()
                        .getEvents()
                        .map((e) => e.getId()),
                ).toEqual(["$text", "$member"]);
                complete(sync, { [roomId]: expanded });
                await expect(preparation).resolves.toBe(true);
                expect(manager.initialTimelinePreparation(client, roomId)).toBeUndefined();
                await vi.waitFor(() => expect(sync.getListParams("recent")?.timeline_limit).toBe(20));
                expect(select.mock.calls.filter(([, name]) => name === "bootstrap-expanded")).toHaveLength(1);
            } finally {
                api.stop();
            }
        });

        it.each([
            ["text", [textEvent]],
            ["encrypted", [{ ...textEvent, type: EventType.RoomMessageEncrypted }]],
            ["custom content", [{ ...textEvent, type: "org.example.custom" }]],
            ["empty room", []],
        ] as const)("keeps the small response for %s", async (_label, events) => {
            const sync = (await manager.setup(client, roomId))!;
            const preparation = manager.initialTimelinePreparation(client, roomId)!;
            const select = vi.spyOn(sync, "useCustomSubscription");
            const response = data([...events]);
            await sync.emitPromised(SlidingSyncEvent.RoomData, roomId, response);
            complete(sync, { [roomId]: response });
            await expect(preparation).resolves.toBe(false);
            expect(select).not.toHaveBeenCalledWith(roomId, "bootstrap-expanded");
            sync.stop();
        });

        it.each([EventType.RoomEncryption, EventType.RoomCreate])(
            "does not expand protected metadata %s",
            async (type) => {
                const sync = (await manager.setup(client, roomId))!;
                const preparation = manager.initialTimelinePreparation(client, roomId)!;
                const response = data([memberEvent]);
                response.required_state.push({
                    type,
                    state_key: "",
                    event_id: "$metadata",
                    sender: userId,
                    origin_server_ts: 0,
                    content:
                        type === EventType.RoomCreate ? { type: "m.space" } : { algorithm: "m.megolm.v1.aes-sha2" },
                });
                await sync.emitPromised(SlidingSyncEvent.RoomData, roomId, response);
                complete(sync, { [roomId]: response });
                await expect(preparation).resolves.toBe(false);
                sync.stop();
            },
        );

        it.each(["leave", "ban"])("does not expand a destination with own membership %s", async (membership) => {
            vi.mocked(client.getUserId).mockReturnValue(userId);
            const sync = (await manager.setup(client, roomId))!;
            const preparation = manager.initialTimelinePreparation(client, roomId)!;
            const select = vi.spyOn(sync, "useCustomSubscription");
            const response = data([memberEvent]);
            response.required_state[1] = { ...memberEvent, content: { membership } };
            await sync.emitPromised(SlidingSyncEvent.RoomData, roomId, response);
            complete(sync, { [roomId]: response });
            await expect(preparation).resolves.toBe(false);
            expect(select).not.toHaveBeenCalledWith(roomId, "bootstrap-expanded");
            sync.stop();
        });

        it("restores a destination selected after background discovery finishes", async () => {
            const sync = (await manager.setup(client))!;
            complete(sync, {});
            await vi.waitFor(() => expect(sync.getListParams("recent")?.timeline_limit).toBe(20));
            complete(sync, {});
            // Only the manager's own tracking of responses stays, with the notification counts' and the saved rooms'.
            await vi.waitFor(() => expect(sync.listenerCount(SlidingSyncEvent.Lifecycle)).toBe(3));
            const select = vi.spyOn(sync, "useCustomSubscription");
            const visible = manager.setRoomVisible(roomId);
            await vi.waitFor(() => expect(select).toHaveBeenCalledWith(roomId, "bootstrap"));
            const preparation = manager.initialTimelinePreparation(client, roomId)!;
            const response = data([memberEvent]);
            await sync.emitPromised(SlidingSyncEvent.RoomData, roomId, response);
            const room = new Room(roomId, client, client.getUserId()!);
            vi.mocked(client.getRoom).mockReturnValue(room);
            client.emit(ClientEvent.Room, room);
            await visible;
            complete(sync, { [roomId]: response });
            expect(select).toHaveBeenLastCalledWith(roomId, "bootstrap-expanded");
            await sync.emitPromised(SlidingSyncEvent.RoomData, roomId, response);
            complete(sync, { [roomId]: response });
            await expect(preparation).resolves.toBe(true);
            expect(select).toHaveBeenLastCalledWith(roomId, "room");
            expect(sync.listenerCount(SlidingSyncEvent.Lifecycle)).toBe(3);
            sync.stop();
        });

        it.each(["redacted", "edit", "members"])(
            "bounds expansion even when %s still supplies no text",
            async (kind) => {
                const sync = (await manager.setup(client, roomId))!;
                const preparation = manager.initialTimelinePreparation(client, roomId)!;
                const event =
                    kind === "redacted"
                        ? {
                              ...textEvent,
                              unsigned: {
                                  redacted_because: {
                                      ...textEvent,
                                      type: EventType.RoomRedaction,
                                      content: {},
                                      unsigned: {},
                                  },
                              },
                          }
                        : kind === "edit"
                          ? {
                                ...textEvent,
                                content: {
                                    ...textEvent.content,
                                    "m.relates_to": { rel_type: "m.replace", event_id: "$old" },
                                },
                            }
                          : memberEvent;
                const response = data([event]);
                await sync.emitPromised(SlidingSyncEvent.RoomData, roomId, response);
                complete(sync, { [roomId]: response });
                await sync.emitPromised(SlidingSyncEvent.RoomData, roomId, response);
                complete(sync, { [roomId]: response });
                await expect(preparation).resolves.toBe(true);
                expect(manager.initialTimelinePreparation(client, roomId)).toBeUndefined();
                sync.stop();
            },
        );

        it.each(["error", "stop", "replace", "deadline", "omitted"])(
            "settles without expansion on %s",
            async (reason) => {
                const sync = (await manager.setup(client, roomId))!;
                const preparation = manager.initialTimelinePreparation(client, roomId)!;
                const response = data([memberEvent]);
                if (reason !== "omitted") {
                    await sync.emitPromised(SlidingSyncEvent.RoomData, roomId, response);
                    if (reason === "deadline") vi.useFakeTimers();
                    complete(sync, { [roomId]: response });
                }
                if (reason === "error")
                    sync.emit(SlidingSyncEvent.Lifecycle, SlidingSyncState.RequestFinished, null, new Error("offline"));
                if (reason === "stop") sync.stop();
                if (reason === "replace") await manager.setup(stubClient());
                if (reason === "deadline") {
                    await vi.advanceTimersByTimeAsync(3000);
                    vi.useRealTimers();
                }
                if (reason === "omitted") complete(sync, {});
                await expect(preparation).resolves.toBe(false);
                expect(manager.initialTimelinePreparation(client, roomId)).toBeUndefined();
                await sync.emitPromised(SlidingSyncEvent.RoomData, roomId, response);
                complete(sync, { [roomId]: response });
                expect(manager.initialTimelinePreparation(client, roomId)).toBeUndefined();
                sync.stop();
            },
        );
    });

    describe("ongoing call state", () => {
        const roomId = "!call:example.org";
        const userId = "@alice:example.org";
        const caller = "@bob:example.org";
        const callTypes = [
            EventType.GroupCallPrefix,
            EventType.GroupCallMemberPrefix,
            EventType.RTCSlot,
            "im.vector.modular.widgets",
            JitsiCallMemberEventType,
        ];
        const running: Array<{ api: SlidingSyncSdk; client: MatrixClient }> = [];

        afterEach(() => {
            for (const { api, client } of running.splice(0)) {
                api.stop();
                client.matrixRTC.stop();
            }
        });

        const state = (
            type: string,
            key: string,
            content: object,
            id = `${type}-${key}`,
        ): MSC3575RoomData["required_state"][number] => ({
            type,
            state_key: key,
            room_id: roomId,
            event_id: `$${id}`,
            sender: caller,
            origin_server_ts: Date.now() - 60_000,
            content,
        });

        function currentState() {
            return [
                state(EventType.RoomCreate, "", { creator: userId, room_version: "11" }),
                state(EventType.RoomMember, userId, { membership: "join" }),
                state(EventType.RoomMember, caller, { membership: "join" }),
                state(EventType.GroupCallPrefix, "legacy", { "m.type": "m.video", "m.intent": "m.room" }),
                state(EventType.GroupCallMemberPrefix, `${caller}_BOB`, {
                    application: "m.call",
                    call_id: "",
                    device_id: "BOB",
                    focus_active: { type: "livekit", focus_selection: "oldest_membership" },
                    foci_preferred: [],
                    scope: "m.room",
                    created_ts: Date.now() - 60_000,
                    expires: 3_600_000,
                }),
                state(EventType.RTCSlot, "m.call#ROOM", { status: "open", application: { type: "m.call" } }),
                state("im.vector.modular.widgets", "call-widget", { type: "jitsi", url: "https://call.example.org" }),
                state(JitsiCallMemberEventType, caller, { devices: ["BOB"] }),
            ];
        }

        async function setup(scope: "list" | "bootstrap" | "focused") {
            client = createClient({ baseUrl: "https://example.org", userId, deviceId: "ALICE", accessToken: "test" });
            client.pushRules = { global: {} };
            const sync = (await manager.setup(client, scope === "bootstrap" ? roomId : undefined))!;
            const api = new SlidingSyncSdk(sync, client, { lazyLoadMembers: true }, { logger });
            running.push({ api, client });
            client.matrixRTC.start();
            if (scope === "focused") {
                await sync.emitPromised(SlidingSyncEvent.RoomData, roomId, {
                    name: "Call room",
                    initial: true,
                    required_state: currentState().filter(
                        (event) => event.type === EventType.RoomCreate || event.state_key === userId,
                    ),
                    timeline: [],
                });
                await manager.setRoomVisible(roomId);
            }
            const internals = sync as unknown as {
                roomIdToCustomSubscription: Map<string, string>;
                customSubscriptions: Map<string, { required_state: string[][] }>;
            };
            const required =
                scope === "list"
                    ? sync.getListParams("untagged")!.required_state!
                    : internals.customSubscriptions.get(internals.roomIdToCustomSubscription.get(roomId)!)!
                          .required_state;
            const selectedState = (recentSender: string): MSC3575RoomData["required_state"] =>
                currentState().filter((event) =>
                    required.some(
                        ([type, key]) =>
                            type === event.type &&
                            (key === "*" ||
                                key === event.state_key ||
                                (type === EventType.RoomMember && key === "$ME" && event.state_key === userId) ||
                                (type === EventType.RoomMember && key === "$LAZY" && event.state_key === recentSender)),
                    ),
                );
            const receive = (recentSender: string) =>
                sync.emitPromised(SlidingSyncEvent.RoomData, roomId, {
                    name: "Call room",
                    initial: scope !== "focused",
                    required_state: selectedState(recentSender),
                    timeline: [
                        {
                            type: EventType.RoomMessage,
                            room_id: roomId,
                            event_id: "$latest-message",
                            sender: recentSender,
                            origin_server_ts: Date.now(),
                            content: { msgtype: "m.text", body: "Recent message" },
                        },
                    ],
                });
            return { sync, required, receive };
        }

        it.each(["list", "bootstrap", "focused"] as const)(
            "discovers older call state outside the %s timeline for a known joined caller",
            async (scope) => {
                const { required, receive } = await setup(scope);
                for (const type of callTypes) expect(required).toContainEqual([type, "*"]);
                expect(required).not.toContainEqual([EventType.RoomMember, "*"]);
                const started = vi.fn();
                client.matrixRTC.on(MatrixRTCSessionManagerEvents.SessionStarted, started);
                await receive(caller);
                const room = client.getRoom(roomId)!;
                await vi.waitFor(() => expect(started).toHaveBeenCalledWith(roomId, expect.anything()));
                const session = client.matrixRTC.getRoomSession(room);
                expect(session.memberships.map((membership) => membership.userId)).toEqual([caller]);
                expect(client.matrixRTC.getRtcSlot(room)?.status).toBe("open");
                expect(
                    room
                        .getLiveTimeline()
                        .getEvents()
                        .map((event) => event.getId()),
                ).toEqual(["$latest-message"]);
                for (const type of callTypes) expect(room.currentState.getStateEvents(type)).toHaveLength(1);
            },
        );

        it("retains older call state until a silent caller's explicit room membership arrives", async () => {
            const { sync, required, receive } = await setup("bootstrap");
            const started = vi.fn();
            client.matrixRTC.on(MatrixRTCSessionManagerEvents.SessionStarted, started);
            await receive(userId);
            const room = client.getRoom(roomId)!;
            const session = client.matrixRTC.getRoomSession(room);
            await session.ensureRecalculateSessionMembers();
            expect(room.getMember(caller)).toBeNull();
            expect(session.memberships).toHaveLength(0);
            expect(room.currentState.getStateEvents(EventType.GroupCallMemberPrefix)).toHaveLength(1);

            // A follow-up subscription can request the missing sender without downloading the full room roster.
            sync.addCustomSubscription("call-participant", {
                required_state: [...required, [EventType.RoomMember, caller]],
                timeline_limit: 0,
            });
            sync.useCustomSubscription(roomId, "call-participant");
            await sync.emitPromised(SlidingSyncEvent.RoomData, roomId, {
                name: "Call room",
                required_state: [state(EventType.RoomMember, caller, { membership: "join" })],
                timeline: [],
            });
            await vi.waitFor(() =>
                expect(session.memberships.map((membership) => membership.userId)).toEqual([caller]),
            );
            expect(room.getLiveTimeline().getEvents()).toHaveLength(1);
            expect(started).not.toHaveBeenCalled();
        });
    });

    it.each([false, true])("prefetches Home's Space and channel (encrypted=%s)", async (encrypted) => {
        const roomId = "!channel:example.org";
        const spaceId = "!space:example.org";
        const sync = (await manager.setup(client, undefined, { roomId, spaceId }))!;
        const internals = sync as unknown as {
            roomIdToCustomSubscription: Map<string, string>;
            customSubscriptions: Map<string, { timeline_limit: number; required_state: string[][] }>;
        };
        const subscription = (id: string) =>
            internals.customSubscriptions.get(internals.roomIdToCustomSubscription.get(id)!)!;
        expect(sync.getRoomSubscriptions()).toEqual(new Set([roomId, spaceId]));
        expect(sync.getListParams("untagged")?.ranges).toEqual([[0, 0]]);
        expect(subscription(roomId).timeline_limit).toBe(50);
        expect(subscription(spaceId).timeline_limit).toBe(0);
        expect(subscription(spaceId).required_state).toContainEqual(["m.space.child", "*"]);
        const room = new Room(roomId, client, client.getUserId()!);
        vi.spyOn(room, "hasEncryptionStateEvent").mockReturnValue(encrypted);
        vi.mocked(client.getRoom).mockImplementation((id) => (id === roomId ? room : null));
        const modify = vi.spyOn(sync, "modifyRoomSubscriptions");
        sync.emit(SlidingSyncEvent.Lifecycle, SlidingSyncState.Complete, {
            pos: "one",
            lists: {},
            extensions: {},
            rooms: {
                [roomId]: { name: "Channel", required_state: [], timeline: [] },
                [spaceId]: { name: "Space", required_state: [], timeline: [] },
            },
        });
        expect(modify).not.toHaveBeenCalled();
        await vi.waitFor(() =>
            expect(internals.roomIdToCustomSubscription.get(roomId)).toBe(encrypted ? "encrypted" : "room"),
        );
        expect(subscription(spaceId).timeline_limit).toBe(0);
    });

    it("drops absent Home hints only after a successful response and preserves newer subscriptions", async () => {
        const roomId = "!left:example.org";
        const spaceId = "!space:example.org";
        const visibleId = "!selected:example.org";
        const sync = (await manager.setup(client, undefined, { roomId, spaceId }))!;
        void manager.setRoomVisible(visibleId);
        await new Promise((resolve) => setTimeout(resolve, 0));
        sync.emit(SlidingSyncEvent.Lifecycle, SlidingSyncState.Complete, null, new Error("offline"));
        expect(sync.getRoomSubscriptions()).toContain(roomId);
        sync.emit(SlidingSyncEvent.Lifecycle, SlidingSyncState.Complete, {
            pos: "one",
            lists: {},
            extensions: {},
            rooms: { [spaceId]: { name: "Space", required_state: [], timeline: [] } },
        });
        expect(sync.getRoomSubscriptions()).toEqual(new Set([spaceId, visibleId]));
        expect((manager as unknown as { bootstrapRooms: Set<string> }).bootstrapRooms.has(roomId)).toBe(false);
    });

    it.each([
        [{ roomId: "#alias:example.org", spaceId: "home" }, []],
        [{ roomId: "!space:example.org", spaceId: "!space:example.org" }, ["!space:example.org"]],
    ] as const)("bounds and validates Home hints %j", async (prefetch, expected) => {
        const sync = (await manager.setup(client, undefined, prefetch))!;
        expect(sync.getRoomSubscriptions()).toEqual(new Set(expected));
        expect((manager as unknown as { bootstrapRooms: Set<string> }).bootstrapRooms.size).toBe(0);
    });

    it("ignores Home hints for an explicit destination and ignores obsolete hint responses", async () => {
        const previous = (await manager.setup(client, undefined, { roomId: "!old:example.org" }))!;
        const current = (await manager.setup(client, "!selected:example.org", { roomId: "!hint:example.org" }))!;
        previous.emit(SlidingSyncEvent.Lifecycle, SlidingSyncState.Complete, {
            pos: "one",
            lists: {},
            extensions: {},
            rooms: {},
        });
        expect(current.getRoomSubscriptions()).toEqual(new Set(["!selected:example.org"]));
        expect(current.getListParams("untagged")).toBeNull();
    });

    it("starts with small lists then restores recent messages after the first response", async () => {
        const sync = await manager.setup(client);
        for (const name of ["spaces", "invites", "favourites", "dms", "untagged"]) {
            expect(sync?.getListParams(name)?.ranges).toEqual([[0, 0]]);
        }
        expect(sync?.getListParams("untagged")?.timeline_limit).toBe(1);
        sync!.emit(SlidingSyncEvent.Lifecycle, SlidingSyncState.Complete, null);
        await vi.waitFor(() => expect(sync?.getListParams("recent")?.timeline_limit).toBe(20));
        // The most recent rooms get history to open straight away; every other room is listed with its latest event.
        expect(sync?.getListParams("recent")).toEqual(
            expect.objectContaining({
                ranges: [[0, 19]],
                required_state: expect.arrayContaining([["m.room.member", "$LAZY"]]),
                filters: { is_invite: false, not_room_types: ["m.space"] },
            }),
        );
        for (const name of ["favourites", "dms", "untagged"]) {
            expect(sync?.getListParams(name)).toEqual(
                expect.objectContaining({
                    timeline_limit: 1,
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
            void manager.setRoomVisible(roomId);
            await new Promise((resolve) => setTimeout(resolve, 0));
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
                expect(internals.roomIdToCustomSubscription.get(roomId)).toBe(encrypted ? "encrypted" : "room"),
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
        await vi.waitFor(() => expect(sync.getListParams("recent")?.timeline_limit).toBe(20));
        expect(selectSubscription).not.toHaveBeenCalled();
        void manager.setRoomVisible(roomId);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(selectSubscription).not.toHaveBeenCalled();

        const room = new Room(roomId, client, client.getUserId()!);
        vi.mocked(client.getRoom).mockReturnValue(room);
        sync.emit(SlidingSyncEvent.Lifecycle, SlidingSyncState.Complete, null);
        await vi.waitFor(() => expect(selectSubscription).toHaveBeenCalledWith(roomId, "room"));
    });

    it.each([false, true])(
        "discovers unknown rooms after background lists finish (encrypted=%s)",
        async (encrypted) => {
            const sync = (await manager.setup(client))!;
            sync.emit(SlidingSyncEvent.Lifecycle, SlidingSyncState.Complete, null);
            await vi.waitFor(() => expect(sync.getListParams("recent")?.timeline_limit).toBe(20));
            sync.emit(SlidingSyncEvent.Lifecycle, SlidingSyncState.Complete, null);
            await new Promise((resolve) => setTimeout(resolve, 60));
            // Only the manager's own tracking of responses stays, with the notification counts' and the saved rooms'.
            expect(sync.listenerCount(SlidingSyncEvent.Lifecycle)).toBe(3);
            const roomId = "!new:example.org";
            const selectSubscription = vi.spyOn(sync, "useCustomSubscription");
            const visible = manager.setRoomVisible(roomId);
            await vi.waitFor(() => expect(selectSubscription).toHaveBeenCalledWith(roomId, "bootstrap"));
            const room = new Room(roomId, client, client.getUserId()!);
            vi.spyOn(room, "hasEncryptionStateEvent").mockReturnValue(encrypted);
            vi.mocked(client.getRoom).mockReturnValue(room);
            client.emit(ClientEvent.Room, room);
            await visible;
            expect(selectSubscription).toHaveBeenLastCalledWith(roomId, encrypted ? "encrypted" : "room");
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
        await vi.waitFor(() => expect(sync.getListParams("recent")?.timeline_limit).toBe(20));
    });

    it("does not restore an obsolete sync after setup is replaced", async () => {
        const previous = (await manager.setup(client))!;
        previous.emit(SlidingSyncEvent.Lifecycle, SlidingSyncState.Complete, null);
        const current = (await manager.setup(client))!;
        await new Promise((resolve) => setTimeout(resolve, 60));
        expect(current.getListParams("untagged")?.timeline_limit).toBe(1);
        expect(previous.getListParams("untagged")?.timeline_limit).toBe(1);
    });

    it("expects no room to arrive without sliding sync", () => {
        expect(new SlidingSyncManager().mayStillArrive("!room:id")).toBe(false);
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
                    timeline_limit: 1,
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

        it.each([true, false])(
            "says whether the server offers sliding sync (%s), and keeps the answer",
            async (offers) => {
                localStorage.clear();
                SlidingSyncManager.serverSupportsSlidingSync = !offers;
                vi.spyOn(manager, "nativeSlidingSyncSupport").mockResolvedValue(offers);
                expect(manager.knownServerSupport(client)).toBeUndefined();
                await expect(manager.serverOffersSlidingSync(client)).resolves.toBe(offers);
                expect(SlidingSyncManager.serverSupportsSlidingSync).toBe(offers);
                // Kept on this device for the next start, for this homeserver only.
                expect(manager.knownServerSupport(client)).toBe(offers);
                const elsewhere = createClient({ baseUrl: "https://elsewhere.example.org" });
                expect(manager.knownServerSupport(elsewhere)).toBeUndefined();
            },
        );

        it("cannot say whether the server offers sliding sync when it cannot be asked", async () => {
            localStorage.clear();
            vi.spyOn(manager, "nativeSlidingSyncSupport").mockRejectedValue(new Error("offline"));
            await expect(manager.serverOffersSlidingSync(client)).resolves.toBeUndefined();
            expect(SlidingSyncManager.serverSupportsSlidingSync).toBe(false);
            expect(manager.knownServerSupport(client)).toBeUndefined();
        });

        it("drops an answer it cannot update, rather than leave it stale", async () => {
            localStorage.clear();
            vi.spyOn(manager, "nativeSlidingSyncSupport").mockResolvedValue(true);
            await manager.serverOffersSlidingSync(client);
            expect(manager.knownServerSupport(client)).toBe(true);
            // The server stops offering it while storage is full.
            vi.spyOn(manager, "nativeSlidingSyncSupport").mockResolvedValue(false);
            const setItem = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
                throw new DOMException("full", "QuotaExceededError");
            });
            try {
                await expect(manager.serverOffersSlidingSync(client)).resolves.toBe(false);
            } finally {
                setItem.mockRestore();
            }
            expect(manager.knownServerSupport(client)).toBeUndefined();
        });

        it("takes a server whose versions list no unstable features as offering no sliding sync", async () => {
            const real = createClient({ baseUrl: "https://versions.example.org" });
            fetchMock.get("https://versions.example.org/_matrix/client/versions", { versions: ["v1.11"] });
            await expect(manager.serverOffersSlidingSync(real)).resolves.toBe(false);
        });
    });

    describe("isActiveFor", () => {
        it("is true only for the client sliding sync was set up for", async () => {
            const other = new SlidingSyncManager();
            expect(other.isActiveFor(client)).toBe(false);
            const sync = (await other.setup(client))!;
            expect(other.isActiveFor(client)).toBe(true);
            expect(other.isActiveFor(stubClient())).toBe(false);
            expect(other.isActiveFor(null)).toBe(false);
            sync.stop();
        });
    });
    describe("room subscription leases", () => {
        const rooms = new Map<string, Room>();
        let sync: SlidingSync;
        let internals: {
            roomIdToCustomSubscription: Map<string, string>;
            customSubscriptions: Map<string, { timeline_limit: number; required_state: string[][] }>;
        };
        const nameOf = (roomId: string): string | undefined => internals.roomIdToCustomSubscription.get(roomId);
        const subscriptionOf = (roomId: string): { timeline_limit: number; required_state: string[][] } =>
            internals.customSubscriptions.get(nameOf(roomId)!)!;
        // Long enough for a batch of subscription changes to be sent.
        const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 200));

        function knownRoom(roomId: string, kind: "plain" | "encrypted" | "space" = "plain"): Room {
            const room = new Room(roomId, client, client.getUserId()!);
            room.getLiveTimeline().initialiseState([
                new MatrixEvent({
                    type: EventType.RoomCreate,
                    state_key: "",
                    event_id: `$create${roomId}`,
                    room_id: roomId,
                    sender: client.getUserId()!,
                    content: kind === "space" ? { type: "m.space" } : {},
                }),
                ...(kind === "encrypted"
                    ? [
                          new MatrixEvent({
                              type: EventType.RoomEncryption,
                              state_key: "",
                              event_id: `$encryption${roomId}`,
                              room_id: roomId,
                              sender: client.getUserId()!,
                              content: { algorithm: "m.megolm.v1.aes-sha2" },
                          }),
                      ]
                    : []),
            ]);
            rooms.set(roomId, room);
            return room;
        }

        beforeEach(async () => {
            rooms.clear();
            vi.mocked(client.getRoom).mockImplementation((roomId?: string) => rooms.get(roomId!) ?? null);
            sync = (await manager.setup(client))!;
            internals = sync as unknown as typeof internals;
        });

        afterEach(() => {
            vi.useRealTimers();
            sync.stop();
        });

        it("asks for every Space's soundboard, which a voice channel offers from every Space the user is in", () => {
            expect(sync.getListParams("spaces")?.required_state).toContainEqual(["io.aether.soundboard.sound", "*"]);
            // Rooms are listed with the catalog only.
            expect(sync.getListParams("untagged")?.required_state).not.toContainEqual([
                "io.aether.soundboard.sound",
                "*",
            ]);
        });

        it("lists rooms without asking for older rooms, which simplified sliding sync does not serve", () => {
            for (const listName of ["recent", "spaces", "invites", "favourites", "dms", "untagged"]) {
                expect(sync.getListParams(listName)).not.toHaveProperty("include_old_rooms");
            }
        });

        it("gives an opened room the state its views read, by kind of room", async () => {
            knownRoom("!plain", "plain");
            knownRoom("!secret", "encrypted");
            knownRoom("!server", "space");
            await expect(manager.setRoomVisible("!plain")).resolves.toBe("known");
            await tick();
            expect(nameOf("!plain")).toBe("room");
            expect(subscriptionOf("!plain").timeline_limit).toBe(50);
            expect(subscriptionOf("!plain").required_state).toEqual(
                expect.arrayContaining([
                    ["m.room.power_levels", ""],
                    ["m.room.topic", ""],
                    ["m.room.pinned_events", ""],
                    ["m.room.history_visibility", ""],
                    ["io.aether.soundboard.sound", "*"],
                    ["io.aether.call.voice_state", "*"],
                    ["m.room.member", "$LAZY"],
                ]),
            );
            await manager.setRoomVisible("!secret");
            await tick();
            expect(nameOf("!secret")).toBe("encrypted");
            expect(subscriptionOf("!secret").required_state).toContainEqual(["*", "*"]);
            await manager.setRoomVisible("!server");
            await tick();
            expect(nameOf("!server")).toBe("space");
            expect(subscriptionOf("!server").timeline_limit).toBe(0);
        });

        it("treats a room the crypto layer knows as encrypted as encrypted, without its state", async () => {
            knownRoom("!quiet");
            vi.mocked(client.getCrypto()!.isEncryptionEnabledInRoom).mockResolvedValue(true);
            await manager.setRoomVisible("!quiet");
            await tick();
            expect(nameOf("!quiet")).toBe("encrypted");
        });

        it("drops the previously opened room after its grace period", async () => {
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
            knownRoom("!first");
            knownRoom("!second");
            await manager.setRoomVisible("!first");
            await manager.setRoomVisible("!second");
            await vi.advanceTimersByTimeAsync(200);
            expect(sync.getRoomSubscriptions()).toEqual(new Set(["!first", "!second"]));
            await vi.advanceTimersByTimeAsync(60_000);
            expect(sync.getRoomSubscriptions()).toEqual(new Set(["!second"]));
        });

        it("reports a room the server answered without as absent", async () => {
            const changes = vi.fn();
            manager.onArrivalChange(changes);
            const visible = manager.setRoomVisible("!missing");
            await tick();
            expect(nameOf("!missing")).toBe("bootstrap");
            expect(manager.mayStillArrive("!missing")).toBe(true);
            // A response to an older request, which did not ask about the room, proves nothing.
            const older = { pos: "1", lists: {}, rooms: {}, extensions: {} };
            const answered = { pos: "2", lists: {}, rooms: {}, extensions: {} };
            vi.spyOn(sync, "getRequestForResponse").mockImplementation((response) =>
                response === answered
                    ? { roomSubscriptions: new Map([["!missing", subscriptionOf("!missing")]]) }
                    : { roomSubscriptions: new Map() },
            );
            sync.emit(SlidingSyncEvent.Lifecycle, SlidingSyncState.Complete, older);
            await tick();
            expect(manager.mayStillArrive("!missing")).toBe(true);
            sync.emit(SlidingSyncEvent.Lifecycle, SlidingSyncState.Complete, answered);
            await expect(visible).resolves.toBe("absent");
            expect(changes).toHaveBeenCalled();
            expect((manager as unknown as { bootstrapRooms: Set<string> }).bootstrapRooms.has("!missing")).toBe(false);
            expect(manager.initialTimelinePreparation(client, "!missing")).toBeUndefined();
            expect(manager.mayStillArrive("!missing")).toBe(false);
            // Once it has arrived after all, it is no longer taken to be missing.
            client.emit(ClientEvent.Room, knownRoom("!missing"));
            rooms.delete("!missing");
            expect(manager.mayStillArrive("!missing")).toBe(true);
        });

        it("notes which rooms the server has sent on this connection, once the response is applied", async () => {
            const changes = vi.fn();
            const stop = manager.onArrivalChange(changes);
            const data = { name: "Live", required_state: [], timeline: [] };
            expect(manager.hasLiveData("!live")).toBe(false);
            sync.emit(SlidingSyncEvent.Lifecycle, SlidingSyncState.RequestFinished, null);
            sync.emit(SlidingSyncEvent.RoomData, "!live", data);
            sync.emit(SlidingSyncEvent.RoomData, "!live", data);
            // Its membership, say, is applied after its data arrives: not live until the response completes.
            expect(manager.hasLiveData("!live")).toBe(false);
            expect(changes).not.toHaveBeenCalled();
            await applied();
            expect(manager.hasLiveData("!live")).toBe(true);
            expect(changes).toHaveBeenCalled();
            // A request that fails applies nothing.
            sync.emit(SlidingSyncEvent.RoomData, "!failed", data);
            sync.emit(SlidingSyncEvent.Lifecycle, SlidingSyncState.RequestFinished, null, new Error("gone"));
            await applied();
            expect(manager.hasLiveData("!failed")).toBe(false);
            // A listener that stopped is told nothing more.
            const told = changes.mock.calls.length;
            stop();
            sync.emit(SlidingSyncEvent.RoomData, "!other", data);
            await applied();
            expect(changes).toHaveBeenCalledTimes(told);
        });

        it("opens a room from this device's saved data, without waiting for the server", async () => {
            const restore = vi.fn(async (roomIds: string[]) => {
                for (const roomId of roomIds) client.emit(ClientEvent.Room, knownRoom(roomId));
            });
            sync.setSavedRooms({ has: (roomId) => roomId === "!saved" && !rooms.has(roomId), restore });
            expect(manager.mayStillArrive("!saved")).toBe(true);
            await expect(manager.setRoomVisible("!saved")).resolves.toBe("known");
            expect(restore).toHaveBeenCalledExactlyOnceWith(["!saved"], false);
            await tick();
            expect(nameOf("!saved")).toBe("room");
        });

        it("stops waiting for a room the server has not answered for in time", async () => {
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
            const visible = manager.setRoomVisible("!slow");
            await vi.advanceTimersByTimeAsync(10_000);
            await expect(visible).resolves.toBe("timeout");
        });

        it("reports a waited-for room as known when it arrives, and as replaced when the client is", async () => {
            const arriving = manager.setRoomVisible("!arriving");
            await tick();
            client.emit(ClientEvent.Room, knownRoom("!arriving"));
            await expect(arriving).resolves.toBe("known");

            const replaced = manager.setRoomVisible("!never");
            await tick();
            await manager.setup(stubClient());
            await expect(replaced).resolves.toBe("replaced");
        });

        it("fetches rooms someone points at in one batched request, never the room already open", async () => {
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
            for (const roomId of ["!open", "!a", "!b", "!c"]) knownRoom(roomId);
            await manager.setRoomVisible("!open");
            await vi.advanceTimersByTimeAsync(0);
            const modify = vi.spyOn(sync, "modifyRoomSubscriptions");
            manager.prefetchRoom("!open");
            manager.prefetchRoom("!a");
            manager.prefetchRoom("!b");
            manager.prefetchRoom("!c");
            manager.prefetchRoom("#alias:example.org");
            expect(modify).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(150);
            expect(modify).toHaveBeenCalledTimes(1);
            expect(sync.getRoomSubscriptions()).toEqual(new Set(["!open", "!a", "!b", "!c"]));
            expect(nameOf("!a")).toBe("prefetch");
            expect(subscriptionOf("!a").timeline_limit).toBe(20);
            expect(subscriptionOf("!a").required_state).toContainEqual(["m.room.power_levels", ""]);
            await vi.advanceTimersByTimeAsync(30_000);
            expect(sync.getRoomSubscriptions()).toEqual(new Set(["!open"]));
        });

        it("keeps a recently opened room's history when someone points at it again", async () => {
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
            knownRoom("!earlier");
            knownRoom("!now");
            await manager.setRoomVisible("!earlier");
            await manager.setRoomVisible("!now");
            await vi.advanceTimersByTimeAsync(200);
            const modify = vi.spyOn(sync, "modifyRoomSubscriptions");
            manager.prefetchRoom("!earlier");
            await vi.advanceTimersByTimeAsync(200);
            expect(nameOf("!earlier")).toBe("room");
            expect(modify).not.toHaveBeenCalled();
        });

        it("keeps a call's room subscribed while connected, and lets it go afterwards", async () => {
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
            knownRoom("!voice");
            manager.setCallRooms(["!voice"]);
            await vi.advanceTimersByTimeAsync(0);
            expect(sync.getRoomSubscriptions()).toEqual(new Set(["!voice"]));
            expect(nameOf("!voice")).toBe("room");
            manager.setCallRooms(["!voice"]);
            manager.setCallRooms([]);
            await vi.advanceTimersByTimeAsync(15_200);
            expect(sync.getRoomSubscriptions()).toEqual(new Set());
        });

        /** Make `childIds` children of a Space, as its state lists them. */
        function addChildren(space: Room, childIds: string[], content: object = { via: ["example.org"] }): void {
            const events = childIds.map(
                (childId) =>
                    new MatrixEvent({
                        type: EventType.SpaceChild,
                        state_key: childId,
                        event_id: `$child${space.roomId}${childId}${JSON.stringify(content)}`,
                        room_id: space.roomId,
                        sender: client.getUserId()!,
                        // Each event has its own content: redacting one empties its content in place.
                        content: structuredClone(content),
                    }),
            );
            space.currentState.setStateEvents(events);
            for (const event of events) client.emit(RoomStateEvent.Events, event, space.currentState, null);
        }

        /** Every list's parameters, to check that none asks the server to filter by Space. */
        const listFilters = (): unknown[] =>
            [...(sync as unknown as { lists: Map<string, unknown> }).lists.keys()].map(
                (name) => sync.getListParams(name)?.filters,
            );

        /**
         * Announce that the user's membership of a room changed, as sync does: the member event first, then the
         * membership the SDK works out from it.
         */
        function setMembership(room: Room, membership: KnownMembership): void {
            const event = new MatrixEvent({
                type: EventType.RoomMember,
                state_key: client.getUserId()!,
                event_id: `$member${room.roomId}${membership}`,
                room_id: room.roomId,
                sender: client.getUserId()!,
                content: { membership },
            });
            client.emit(RoomStateEvent.Events, event, room.currentState, null);
            const previous = room.getMyMembership();
            room.updateMyMembership(membership);
            client.emit(RoomEvent.MyMembership, room, membership, previous);
        }

        /** Finish applying a sync response, as the SDK does once every room in it has been processed. */
        async function applied(): Promise<void> {
            sync.emit(SlidingSyncEvent.Lifecycle, SlidingSyncState.Complete, {
                pos: "p",
                lists: {},
                rooms: {},
                extensions: {},
            });
            await tick();
        }

        it("subscribes the selected Space's channels from its state, without filtering lists by Space", async () => {
            const space = knownRoom("!server", "space");
            const category = knownRoom("!category", "space");
            category.updateMyMembership(KnownMembership.Join);
            // A subspace the user is not in shows none of its channels.
            const unjoined = knownRoom("!unjoined", "space");
            addChildren(space, ["!a", "!b", "!category", "!unjoined"]);
            addChildren(space, ["!removed"], {});
            addChildren(category, ["!c", "!server"]);
            addChildren(unjoined, ["!hidden"]);
            manager.setActiveSpace("!server");
            await tick();
            expect(sync.getRoomSubscriptions()).toEqual(new Set(["!server", "!a", "!b", "!c"]));
            expect(nameOf("!server")).toBe("space");
            expect(nameOf("!a")).toBe("channel");
            expect(subscriptionOf("!a")).toEqual({ timeline_limit: 1, required_state: CATALOG_STATE });
            // Synapse fails the whole request when a list filters by Space.
            expect(listFilters()).not.toContainEqual(expect.objectContaining({ spaces: expect.anything() }));

            // Home keeps the last Space's channels.
            manager.setActiveSpace(null);
            await tick();
            expect(sync.getRoomSubscriptions()).toContain("!a");
        });

        it("reads the Space's channels once the Space is stored, after its state was announced", async () => {
            manager.setActiveSpace("!server");
            await tick();
            // Sync announces the Space's state before storing the room.
            const space = new Room("!server", client, client.getUserId()!);
            space.getLiveTimeline().initialiseState([
                new MatrixEvent({
                    type: EventType.RoomCreate,
                    state_key: "",
                    event_id: "$create!server",
                    room_id: "!server",
                    sender: client.getUserId()!,
                    content: { type: "m.space" },
                }),
            ]);
            addChildren(space, ["!a"]);
            await applied();
            expect(sync.getRoomSubscriptions()).not.toContain("!a");
            // The response that brings the Space is still being applied.
            sync.emit(SlidingSyncEvent.Lifecycle, SlidingSyncState.RequestFinished, {
                pos: "p",
                lists: {},
                rooms: {},
                extensions: {},
            });
            rooms.set("!server", space);
            client.emit(ClientEvent.Room, space);
            await tick();
            expect(sync.getRoomSubscriptions()).not.toContain("!a");
            await applied();
            expect(sync.getRoomSubscriptions()).toContain("!a");
        });

        it("follows subspaces the user joins, leaves or that are unlinked while the Space is open", async () => {
            const space = knownRoom("!server", "space");
            const category = knownRoom("!category", "space");
            addChildren(space, ["!category"]);
            addChildren(category, ["!c"]);
            manager.setActiveSpace("!server");
            await tick();
            expect(sync.getRoomSubscriptions()).toEqual(new Set(["!server"]));

            setMembership(category, KnownMembership.Join);
            await applied();
            expect(sync.getRoomSubscriptions()).toEqual(new Set(["!server", "!c"]));
            // The subspace is taken out of the Space.
            addChildren(space, ["!category"], {});
            await applied();
            expect(sync.getRoomSubscriptions()).toEqual(new Set(["!server"]));
            addChildren(space, ["!category"]);
            await applied();
            expect(sync.getRoomSubscriptions()).toEqual(new Set(["!server", "!c"]));
            // Leaving: a response arrives, sync announces the member event while applying it, and works out the
            // membership only after processing more of it. Nothing is read until the response has been applied.
            sync.emit(SlidingSyncEvent.Lifecycle, SlidingSyncState.RequestFinished, {
                pos: "p",
                lists: {},
                rooms: {},
                extensions: {},
            });
            client.emit(
                RoomStateEvent.Events,
                new MatrixEvent({
                    type: EventType.RoomMember,
                    state_key: client.getUserId()!,
                    event_id: "$leave!category",
                    room_id: "!category",
                    sender: client.getUserId()!,
                    content: { membership: KnownMembership.Leave },
                }),
                category.currentState,
                null,
            );
            await tick();
            category.updateMyMembership(KnownMembership.Leave);
            client.emit(RoomEvent.MyMembership, category, KnownMembership.Leave, KnownMembership.Join);
            await tick();
            expect(sync.getRoomSubscriptions()).toEqual(new Set(["!server", "!c"]));
            await applied();
            expect(sync.getRoomSubscriptions()).toEqual(new Set(["!server"]));
        });

        it("counts a child that has not arrived as a channel until it turns out to be a Space", async () => {
            const space = knownRoom("!server", "space");
            addChildren(space, ["!later"]);
            manager.setActiveSpace("!server");
            await tick();
            expect(nameOf("!later")).toBe("channel");
            const later = knownRoom("!later", "space");
            client.emit(ClientEvent.Room, later);
            await applied();
            expect(sync.getRoomSubscriptions()).toEqual(new Set(["!server"]));
        });

        it("counts upgraded children as their newest version, and finds a replacement not seen yet", async () => {
            const space = knownRoom("!server", "space");
            const oldChannel = knownRoom("!old-channel");
            const newChannel = knownRoom("!new-channel");
            const oldCategory = knownRoom("!old-category");
            const newCategory = knownRoom("!new-category", "space");
            newCategory.updateMyMembership(KnownMembership.Join);
            addChildren(newCategory, ["!c"]);
            const pending = knownRoom("!pending");
            pending.currentState.setStateEvents([
                new MatrixEvent({
                    type: EventType.RoomTombstone,
                    state_key: "",
                    event_id: "$tombstone!pending",
                    room_id: "!pending",
                    sender: client.getUserId()!,
                    content: { replacement_room: "!unseen", body: "moved" },
                }),
            ]);
            vi.mocked(client.getRoomUpgradeHistory).mockImplementation((roomId) => {
                if (roomId === "!old-channel") return [oldChannel, newChannel];
                if (roomId === "!old-category") return [oldCategory, newCategory];
                return rooms.has(roomId) ? [rooms.get(roomId)!] : [];
            });
            addChildren(space, ["!old-channel", "!old-category", "!pending"]);
            manager.setActiveSpace("!server");
            await tick();
            expect(sync.getRoomSubscriptions()).toEqual(
                new Set(["!server", "!new-channel", "!c", "!pending", "!unseen"]),
            );

            // A change to any version of an upgraded room is followed.
            addChildren(newCategory, ["!d"]);
            await applied();
            expect(sync.getRoomSubscriptions()).toContain("!d");
        });

        it("reads changes made outside a sync response after a short pause, and others once applied", async () => {
            vi.useFakeTimers();
            const space = knownRoom("!server", "space");
            manager.setActiveSpace("!server");
            await vi.advanceTimersByTimeAsync(0);
            // Rooms restored from this device before the first response, while the network may be down.
            addChildren(space, ["!a"]);
            await vi.advanceTimersByTimeAsync(10);
            expect(sync.getRoomSubscriptions()).not.toContain("!a");
            // The read, then the next batch of subscription changes.
            await vi.advanceTimersByTimeAsync(250);
            expect(sync.getRoomSubscriptions()).toContain("!a");

            // A response is being applied: its changes wait for it to finish, however long that takes.
            sync.emit(SlidingSyncEvent.Lifecycle, SlidingSyncState.RequestFinished, {
                pos: "p",
                lists: {},
                rooms: {},
                extensions: {},
            });
            addChildren(space, ["!b"]);
            await vi.advanceTimersByTimeAsync(500);
            expect(sync.getRoomSubscriptions()).not.toContain("!b");
            sync.emit(SlidingSyncEvent.Lifecycle, SlidingSyncState.Complete, {
                pos: "p",
                lists: {},
                rooms: {},
                extensions: {},
            });
            await vi.advanceTimersByTimeAsync(200);
            expect(sync.getRoomSubscriptions()).toContain("!b");

            // A failed request applies nothing, so changes after it are read after the pause again.
            sync.emit(SlidingSyncEvent.Lifecycle, SlidingSyncState.RequestFinished, null, new Error("offline"));
            addChildren(space, ["!c"]);
            await vi.advanceTimersByTimeAsync(250);
            expect(sync.getRoomSubscriptions()).toContain("!c");
        });

        it("reads changes once a response is given up on, and stops reading when the connection stops", async () => {
            vi.useFakeTimers();
            const space = knownRoom("!server", "space");
            manager.setActiveSpace("!server");
            await vi.advanceTimersByTimeAsync(0);
            // A response whose processing fails never completes.
            sync.emit(SlidingSyncEvent.Lifecycle, SlidingSyncState.RequestFinished, {
                pos: "p",
                lists: {},
                rooms: {},
                extensions: {},
            });
            addChildren(space, ["!a"]);
            await vi.advanceTimersByTimeAsync(5_000);
            expect(sync.getRoomSubscriptions()).not.toContain("!a");
            await vi.advanceTimersByTimeAsync(11_000);
            expect(sync.getRoomSubscriptions()).toContain("!a");

            // Nothing is read after the connection stops.
            addChildren(space, ["!b"]);
            const modify = vi.spyOn(sync, "modifyRoomSubscriptions");
            sync.stop();
            await vi.advanceTimersByTimeAsync(20_000);
            expect(modify).not.toHaveBeenCalled();
            expect(sync.listenerCount(SlidingSyncEvent.Lifecycle)).toBe(0);
        });

        it("waits for a response that began before the first Space was selected", async () => {
            vi.useFakeTimers();
            const space = knownRoom("!server", "space");
            sync.emit(SlidingSyncEvent.Lifecycle, SlidingSyncState.RequestFinished, {
                pos: "p",
                lists: {},
                rooms: {},
                extensions: {},
            });
            manager.setActiveSpace("!server");
            addChildren(space, ["!a"]);
            await vi.advanceTimersByTimeAsync(1_000);
            expect(sync.getRoomSubscriptions()).not.toContain("!a");
            sync.emit(SlidingSyncEvent.Lifecycle, SlidingSyncState.Complete, {
                pos: "p",
                lists: {},
                rooms: {},
                extensions: {},
            });
            await vi.advanceTimersByTimeAsync(200);
            expect(sync.getRoomSubscriptions()).toContain("!a");
        });

        it("sorts a Space's children once while they stay the same", async () => {
            const space = knownRoom("!server", "space");
            addChildren(space, ["!b", "!a"]);
            manager.setActiveSpace("!server");
            await tick();
            const internals = manager as unknown as {
                refreshSpaceChannels(): void;
                sortedChildren: Map<string, { sorted: MatrixEvent[] }>;
            };
            const sorted = internals.sortedChildren.get("!server")?.sorted;
            expect(sorted?.map((event) => event.getStateKey())).toEqual(["!a", "!b"]);
            internals.refreshSpaceChannels();
            expect(internals.sortedChildren.get("!server")?.sorted).toBe(sorted);
            // A changed child is sorted again.
            addChildren(space, ["!c"]);
            await applied();
            expect(internals.sortedChildren.get("!server")?.sorted).not.toBe(sorted);
            expect(sync.getRoomSubscriptions()).toContain("!c");
        });

        it("drops a channel whose child event is redacted, and forgets the order of Spaces left behind", async () => {
            const space = knownRoom("!server", "space");
            addChildren(space, ["!a", "!b"]);
            manager.setActiveSpace("!server");
            await tick();
            expect(sync.getRoomSubscriptions()).toEqual(new Set(["!server", "!a", "!b"]));
            // Redacting a child event changes the same object, so it is not a new event.
            const child = space.currentState.getStateEvents(EventType.SpaceChild, "!b")!;
            child.makeRedacted(
                new MatrixEvent({
                    type: EventType.RoomRedaction,
                    event_id: "$redaction",
                    room_id: "!server",
                    sender: client.getUserId()!,
                    redacts: child.getId(),
                    content: {},
                }),
                space,
            );
            space.currentState.setStateEvents([child]);
            client.emit(RoomStateEvent.Events, child, space.currentState, null);
            await applied();
            expect(sync.getRoomSubscriptions()).toEqual(new Set(["!server", "!a"]));

            const internals = manager as unknown as { sortedChildren: Map<string, unknown> };
            const other = knownRoom("!other", "space");
            addChildren(other, ["!c"]);
            manager.setActiveSpace("!other");
            await tick();
            expect([...internals.sortedChildren.keys()]).toEqual(["!other"]);
        });

        it("follows a child event redacted locally, and the redaction being cancelled", async () => {
            const space = knownRoom("!server", "space");
            addChildren(space, ["!a", "!b"]);
            manager.setActiveSpace("!server");
            await tick();
            const child = space.currentState.getStateEvents(EventType.SpaceChild, "!b")!;
            const redaction = new MatrixEvent({
                type: EventType.RoomRedaction,
                event_id: "~local-redaction",
                room_id: "!server",
                sender: client.getUserId()!,
                redacts: child.getId(),
                content: {},
            });
            // A redaction being sent changes the child in place, with no state event.
            child.markLocallyRedacted(redaction);
            client.emit(RoomEvent.Redaction, redaction, space);
            await applied();
            expect(sync.getRoomSubscriptions()).toEqual(new Set(["!server", "!a"]));
            // Another child arrives while the redaction is still pending.
            addChildren(space, ["!c"]);
            await applied();
            expect(sync.getRoomSubscriptions()).toEqual(new Set(["!server", "!a", "!c"]));
            // Sending the redaction failed and it is cancelled: the child is back.
            child.unmarkLocallyRedacted();
            client.emit(RoomEvent.RedactionCancelled, redaction, space);
            await applied();
            expect(sync.getRoomSubscriptions()).toEqual(new Set(["!server", "!a", "!b", "!c"]));
        });

        it("subscribes an unseen replacement of an upgraded subspace, and keeps the old one's channels", async () => {
            const space = knownRoom("!server", "space");
            const category = knownRoom("!category", "space");
            category.updateMyMembership(KnownMembership.Join);
            category.currentState.setStateEvents([
                new MatrixEvent({
                    type: EventType.RoomTombstone,
                    state_key: "",
                    event_id: "$tombstone!category",
                    room_id: "!category",
                    sender: client.getUserId()!,
                    content: { replacement_room: "!new-category", body: "upgraded" },
                }),
            ]);
            addChildren(category, ["!c"]);
            addChildren(space, ["!category"]);
            manager.setActiveSpace("!server");
            await tick();
            expect(sync.getRoomSubscriptions()).toEqual(new Set(["!server", "!new-category", "!c"]));
        });

        it("asks about the first channels nobody has seen in the Space's own order, a few at a time", async () => {
            const space = knownRoom("!server", "space");
            // Listed in reverse of their order, so the Space's order decides, not arrival.
            const events = Array.from({ length: 250 }, (_, i) => 249 - i).map(
                (i) =>
                    new MatrixEvent({
                        type: EventType.SpaceChild,
                        state_key: `!channel${i}`,
                        event_id: `$child${i}`,
                        room_id: "!server",
                        sender: client.getUserId()!,
                        content: { via: ["example.org"], order: String(i).padStart(3, "0") },
                    }),
            );
            space.currentState.setStateEvents(events);
            manager.setActiveSpace("!server");
            await tick();
            const first = Array.from({ length: 8 }, (_, i) => `!channel${i}`);
            expect(sync.getRoomSubscriptions()).toEqual(new Set(["!server", ...first]));

            // The tree read again before an answer, such as when a child is added, asks about no more of them.
            addChildren(space, ["!late"], { via: ["example.org"], order: "999" });
            await tick();
            addChildren(space, ["!later"], { via: ["example.org"], order: "999" });
            await tick();
            expect(sync.getRoomSubscriptions()).toEqual(new Set(["!server", ...first]));

            // Answered without them, as the server does not serve rooms the user has never been in: the next ones
            // are asked about instead, and those are not asked about again.
            const response = { pos: "p", lists: {}, rooms: {}, extensions: {} };
            vi.spyOn(sync, "getRequestForResponse").mockImplementation((answered) =>
                answered === response
                    ? { roomSubscriptions: new Map(first.map((roomId) => [roomId, subscriptionOf(roomId)])) }
                    : undefined,
            );
            sync.emit(SlidingSyncEvent.Lifecycle, SlidingSyncState.Complete, response);
            await tick();
            expect(sync.getRoomSubscriptions()).toEqual(
                new Set(["!server", ...Array.from({ length: 8 }, (_, i) => `!channel${i + 8}`)]),
            );
        });

        it("asks about a channel the server did not send again once someone opens it", async () => {
            const space = knownRoom("!server", "space");
            addChildren(space, ["!private"]);
            manager.setActiveSpace("!server");
            await tick();
            expect(sync.getRoomSubscriptions()).toContain("!private");
            const response = { pos: "p", lists: {}, rooms: {}, extensions: {} };
            vi.spyOn(sync, "getRequestForResponse").mockImplementation((answered) =>
                answered === response
                    ? { roomSubscriptions: new Map([["!private", subscriptionOf("!private")]]) }
                    : undefined,
            );
            sync.emit(SlidingSyncEvent.Lifecycle, SlidingSyncState.Complete, response);
            await tick();
            expect(sync.getRoomSubscriptions()).not.toContain("!private");

            void manager.setRoomVisible("!private");
            await tick();
            expect(sync.getRoomSubscriptions()).toContain("!private");
            // Once the user has looked away, it is a channel to ask about again, as before.
            expect((manager as unknown as { unsuppliedRooms: Set<string> }).unsuppliedRooms.has("!private")).toBe(
                false,
            );
        });

        it("asks about a channel that has arrived no more: it is a known channel", async () => {
            const space = knownRoom("!server", "space");
            addChildren(space, ["!new"]);
            manager.setActiveSpace("!server");
            await tick();
            const response = { pos: "p", lists: {}, rooms: {}, extensions: {} };
            vi.spyOn(sync, "getRequestForResponse").mockImplementation((answered) =>
                answered === response ? { roomSubscriptions: new Map([["!new", subscriptionOf("!new")]]) } : undefined,
            );
            // It arrives in the response, so it stays subscribed as a known channel until the lists cover it.
            client.emit(ClientEvent.Room, knownRoom("!new"));
            sync.emit(SlidingSyncEvent.Lifecycle, SlidingSyncState.Complete, response);
            await tick();
            expect(sync.getRoomSubscriptions()).toContain("!new");
            expect(nameOf("!new")).toBe("channel");
        });

        it("sends a Space and its channels along with the channel opened next, in one request", async () => {
            vi.useFakeTimers();
            const space = knownRoom("!server", "space");
            knownRoom("!a");
            addChildren(space, ["!a", "!b"]);
            await vi.advanceTimersByTimeAsync(0);
            const modify = vi.spyOn(sync, "modifyRoomSubscriptions");
            manager.setActiveSpace("!server");
            await vi.advanceTimersByTimeAsync(20);
            expect(modify).not.toHaveBeenCalled();
            // The channel is opened right after: one request carries everything.
            const lease = (manager as unknown as { leases: RoomSubscriptionLeases }).leases.acquire("!a", "view");
            await vi.advanceTimersByTimeAsync(0);
            expect(modify).toHaveBeenCalledExactlyOnceWith(new Set(["!a", "!server", "!b"]));
            await vi.advanceTimersByTimeAsync(500);
            expect(modify).toHaveBeenCalledTimes(1);
            lease.release();
        });

        it("leaves out joined channels the lists keep up to date, once they cover the whole account", async () => {
            const space = knownRoom("!server", "space");
            knownRoom("!joined").updateMyMembership(KnownMembership.Join);
            addChildren(space, ["!joined", "!unseen"]);
            manager.setActiveSpace("!server");
            await tick();
            expect(sync.getRoomSubscriptions()).toEqual(new Set(["!server", "!joined", "!unseen"]));
            // Spidering finishes: every list covers all the rooms there are.
            const covered = vi.fn();
            manager.onArrivalChange(covered);
            vi.spyOn(sync, "getListData").mockReturnValue({ joinedCount: 0 });
            await (
                manager as unknown as { startSpidering(sync: SlidingSync, batch: number, gap: number): Promise<void> }
            ).startSpidering(sync, 10, 1);
            await applied();
            await vi.waitFor(() => expect(sync.getRoomSubscriptions()).toEqual(new Set(["!server", "!unseen"])));
            // A room the lists did not bring is not the user's, unless this device saved it and has not applied it.
            expect(manager.mayStillArrive("!elsewhere")).toBe(false);
            expect(covered).toHaveBeenCalled();
            sync.setSavedRooms({ has: (roomId) => roomId === "!elsewhere", restore: async () => {} });
            expect(manager.mayStillArrive("!elsewhere")).toBe(true);
        });

        it("applies the open Space's saved channels while the page is idle, asking once for each", async () => {
            const space = knownRoom("!server", "space");
            addChildren(space, ["!a", "!b"]);
            const restore = vi.fn(async () => {});
            sync.setSavedRooms({ has: (roomId) => roomId === "!a", restore });
            manager.setActiveSpace("!server");
            await tick();
            expect(restore).toHaveBeenCalledExactlyOnceWith(["!a"], true);
            addChildren(space, ["!c"]);
            await applied();
            await vi.waitFor(() => expect(sync.getRoomSubscriptions()).toContain("!c"));
            expect(restore).toHaveBeenCalledTimes(1);
        });

        it("subscribes joined channels again when a list outgrows its range after spidering", async () => {
            const space = knownRoom("!server", "space");
            knownRoom("!joined").updateMyMembership(KnownMembership.Join);
            addChildren(space, ["!joined"]);
            manager.setActiveSpace("!server");
            let count = 0;
            vi.spyOn(sync, "getListData").mockImplementation(() => ({ joinedCount: count }));
            await (
                manager as unknown as { startSpidering(sync: SlidingSync, batch: number, gap: number): Promise<void> }
            ).startSpidering(sync, 10, 1);
            await applied();
            await vi.waitFor(() => expect(sync.getRoomSubscriptions()).toEqual(new Set(["!server"])));

            // A room joined since pushes the least active one out of the untagged list's range.
            count = 500;
            const ranges = vi.spyOn(sync, "setListRanges");
            await applied();
            await vi.waitFor(() => expect(sync.getRoomSubscriptions()).toEqual(new Set(["!server", "!joined"])));
            // Spidering grows the lists again.
            await applied();
            await vi.waitFor(() => expect(ranges).toHaveBeenCalledWith("untagged", [[0, expect.any(Number)]]));
        });

        it("leaves out channels the user has left or been banned from", async () => {
            const space = knownRoom("!server", "space");
            for (const [roomId, membership] of [
                ["!left", KnownMembership.Leave],
                ["!banned", KnownMembership.Ban],
                ["!joined", KnownMembership.Join],
            ] as const) {
                knownRoom(roomId).currentState.setStateEvents([
                    new MatrixEvent({
                        type: EventType.RoomMember,
                        state_key: client.getUserId()!,
                        event_id: `$member${roomId}`,
                        room_id: roomId,
                        sender: client.getUserId()!,
                        content: { membership },
                    }),
                ]);
            }
            addChildren(space, ["!left", "!banned", "!joined"]);
            manager.setActiveSpace("!server");
            await tick();
            expect(sync.getRoomSubscriptions()).toEqual(new Set(["!server", "!joined"]));
        });

        it("looks at a bounded number of children in a huge Space", async () => {
            const space = knownRoom("!server", "space");
            addChildren(
                space,
                Array.from({ length: 5000 }, (_, i) => `!sub${i}`),
            );
            for (let i = 0; i < 5000; i++) knownRoom(`!sub${i}`, "space");
            const lookups = vi.mocked(client.getRoom);
            lookups.mockClear();
            manager.setActiveSpace("!server");
            await tick();
            expect(lookups.mock.calls.length).toBeLessThan(2500);
        });

        it("gives a channel someone points at the shorter history of a likely visit, then a channel's again", async () => {
            vi.useFakeTimers();
            const space = knownRoom("!server", "space");
            knownRoom("!a");
            addChildren(space, ["!a"]);
            manager.setActiveSpace("!server");
            await vi.advanceTimersByTimeAsync(0);
            manager.prefetchRoom("!a");
            await vi.advanceTimersByTimeAsync(200);
            expect(nameOf("!a")).toBe("prefetch");
            // Every request carries every subscription, so once the visit is no longer likely a channel's will do.
            await vi.advanceTimersByTimeAsync(60_000);
            expect(nameOf("!a")).toBe("channel");
            expect(sync.getRoomSubscriptions()).toContain("!a");
        });

        it("follows the Space's children as its state changes", async () => {
            const space = knownRoom("!server", "space");
            manager.setActiveSpace("!server");
            await tick();
            expect(sync.getRoomSubscriptions()).toEqual(new Set(["!server"]));

            // The Space's state arrives after it was selected, such as on a first start.
            addChildren(space, ["!a", "!b"]);
            await applied();
            expect(sync.getRoomSubscriptions()).toEqual(new Set(["!server", "!a", "!b"]));
            addChildren(space, ["!b"], {});
            await applied();
            expect(sync.getRoomSubscriptions()).toEqual(new Set(["!server", "!a"]));

            // Another Space's children do not count.
            const other = knownRoom("!other", "space");
            addChildren(other, ["!elsewhere"]);
            await applied();
            expect(sync.getRoomSubscriptions()).not.toContain("!elsewhere");
        });

        it("gives an open channel its room subscription, then a channel's once its grace period ends", async () => {
            vi.useFakeTimers();
            const space = knownRoom("!server", "space");
            knownRoom("!a");
            addChildren(space, ["!a"]);
            manager.setActiveSpace("!server");
            await vi.advanceTimersByTimeAsync(200);
            expect(nameOf("!a")).toBe("channel");
            const lease = (manager as unknown as { leases: RoomSubscriptionLeases }).leases.acquire("!a", "view");
            await vi.advanceTimersByTimeAsync(0);
            expect(nameOf("!a")).toBe("room");
            lease.release();
            await vi.advanceTimersByTimeAsync(120_000);
            expect(nameOf("!a")).toBe("channel");
            expect(sync.getRoomSubscriptions()).toContain("!a");
        });

        it("subscribes no more than 32 channels of a Space, as every request carries them all", async () => {
            const space = knownRoom("!server", "space");
            const channels = Array.from({ length: 250 }, (_, i) => `!channel${i}`);
            for (const roomId of channels) knownRoom(roomId);
            addChildren(space, channels);
            manager.setActiveSpace("!server");
            await tick();
            // Without an order of their own, the Space orders them by room ID.
            expect(sync.getRoomSubscriptions()).toEqual(new Set(["!server", ...[...channels].sort().slice(0, 32)]));
        });

        it("holds back the Space's channels that would make a request too large, but not the open room", async () => {
            const space = knownRoom("!server", "space");
            const channels = Array.from({ length: 10 }, (_, i) => `!channel${i}`);
            for (const roomId of channels) knownRoom(roomId);
            addChildren(space, channels);
            knownRoom("!open");
            // Lists as large as the whole budget leave no room for optional subscriptions.
            vi.spyOn(sync, "getListParams").mockReturnValue({
                ranges: [[0, 0]],
                required_state: [["x".repeat(64 * 1024), ""]],
            });
            await manager.setRoomVisible("!open");
            manager.setActiveSpace("!server");
            await tick();
            expect(sync.getRoomSubscriptions()).toEqual(new Set(["!server", "!open"]));
        });

        it("applies a Space selected before the connection existed", async () => {
            const fresh = new SlidingSyncManager();
            fresh.setActiveSpace("!early");
            const freshSync = (await fresh.setup(client))!;
            expect(freshSync.getRoomSubscriptions()).toContain("!early");
            freshSync.stop();
        });

        it("keeps a room held for its settings subscribed as an open room, until the last hold is released", async () => {
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
            knownRoom("!listed");
            knownRoom("!server", "space");
            const releaseRoom = manager.holdRoom("!listed");
            const releaseAgain = manager.holdRoom("!listed");
            const releaseSpace = manager.holdRoom("!server");
            // Someone is waiting for the settings: the subscriptions go out with the next request.
            await vi.advanceTimersByTimeAsync(0);
            expect(sync.getRoomSubscriptions()).toEqual(new Set(["!listed", "!server"]));
            expect(nameOf("!listed")).toBe("room");
            expect(nameOf("!server")).toBe("space");

            releaseRoom();
            releaseRoom();
            releaseSpace();
            await vi.advanceTimersByTimeAsync(60_200);
            expect(sync.getRoomSubscriptions()).toEqual(new Set(["!listed"]));
            releaseAgain();
            await vi.advanceTimersByTimeAsync(60_200);
            expect(sync.getRoomSubscriptions()).toEqual(new Set());
        });

        it("ignores holds on room aliases", async () => {
            const release = manager.holdRoom("#garden:example.org");
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(sync.getRoomSubscriptions()).toEqual(new Set());
            expect(release).not.toThrow();
        });

        it("subscribes held rooms on a connection that starts later, and on one that replaces it", async () => {
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
            const fresh = new SlidingSyncManager();
            const release = fresh.holdRoom("!early");
            const first = (await fresh.setup(client))!;
            expect(first.getRoomSubscriptions()).toContain("!early");
            const second = (await fresh.setup(client))!;
            expect(second.getRoomSubscriptions()).toContain("!early");

            release();
            await vi.advanceTimersByTimeAsync(60_200);
            expect(second.getRoomSubscriptions()).not.toContain("!early");
            first.stop();
            second.stop();
        });

        describe("demanded room state", () => {
            const INSTALLATIONS = "io.element.integrations.installations";

            /** Apply an answer to a request that carried these rooms' current subscriptions. */
            function answer(roomIds: string[], rooms: Record<string, object> = {}): void {
                const response = { pos: "n", lists: {}, rooms, extensions: {} } as MSC3575SlidingSyncResponse;
                vi.spyOn(sync, "getRequestForResponse").mockReturnValue({
                    roomSubscriptions: new Map(roomIds.map((roomId) => [roomId, subscriptionOf(roomId)])),
                });
                sync.emit(SlidingSyncEvent.Applied, response);
            }

            it("subscribes a room only read from with a list entry's state and the demanded state", async () => {
                knownRoom("!plain");
                knownRoom("!secret", "encrypted");
                manager.demandRoomState("!plain", [{ type: INSTALLATIONS }]);
                manager.demandRoomState("!secret", [{ type: INSTALLATIONS, stateKey: "abc" }]);
                await tick();
                expect(sync.getRoomSubscriptions()).toEqual(new Set(["!plain", "!secret"]));
                expect(subscriptionOf("!plain").timeline_limit).toBe(0);
                expect(subscriptionOf("!plain").required_state).toEqual([...CATALOG_STATE, [INSTALLATIONS, "*"]]);
                // An encrypted room is not given every member just to read some of its state.
                expect(subscriptionOf("!secret").required_state).toContainEqual([INSTALLATIONS, "abc"]);
                expect(subscriptionOf("!secret").required_state).not.toContainEqual(["*", "*"]);
            });

            it("adds demanded state to an open room's subscription, unless it brings it already", async () => {
                knownRoom("!open");
                knownRoom("!secret", "encrypted");
                await manager.setRoomVisible("!open");
                manager.setCallRooms(["!secret"]);
                manager.demandRoomState("!open", [{ type: INSTALLATIONS }]);
                manager.demandRoomState("!secret", [{ type: INSTALLATIONS }]);
                await tick();
                expect(subscriptionOf("!open").timeline_limit).toBe(50);
                expect(subscriptionOf("!open").required_state).toContainEqual([INSTALLATIONS, "*"]);
                expect(nameOf("!secret")).toBe("encrypted");
            });

            it("reads demanded state once an answer naming it has been applied, then lets go", async () => {
                vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
                const room = knownRoom("!plain");
                const read = manager.readRoomState(client, "!plain", { type: INSTALLATIONS, stateKey: "abc" });
                await vi.advanceTimersByTimeAsync(0);
                expect(sync.getRoomSubscriptions()).toContain("!plain");

                // An answer to the request sent before the demand does not name its state.
                vi.spyOn(sync, "getRequestForResponse").mockReturnValue({
                    roomSubscriptions: new Map([["!plain", { timeline_limit: 0, required_state: CATALOG_STATE }]]),
                });
                sync.emit(SlidingSyncEvent.Applied, { pos: "o", lists: {}, rooms: {}, extensions: {} });
                const event = new MatrixEvent({
                    type: INSTALLATIONS,
                    state_key: "abc",
                    content: { foo: "bar" },
                    room_id: "!plain",
                    sender: client.getUserId()!,
                    event_id: "$installation",
                });
                room.currentState.setStateEvents([event]);
                answer(["!plain"]);
                await expect(read).resolves.toEqual([event]);

                await vi.advanceTimersByTimeAsync(DEMAND_LINGER_MS + 200);
                expect(sync.getRoomSubscriptions()).not.toContain("!plain");
            });

            it("finds no state in a room the server does not serve", async () => {
                const read = manager.readRoomState(client, "!unknown", { type: INSTALLATIONS });
                await tick();
                expect(sync.getRoomSubscriptions()).toContain("!unknown");
                answer(["!unknown"]);
                await expect(read).resolves.toEqual([]);
            });

            it("gives up when the server does not answer in time", async () => {
                vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
                knownRoom("!plain");
                const outcome = manager
                    .readRoomState(client, "!plain", { type: INSTALLATIONS }, 1000)
                    .catch((error: unknown) => error);
                await vi.advanceTimersByTimeAsync(1000);
                expect(await outcome).toBeInstanceOf(RoomStateUnavailableError);
            });

            it("reads a list entry's state at once", async () => {
                knownRoom("!listed");
                (manager as unknown as { liveRooms: Set<string> }).liveRooms.add("!listed");
                const modify = vi.spyOn(sync, "modifyRoomSubscriptions");
                await expect(
                    manager.readRoomState(client, "!listed", {
                        type: "io.element.functional_members",
                        stateKey: "",
                    }),
                ).resolves.toEqual([]);
                await tick();
                expect(modify).not.toHaveBeenCalled();
            });

            it("reads every member as loaded, without asking for them all", async () => {
                // As under regular sync, members are loaded lazily: asking for all of them would bring every
                // member of a large room.
                knownRoom("!large");
                await expect(manager.readRoomState(client, "!large", { type: EventType.RoomMember })).resolves.toEqual(
                    [],
                );
                await tick();
                expect(sync.getRoomSubscriptions()).not.toContain("!large");
            });

            it("reads a few rooms at a time", async () => {
                const roomIds = Array.from({ length: MAX_STATE_READ_ROOMS + 1 }, (_, i) => `!room${i}`);
                for (const roomId of roomIds) knownRoom(roomId);
                const reads = roomIds.map((roomId) => manager.readRoomState(client, roomId, { type: INSTALLATIONS }));
                await tick();
                expect(sync.getRoomSubscriptions().size).toBe(MAX_STATE_READ_ROOMS);
                expect(sync.getRoomSubscriptions()).not.toContain(roomIds[MAX_STATE_READ_ROOMS]);

                answer([roomIds[0]]);
                await expect(reads[0]).resolves.toEqual([]);
                await tick();
                expect(sync.getRoomSubscriptions()).toContain(roomIds[MAX_STATE_READ_ROOMS]);
                answer(roomIds);
                await expect(Promise.all(reads)).resolves.toHaveLength(roomIds.length);
            });

            it("asks for state demanded before sliding sync started, once it has", async () => {
                const fresh = new SlidingSyncManager();
                const demand = fresh.demandRoomState("!early", [{ type: INSTALLATIONS }]);
                // Without sliding sync the room's state is all here.
                expect(demand.isReady()).toBe(true);
                const freshSync = (await fresh.setup(client))!;
                expect(freshSync.getRoomSubscriptions()).toContain("!early");
                expect(demand.isReady()).toBe(false);
                demand.release();
                freshSync.stop();
            });

            it("asks nothing for state every list entry brings", async () => {
                knownRoom("!listed");
                const demand = manager.demandRoomState("!listed", [
                    { type: "io.element.functional_members", stateKey: "" },
                ]);
                await tick();
                expect(demand.isReady()).toBe(true);
                expect(sync.getRoomSubscriptions()).not.toContain("!listed");
            });

            it("refuses to ask for every event type", () => {
                expect(() => manager.demandRoomState("!plain", [{ type: "*" }])).toThrow();
            });

            it("asks for demanded state again on a new connection", async () => {
                knownRoom("!plain");
                const demand = manager.demandRoomState("!plain", [{ type: INSTALLATIONS }]);
                await tick();
                answer(["!plain"]);
                expect(demand.isReady()).toBe(true);

                const next = (await manager.setup(client))!;
                expect(demand.isReady()).toBe(false);
                expect(next.getRoomSubscriptions()).toContain("!plain");
                next.stop();
            });
        });

        it("reads a client's state as it is without sliding sync", async () => {
            const room = knownRoom("!plain");
            const event = new MatrixEvent({
                type: "io.element.integrations.installations",
                state_key: "abc",
                content: {},
                room_id: "!plain",
                sender: client.getUserId()!,
                event_id: "$installation",
            });
            room.currentState.setStateEvents([event]);
            const idle = new SlidingSyncManager();
            await expect(
                idle.readRoomState(client, "!plain", { type: "io.element.integrations.installations" }),
            ).resolves.toEqual([event]);
            expect(idle.demandRoomState("!plain", [{ type: "io.element.integrations.installations" }]).isReady()).toBe(
                true,
            );
        });

        it("does nothing for prefetches and calls without sliding sync", () => {
            const idle = new SlidingSyncManager();
            expect(() => {
                idle.prefetchRoom("!a");
                idle.setCallRooms(["!a"]);
            }).not.toThrow();
        });
    });

    describe("rooms saved on this device", () => {
        // Several tests replace how the cache reads; each starts from the real one.
        afterEach(() => vi.restoreAllMocks());

        it("offers the saved rooms only to the client it was set up for", async () => {
            await manager.setup(client);
            expect(manager.snapshotLoader(client)).toBeInstanceOf(Function);
            expect(manager.snapshotLoader(stubClient())).toBeUndefined();
            await expect(manager.snapshotLoader(client)!()).resolves.toBeNull();
        });

        it("asks for the room and Space opened at start to be shown first", async () => {
            await manager.setup(client, undefined, { roomId: "!room", spaceId: "!space" });
            const cache = (manager as unknown as { cache: { load(): Promise<unknown> } }).cache;
            vi.spyOn(cache, "load").mockResolvedValue({ rooms: {} });
            await expect(manager.snapshotLoader(client)!()).resolves.toEqual({
                rooms: {},
                priorityRoomIds: ["!room", "!space"],
            });
        });

        it("starts reading the saved rooms before set-up, and uses that cache and read once", async () => {
            const load = vi.spyOn(SlidingSyncCache.prototype, "load").mockResolvedValue({ rooms: {} });
            manager.prefetchSnapshot(client);
            expect(load).toHaveBeenCalledTimes(1);
            await manager.setup(client);
            const internals = manager as unknown as { cache: SlidingSyncCache; prefetched?: unknown };
            expect(load.mock.contexts[0]).toBe(internals.cache);
            await expect(manager.snapshotLoader(client)!()).resolves.toEqual({ rooms: {}, priorityRoomIds: [] });
            expect(load).toHaveBeenCalledTimes(1);
            // A later start reads afresh.
            await manager.snapshotLoader(client)!();
            expect(load).toHaveBeenCalledTimes(2);
        });

        it("does not use an early read made for another client", async () => {
            const load = vi.spyOn(SlidingSyncCache.prototype, "load").mockResolvedValue(null);
            manager.prefetchSnapshot(stubClient());
            await manager.setup(client);
            await manager.snapshotLoader(client)!();
            expect(load).toHaveBeenCalledTimes(2);
            expect(load.mock.contexts[1]).toBe((manager as unknown as { cache: SlidingSyncCache }).cache);
        });

        it("reads afresh, rather than adopt an early read whose saved data was deleted before set-up", async () => {
            vi.spyOn(SlidingSyncCache.prototype, "load").mockResolvedValue({ rooms: { "!a": {} as never } });
            manager.prefetchSnapshot(client);
            const early = (manager as unknown as { prefetched: { cache: SlidingSyncCache } }).prefetched.cache;
            await SlidingSyncCache.deleteAll();
            await manager.setup(client);
            // The deleted cache is not adopted, and its rooms are not shown.
            expect((manager as unknown as { cache: SlidingSyncCache }).cache).not.toBe(early);
            await expect(manager.snapshotLoader(client)!()).resolves.toEqual({
                rooms: { "!a": {} },
                priorityRoomIds: [],
            });
        });

        it("drops saved rooms read early when the cache is deleted while the client starts", async () => {
            const read = Promise.withResolvers<{ rooms: Record<string, never> }>();
            vi.spyOn(SlidingSyncCache.prototype, "load").mockReturnValue(read.promise as never);
            manager.prefetchSnapshot(client);
            await manager.setup(client);
            const loader = manager.snapshotLoader(client)!;
            await SlidingSyncCache.deleteAll();
            read.resolve({ rooms: { "!a": {} as never } });
            await expect(loader()).resolves.toBeNull();
        });

        it("shows no saved rooms when set-up overlaps deleting them, with a write still under way", async () => {
            const saved = new SlidingSyncCache(client.getUserId()!, client.getDeviceId()!);
            const room = (name: string) => ({ name, required_state: [], timeline: [] }) as unknown as MSC3575RoomData;
            saved.observeRoomData("!a", room("A"));
            await saved.flush();
            saved.observeRoomData("!b", room("B"));
            const writing = saved.flush();
            manager.prefetchSnapshot(client);
            const deletion = SlidingSyncCache.deleteAll();
            await manager.setup(client);
            const loaded = manager.snapshotLoader(client)!();
            await Promise.all([writing, deletion]);
            await expect(loaded).resolves.toBeNull();
        });

        it("lets go of an early read when the client syncs without sliding sync after all", async () => {
            const dispose = vi.spyOn(SlidingSyncCache.prototype, "dispose");
            vi.spyOn(SlidingSyncCache.prototype, "load").mockResolvedValue(null);
            manager.prefetchSnapshot(client);
            const early = (manager as unknown as { prefetched: { cache: SlidingSyncCache } }).prefetched.cache;
            manager.discardPrefetchedSnapshot();
            expect(dispose.mock.contexts).toContain(early);
            expect((manager as unknown as { prefetched?: unknown }).prefetched).toBeUndefined();
        });

        it("lets go of an early read made for another client", async () => {
            const dispose = vi.spyOn(SlidingSyncCache.prototype, "dispose");
            vi.spyOn(SlidingSyncCache.prototype, "load").mockResolvedValue(null);
            manager.prefetchSnapshot(stubClient());
            const early = (manager as unknown as { prefetched: { cache: SlidingSyncCache } }).prefetched.cache;
            await manager.setup(client);
            expect(dispose.mock.contexts).toContain(early);
        });

        it("writes what it keeps at once when the page is hidden or closed", async () => {
            await manager.setup(client);
            const cache = (manager as unknown as { cache: { flushNow(): void } }).cache;
            const flushNow = vi.spyOn(cache, "flushNow");
            window.dispatchEvent(new Event("pagehide"));
            expect(flushNow).toHaveBeenCalledTimes(1);
            vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
            document.dispatchEvent(new Event("visibilitychange"));
            expect(flushNow).toHaveBeenCalledTimes(2);
        });

        it("keeps no saved rooms for a session without a device", async () => {
            vi.mocked(client.getDeviceId).mockReturnValue(null);
            await manager.setup(client);
            expect(manager.snapshotLoader(client)).toBeUndefined();
        });

        it("marks saved rooms the user is no longer in as left, from the server's list of joined rooms", async () => {
            const sync = (await manager.setup(client))!;
            const cache = (
                manager as unknown as { cache: { restoredRoomIds: ReadonlySet<string>; forgetRooms: () => void } }
            ).cache;
            vi.spyOn(cache, "restoredRoomIds", "get").mockReturnValue(
                new Set(["!kept:example.org", "!invited:example.org", "!gone:example.org"]),
            );
            const forget = vi.spyOn(cache, "forgetRooms");
            const rooms = new Map(
                [
                    ["!kept:example.org", KnownMembership.Join],
                    ["!invited:example.org", KnownMembership.Invite],
                    ["!gone:example.org", KnownMembership.Join],
                ].map(([roomId, membership]) => {
                    const room = new Room(roomId, client, client.getUserId()!);
                    room.updateMyMembership(membership);
                    return [roomId, room] as const;
                }),
            );
            vi.mocked(client.getRoom).mockImplementation((roomId) => rooms.get(roomId!) ?? null);
            const joinedRooms = vi
                .fn()
                .mockRejectedValueOnce(new Error("offline"))
                .mockResolvedValue({ joined_rooms: ["!kept:example.org"] });
            client.getJoinedRooms = joinedRooms;
            const respond = (): void => {
                sync.emit(SlidingSyncEvent.Lifecycle, SlidingSyncState.Complete, {
                    pos: "p",
                    lists: {},
                    rooms: {},
                    extensions: {},
                });
            };

            // The first check fails and is tried again with the next response.
            respond();
            await vi.waitFor(() => expect(joinedRooms).toHaveBeenCalledTimes(1));
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(forget).not.toHaveBeenCalled();
            respond();
            const changes = vi.fn();
            manager.onArrivalChange(changes);
            await vi.waitFor(() => expect(forget).toHaveBeenCalledExactlyOnceWith(["!gone:example.org"]));
            expect(rooms.get("!gone:example.org")!.getMyMembership()).toBe(KnownMembership.Leave);
            expect(rooms.get("!kept:example.org")!.getMyMembership()).toBe(KnownMembership.Join);
            expect(rooms.get("!invited:example.org")!.getMyMembership()).toBe(KnownMembership.Invite);
            // Said to have been left while this device was away, until the user is back in it.
            expect(manager.wasLeftWhileAway("!gone:example.org")).toBe(true);
            expect(manager.wasLeftWhileAway("!kept:example.org")).toBe(false);
            expect(changes).toHaveBeenCalled();
            const rejoined = rooms.get("!gone:example.org")!;
            rejoined.updateMyMembership(KnownMembership.Join);
            client.emit(RoomEvent.MyMembership, rejoined, KnownMembership.Join, KnownMembership.Leave);
            expect(manager.wasLeftWhileAway("!gone:example.org")).toBe(false);
            // Checked once per connection.
            respond();
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(joinedRooms).toHaveBeenCalledTimes(2);
            sync.stop();
        });

        it("checks again saved rooms that sliding sync reports while the joined rooms are fetched", async () => {
            const sync = (await manager.setup(client))!;
            const cache = (
                manager as unknown as { cache: { restoredRoomIds: ReadonlySet<string>; forgetRooms: () => void } }
            ).cache;
            vi.spyOn(cache, "restoredRoomIds", "get").mockReturnValue(
                new Set(["!rejoined:example.org", "!left:example.org", "!gone:example.org"]),
            );
            const forget = vi.spyOn(cache, "forgetRooms");
            const rooms = new Map(
                ["!rejoined:example.org", "!left:example.org", "!gone:example.org"].map((roomId) => {
                    const room = new Room(roomId, client, client.getUserId()!);
                    room.updateMyMembership(KnownMembership.Join);
                    return [roomId, room] as const;
                }),
            );
            vi.mocked(client.getRoom).mockImplementation((roomId) => rooms.get(roomId!) ?? null);
            const first = Promise.withResolvers<{ joined_rooms: string[] }>();
            const joinedRooms = vi
                .fn()
                .mockReturnValueOnce(first.promise)
                .mockResolvedValue({ joined_rooms: ["!rejoined:example.org"] });
            client.getJoinedRooms = joinedRooms;
            const respond = (): void => {
                sync.emit(SlidingSyncEvent.Lifecycle, SlidingSyncState.Complete, {
                    pos: "p",
                    lists: {},
                    rooms: {},
                    extensions: {},
                });
            };

            respond();
            await vi.waitFor(() => expect(joinedRooms).toHaveBeenCalledTimes(1));
            // While the list is fetched, sliding sync reports a room rejoined after the list was made, and older
            // data for a room left before it was made. Neither can be decided from this list.
            sync.emit(SlidingSyncEvent.RoomData, "!rejoined:example.org", { name: "Rejoined" } as MSC3575RoomData);
            sync.emit(SlidingSyncEvent.RoomData, "!left:example.org", { name: "Left" } as MSC3575RoomData);
            first.resolve({ joined_rooms: [] });
            await vi.waitFor(() => expect(forget).toHaveBeenCalledExactlyOnceWith(["!gone:example.org"]));
            expect(rooms.get("!rejoined:example.org")!.getMyMembership()).toBe(KnownMembership.Join);
            expect(rooms.get("!left:example.org")!.getMyMembership()).toBe(KnownMembership.Join);

            // The next response checks those two again.
            respond();
            await vi.waitFor(() => expect(forget).toHaveBeenLastCalledWith(["!left:example.org"]));
            expect(rooms.get("!left:example.org")!.getMyMembership()).toBe(KnownMembership.Leave);
            expect(rooms.get("!rejoined:example.org")!.getMyMembership()).toBe(KnownMembership.Join);
            // Then the check is over.
            respond();
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(joinedRooms).toHaveBeenCalledTimes(2);
            sync.stop();
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
