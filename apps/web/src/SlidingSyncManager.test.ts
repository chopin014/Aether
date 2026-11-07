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
} from "matrix-js-sdk/src/sliding-sync";
import { ClientEvent, EventType, createClient, type MatrixClient, MatrixEvent, Room } from "matrix-js-sdk/src/matrix";
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

import { SlidingSyncManager } from "./SlidingSyncManager";
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
            await vi.waitFor(() => expect(sync.listenerCount(SlidingSyncEvent.Lifecycle)).toBe(0));
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
            expect(sync.listenerCount(SlidingSyncEvent.Lifecycle)).toBe(0);
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
    });
    describe("room subscription leases", () => {
        const rooms = new Map<string, Room>();
        let sync: SlidingSync;
        let internals: {
            roomIdToCustomSubscription: Map<string, string>;
            customSubscriptions: Map<string, { timeline_limit: number; required_state: string[][] }>;
            confirmedRoomSubscriptions: Set<string>;
        };
        const nameOf = (roomId: string): string | undefined => internals.roomIdToCustomSubscription.get(roomId);
        const subscriptionOf = (roomId: string): { timeline_limit: number; required_state: string[][] } =>
            internals.customSubscriptions.get(nameOf(roomId)!)!;
        const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

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
            const visible = manager.setRoomVisible("!missing");
            await tick();
            expect(nameOf("!missing")).toBe("bootstrap");
            // A response to an older request, before the subscription was acknowledged, proves nothing.
            sync.emit(SlidingSyncEvent.Lifecycle, SlidingSyncState.Complete, {
                pos: "1",
                lists: {},
                rooms: {},
                extensions: {},
            });
            internals.confirmedRoomSubscriptions.add("!missing");
            sync.emit(SlidingSyncEvent.Lifecycle, SlidingSyncState.Complete, {
                pos: "2",
                lists: {},
                rooms: {},
                extensions: {},
            });
            await expect(visible).resolves.toBe("absent");
            expect((manager as unknown as { bootstrapRooms: Set<string> }).bootstrapRooms.has("!missing")).toBe(false);
            expect(manager.initialTimelinePreparation(client, "!missing")).toBeUndefined();
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

        it("lists the selected Space's channels first, once per Space", async () => {
            knownRoom("!server", "space");
            const setList = vi.spyOn(sync, "setList");
            manager.setActiveSpace("!server", ["!category", "#not-a-room"]);
            manager.setActiveSpace("!server", ["!category"]);
            expect(setList).toHaveBeenCalledTimes(2);
            expect(sync.getListParams("active_space")).toEqual(
                expect.objectContaining({
                    ranges: [[0, 199]],
                    timeline_limit: 1,
                    filters: { spaces: ["!server", "!category"], not_room_types: ["m.space"] },
                }),
            );
            expect(sync.getListParams("active_space_recent")).toEqual(
                expect.objectContaining({ ranges: [[0, 9]], timeline_limit: 20 }),
            );
            await tick();
            expect(nameOf("!server")).toBe("space");
            // Home keeps the last Space's lists, and releases the Space after its grace period.
            manager.setActiveSpace(null);
            expect(sync.getListParams("active_space")?.filters?.spaces).toEqual(["!server", "!category"]);
        });

        it("applies a Space selected before the connection existed", async () => {
            const fresh = new SlidingSyncManager();
            fresh.setActiveSpace("!early");
            const freshSync = (await fresh.setup(client))!;
            expect(freshSync.getListParams("active_space")?.filters?.spaces).toEqual(["!early"]);
            expect(freshSync.getRoomSubscriptions()).toContain("!early");
            freshSync.stop();
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
        it("offers the saved rooms only to the client it was set up for", async () => {
            await manager.setup(client);
            expect(manager.snapshotLoader(client)).toBeInstanceOf(Function);
            expect(manager.snapshotLoader(stubClient())).toBeUndefined();
            await expect(manager.snapshotLoader(client)!()).resolves.toBeNull();
        });

        it("keeps no saved rooms for a session without a device", async () => {
            vi.mocked(client.getDeviceId).mockReturnValue(null);
            await manager.setup(client);
            expect(manager.snapshotLoader(client)).toBeUndefined();
        });

        it("marks saved rooms the server no longer lists as left, once it has sent every room the user is in", async () => {
            const sync = (await manager.setup(client))!;
            const cache = (
                manager as unknown as { cache: { restoredRoomIds: ReadonlySet<string>; forgetRooms: () => void } }
            ).cache;
            vi.spyOn(cache, "restoredRoomIds", "get").mockReturnValue(
                new Set(["!kept:example.org", "!late:example.org", "!gone:example.org"]),
            );
            const forget = vi.spyOn(cache, "forgetRooms");
            const rooms = new Map(
                ["!kept:example.org", "!late:example.org", "!gone:example.org"].map((roomId) => {
                    const room = new Room(roomId, client, client.getUserId()!);
                    room.updateMyMembership(KnownMembership.Join);
                    return [roomId, room];
                }),
            );
            vi.mocked(client.getRoom).mockImplementation((roomId) => rooms.get(roomId!) ?? null);
            const respond = (count: number): void => {
                sync.emit(SlidingSyncEvent.Lifecycle, SlidingSyncState.Complete, {
                    pos: "p",
                    lists: { untagged: { count } },
                    rooms: {},
                    extensions: {},
                });
            };
            const receive = async (roomId: string): Promise<void> => {
                await sync.emitPromised(SlidingSyncEvent.RoomData, roomId, {
                    name: roomId,
                    required_state: [],
                    timeline: [],
                });
            };

            await receive("!kept:example.org");
            // The user is in two rooms; only one has been sent, however the list ranges have moved meanwhile.
            respond(2);
            respond(2);
            expect(forget).not.toHaveBeenCalled();
            expect(rooms.get("!late:example.org")!.getMyMembership()).toBe(KnownMembership.Join);

            await receive("!late:example.org");
            respond(2);
            expect(forget).toHaveBeenCalledExactlyOnceWith(["!gone:example.org"]);
            expect(rooms.get("!gone:example.org")!.getMyMembership()).toBe(KnownMembership.Leave);
            expect(rooms.get("!late:example.org")!.getMyMembership()).toBe(KnownMembership.Join);
            // Checked once per connection.
            respond(1);
            expect(forget).toHaveBeenCalledTimes(1);
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
