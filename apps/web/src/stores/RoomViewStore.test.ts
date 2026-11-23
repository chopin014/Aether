/*
Copyright 2024 New Vector Ltd.
Copyright 2017-2022 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// @vitest-environment happy-dom

import { KnownMembership, MatrixError, Room } from "matrix-js-sdk/src/matrix";
import { sleep } from "matrix-js-sdk/src/utils";
import EventEmitter from "node:events";
import type * as NodeEvents from "node:events";
import { vi, describe, it, expect, beforeEach, afterEach, type MockedClass } from "vitest";
import {
    flushPromises,
    getMockClientWithEventEmitter,
    mkEvent,
    mkRoom,
    mkRoomMember,
    setupAsyncStoreWithClient,
    untilDispatch,
    untilEmission,
    TestSDKContext,
} from "test-utils";

import { RoomViewStore } from "./RoomViewStore";
import { Action } from "../dispatcher/actions";
import SettingsStore from "../settings/SettingsStore";
import { onServerJoined } from "../utils/servers/joinServer";
import { NewChannelJoiner } from "./spaces/NewChannelJoiner";
import { afterNextPaint } from "../utils/afterNextPaint";
import { SlidingSyncManager } from "../SlidingSyncManager";
import { PosthogAnalytics } from "../PosthogAnalytics";
import { TimelineRenderingType } from "../contexts/RoomContext";
import { MatrixDispatcher } from "../dispatcher/dispatcher";
import { UPDATE_EVENT } from "./AsyncStore";
import { type ActiveRoomChangedPayload } from "../dispatcher/payloads/ActiveRoomChangedPayload";
import SpaceStore from "./spaces/SpaceStore";
import { type ViewRoomPayload } from "../dispatcher/payloads/ViewRoomPayload";
import Modal from "../Modal";
import ErrorDialog from "../components/views/dialogs/ErrorDialog";
import { type CancelAskToJoinPayload } from "../dispatcher/payloads/CancelAskToJoinPayload";
import { type JoinRoomErrorPayload } from "../dispatcher/payloads/JoinRoomErrorPayload";
import { type SubmitAskToJoinPayload } from "../dispatcher/payloads/SubmitAskToJoinPayload";
import { type IApp } from "../utils/WidgetUtils-types";
import { CallStore } from "./CallStore";
import { MatrixClientPeg } from "../MatrixClientPeg";
import MediaDeviceHandler, { MediaDeviceKindEnum } from "../MediaDeviceHandler";
import { storeRoomAliasInCache } from "../RoomAliasCache.ts";
import { prefetchAliasPreview } from "../performance/AliasRoomSummary";
import * as roomSwitch from "../performance/RoomSwitchPerformance";
import * as roomEntry from "../performance/RoomEntryReady";
import { type Call, ConnectionState, ElementCall } from "../models/Call.ts";
import ActiveWidgetStore from "./ActiveWidgetStore";
import { ModuleApi } from "../modules/Api";
import { type JoinRoomPayload } from "../dispatcher/payloads/JoinRoomPayload.ts";
import { confirmVoiceChannelSwitch } from "../components/views/voip/confirmVoiceChannelSwitch";

/** Work held until the next paint, run by the tests when they choose. */
const paintQueue = vi.hoisted(() => [] as (() => void)[]);
vi.mock("../utils/afterNextPaint", () => ({
    afterNextPaint: vi.fn((work: () => void) => {
        paintQueue.push(work);
        return () => {};
    }),
}));

vi.mock("../components/views/voip/confirmVoiceChannelSwitch");

vi.mock("../Modal");

vi.mock("../utils/servers/joinServer", () => ({ onServerJoined: vi.fn().mockResolvedValue(undefined) }));

// mock out the injected classes
vi.mock("../PosthogAnalytics");
const MockPosthogAnalytics = PosthogAnalytics as unknown as MockedClass<typeof PosthogAnalytics>;
vi.mock("../SlidingSyncManager");
const MockSlidingSyncManager = SlidingSyncManager as unknown as MockedClass<typeof SlidingSyncManager>;
vi.mock("./spaces/SpaceStore");
const MockSpaceStore = SpaceStore as unknown as MockedClass<typeof SpaceStore>;

// mock VoiceRecording because it contains all the audio APIs
vi.mock("../audio/VoiceRecording", () => ({
    VoiceRecording: vi.fn().mockReturnValue({
        disableMaxLength: vi.fn(),
        liveData: {
            onUpdate: vi.fn(),
        },
        off: vi.fn(),
        on: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        destroy: vi.fn(),
        contentType: "audio/ogg",
    }),
}));

vi.spyOn(MediaDeviceHandler, "getDevices").mockResolvedValue({
    [MediaDeviceKindEnum.AudioInput]: [],
    [MediaDeviceKindEnum.VideoInput]: [],
    [MediaDeviceKindEnum.AudioOutput]: [],
});

vi.mock("../utils/DMRoomMap", () => {
    const mock = {
        getUserIdForRoomId: vi.fn(),
        getDMRoomsForUserId: vi.fn(),
    };

    return {
        default: {
            shared: vi.fn().mockReturnValue(mock),
            sharedInstance: mock,
        },
    };
});

vi.mock("./WidgetStore", async () => {
    const { EventEmitter } = await vi.importActual<typeof NodeEvents>("node:events");
    const apps: IApp[] = [];
    const instance = new (class extends EventEmitter {
        getApps() {
            return apps;
        }
        addVirtualWidget(app: IApp) {
            apps.push(app);
        }
    })();
    return { default: { instance } };
});
vi.mock("./widgets/WidgetLayoutStore");

describe("RoomViewStore", function () {
    const userId = "@alice:server";
    const roomId = "!randomcharacters:aser.ver";
    const roomId2 = "!room2:example.com";
    // we need to change the alias to ensure cache misses as the cache exists
    // through all tests.
    let alias = "#somealias2:aser.ver";
    const getRooms = vi.fn();
    const mockClient = getMockClientWithEventEmitter({
        joinRoom: vi.fn(),
        getRoom: vi.fn(),
        getRoomIdForAlias: vi.fn(),
        getRoomSummary: vi.fn().mockResolvedValue(undefined),
        getRooms,
        isGuest: vi.fn(),
        getUserId: vi.fn().mockReturnValue(userId),
        getSafeUserId: vi.fn().mockReturnValue(userId),
        getDeviceId: vi.fn().mockReturnValue("ABC123"),
        getDomain: vi.fn().mockReturnValue("server"),
        sendStateEvent: vi.fn().mockResolvedValue({}),
        supportsThreads: vi.fn(),
        isInitialSyncComplete: vi.fn().mockResolvedValue(false),
        relations: vi.fn(),
        knockRoom: vi.fn(),
        leave: vi.fn(),
        setRoomAccountData: vi.fn(),
        getAccountData: vi.fn(),
        waitForClientWellKnown: vi.fn().mockResolvedValue(undefined),
        getClientWellKnown: vi.fn().mockReturnValue({}),
        cachedRtcTransports: {
            get: vi.fn().mockReturnValue([]),
            wait: vi.fn().mockResolvedValue([]),
        },
        matrixRTC: new (class extends EventEmitter {
            getRoomSession() {
                return new (class extends EventEmitter {
                    memberships = [];
                })();
            }
        })(),
    });
    const room = mkRoom(mockClient, roomId);
    const room2 = new Room(roomId2, mockClient, userId);
    getRooms.mockReturnValue([room, room2]);

    const dispatchPromptAskToJoin = async () => {
        dis.dispatch({ action: Action.PromptAskToJoin });
        await untilDispatch(Action.PromptAskToJoin, dis);
    };

    const dispatchSubmitAskToJoin = async (roomId: string, reason?: string) => {
        dis.dispatch<SubmitAskToJoinPayload>({ action: Action.SubmitAskToJoin, roomId, opts: { reason } });
        await untilDispatch(Action.SubmitAskToJoin, dis);
    };

    const dispatchCancelAskToJoin = async (roomId: string) => {
        dis.dispatch<CancelAskToJoinPayload>({ action: Action.CancelAskToJoin, roomId });
        await untilDispatch(Action.CancelAskToJoin, dis);
    };

    let roomViewStore: RoomViewStore;
    let slidingSyncManager: SlidingSyncManager;
    let dis: MatrixDispatcher;
    let stores: TestSDKContext;

    beforeEach(function () {
        paintQueue.length = 0;
        vi.mocked(afterNextPaint).mockClear();
        vi.clearAllMocks();
        mockClient.credentials = { userId: userId };
        mockClient.joinRoom.mockResolvedValue(room);
        mockClient.getRoom.mockImplementation((roomId?: string): Room | null => {
            if (roomId === room.roomId) return room;
            if (roomId === room2.roomId) return room2;
            return null;
        });
        mockClient.isGuest.mockReturnValue(false);
        mockClient.getSafeUserId.mockReturnValue(userId);

        // Make the RVS to test
        dis = new MatrixDispatcher();
        slidingSyncManager = new MockSlidingSyncManager();
        stores = new TestSDKContext();
        stores._client = mockClient;
        stores._SlidingSyncManager = slidingSyncManager;
        stores._PosthogAnalytics = new MockPosthogAnalytics(
            undefined as unknown as ConstructorParameters<typeof PosthogAnalytics>[0],
        );
        vi.spyOn(MockPosthogAnalytics, "instance", "get").mockReturnValue(stores._PosthogAnalytics);
        stores._SpaceStore = new MockSpaceStore(
            undefined as unknown as ConstructorParameters<typeof SpaceStore>[0],
            undefined as unknown as ConstructorParameters<typeof SpaceStore>[1],
        );
        // Add activeSpace property to the mock
        Object.defineProperty(stores._SpaceStore, "activeSpace", {
            value: null,
            writable: true,
            configurable: true,
        });
        roomViewStore = new RoomViewStore(dis, stores);
        stores._RoomViewStore = roomViewStore;
    });

    it("can be used to view a room by ID and join", async () => {
        dis.dispatch({ action: Action.ViewRoom, room_id: roomId });
        dis.dispatch({ action: Action.JoinRoom });
        await untilDispatch(Action.JoinRoomReady, dis);
        expect(mockClient.joinRoom).toHaveBeenCalledWith(roomId, { acceptSharedHistory: true, viaServers: [] });
        expect(roomViewStore.isJoining()).toBe(true);
    });

    it("joins a resolved room by ID when servers are known instead of resolving its alias again", async () => {
        const alias = "#alias12345:server";
        storeRoomAliasInCache(alias, roomId, ["server1"]);
        dis.dispatch({ action: Action.ViewRoom, room_alias: alias, auto_join: true }, true);
        await untilDispatch(Action.JoinRoomReady, dis);
        expect(mockClient.joinRoom).toHaveBeenCalledWith(roomId, {
            acceptSharedHistory: true,
            viaServers: ["server1"],
        });
        expect(roomViewStore.isJoining()).toBe(true);
    });

    it("can be used to view a room by alias with auto_join", async () => {
        const alias = "#alias12345:server";
        storeRoomAliasInCache(alias, roomId, []);
        dis.dispatch({ action: Action.ViewRoom, room_alias: alias, auto_join: true }, true);
        await expect(untilDispatch(Action.ViewRoom, dis)).resolves.toEqual(
            expect.objectContaining({
                action: Action.ViewRoom,
                room_id: roomId,
                auto_join: true,
            }),
        );
        await untilDispatch(Action.JoinRoomReady, dis);
        // Without servers, only the alias can locate the room over federation.
        expect(mockClient.joinRoom).toHaveBeenCalledWith(alias, { acceptSharedHistory: true, viaServers: [] });
        expect(roomViewStore.isJoining()).toBe(true);
    });

    it("joins a server's channels after joining it in the desktop shell", async () => {
        const original = SettingsStore.getValue.bind(SettingsStore);
        const settings = vi
            .spyOn(SettingsStore, "getValue")
            .mockImplementation((name, ...args) => (name === "feature_desktop_shell" ? true : original(name, ...args)));
        try {
            dis.dispatch({ action: Action.ViewRoom, room_id: roomId, auto_join: true });
            await untilDispatch(Action.JoinRoomReady, dis);
            await vi.waitFor(() => expect(onServerJoined).toHaveBeenCalledWith(mockClient, roomId));
        } finally {
            settings.mockRestore();
        }
    });

    it("tells the new channel joiner about a join before sending it", async () => {
        const expectJoin = vi.spyOn(NewChannelJoiner.instance, "expectJoin");
        try {
            vi.mocked(mockClient.joinRoom).mockImplementationOnce(async () => {
                expect(expectJoin).toHaveBeenCalledWith(roomId);
                return new Room(roomId, mockClient, userId);
            });
            dis.dispatch({ action: Action.ViewRoom, room_id: roomId, auto_join: true });
            await untilDispatch(Action.JoinRoomReady, dis);
            expect(mockClient.joinRoom).toHaveBeenCalledTimes(1);
        } finally {
            expectJoin.mockRestore();
        }
    });

    it("leaves a joined room's channels alone outside the desktop shell", async () => {
        dis.dispatch({ action: Action.ViewRoom, room_id: roomId, auto_join: true });
        await untilDispatch(Action.JoinRoomReady, dis);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(onServerJoined).not.toHaveBeenCalled();
    });

    it("can auto-join a room", async () => {
        dis.dispatch({ action: Action.ViewRoom, room_id: roomId, auto_join: true });
        await untilDispatch(Action.JoinRoomReady, dis);
        expect(mockClient.joinRoom).toHaveBeenCalledWith(roomId, { acceptSharedHistory: true, viaServers: [] });
        expect(roomViewStore.isJoining()).toBe(true);
    });

    it("emits ActiveRoomChanged when the viewed room changes", async () => {
        dis.dispatch({ action: Action.ViewRoom, room_id: roomId });
        let payload = (await untilDispatch(Action.ActiveRoomChanged, dis)) as ActiveRoomChangedPayload;
        expect(payload.newRoomId).toEqual(roomId);
        expect(payload.oldRoomId).toEqual(null);

        dis.dispatch({ action: Action.ViewRoom, room_id: roomId2 });
        payload = (await untilDispatch(Action.ActiveRoomChanged, dis)) as ActiveRoomChangedPayload;
        expect(payload.newRoomId).toEqual(roomId2);
        expect(payload.oldRoomId).toEqual(roomId);
    });

    describe("telling who follows the viewed room", () => {
        /** Waits until nothing dispatched waits for its timer, and the timers' work has finished. */
        const settled = async (): Promise<void> => {
            const waiting = (): boolean => dis.hasQueuedOtherThan();
            for (let tries = 0; tries < 100 && waiting(); tries++) {
                await new Promise((resolve) => setTimeout(resolve, 1));
            }
            expect(waiting()).toBe(false);
            await new Promise((resolve) => setTimeout(resolve, 1));
        };

        /** Records the "earlier" action and each ActiveRoomChanged's new room, in the order they are dispatched. */
        const record = (): { seen: (string | null)[]; stop: () => void } => {
            const seen: (string | null)[] = [];
            const token = dis.register((payload) => {
                if (payload.action === "earlier") seen.push("earlier");
                if (payload.action === Action.UserActivity) seen.push("activity");
                if (payload.action === Action.ActiveRoomChanged) {
                    seen.push((payload as ActiveRoomChangedPayload).newRoomId);
                }
            });
            return { seen, stop: () => dis.unregister(token) };
        };

        it("does so as soon as the dispatch has finished, without a timer", async () => {
            const { seen, stop } = record();
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
            try {
                dis.dispatch({ action: Action.ViewRoom, room_id: roomId }, true);
                expect(seen).toEqual([]);
                await Promise.resolve();
                expect(seen).toEqual([roomId]);
            } finally {
                vi.useRealTimers();
                stop();
            }
        });

        it("does so after an earlier change's that still waits, and in order across changes", async () => {
            const { seen, stop } = record();
            try {
                dis.dispatch({ action: Action.ActiveRoomChanged, oldRoomId: null, newRoomId: "!earlier:server" });
                dis.dispatch({ action: Action.ViewRoom, room_id: roomId }, true);
                await Promise.resolve();
                dis.dispatch({ action: Action.ViewRoom, room_id: roomId2 }, true);
                await settled();
                expect(seen).toEqual(["!earlier:server", roomId, roomId2]);
            } finally {
                stop();
            }
        });

        it("does so before the user's activity dispatched earlier, which comes with a click", async () => {
            const { seen, stop } = record();
            try {
                dis.dispatch({ action: Action.UserActivity });
                dis.dispatch({ action: Action.ViewRoom, room_id: roomId }, true);
                await Promise.resolve();
                expect(seen).toEqual([roomId]);
                await settled();
                expect(seen).toEqual([roomId, "activity"]);
            } finally {
                stop();
            }
        });

        it("does so after anything else dispatched earlier that still waits", async () => {
            const { seen, stop } = record();
            try {
                dis.dispatch({ action: "earlier" });
                dis.dispatch({ action: Action.ViewRoom, room_id: roomId }, true);
                await Promise.resolve();
                expect(seen).toEqual([]);
                await settled();
                expect(seen).toEqual(["earlier", roomId]);
            } finally {
                stop();
            }
        });
    });

    it("marks the navigation phase of opening a room for each room the view changes to", async () => {
        const mark = vi.spyOn(roomSwitch, "markRoomSwitch");
        dis.dispatch({ action: Action.ViewRoom, room_id: roomId });
        await untilDispatch(Action.ActiveRoomChanged, dis);
        dis.dispatch({ action: Action.ViewRoom, room_id: roomId2 });
        await untilDispatch(Action.ActiveRoomChanged, dis);

        expect(mark.mock.calls).toEqual([
            ["navigation", roomId],
            ["navigation", roomId2],
        ]);
        mark.mockRestore();
    });

    it("begins a new visit for work put off until the room paints, each time the view changes to a room", async () => {
        const begin = vi.spyOn(roomEntry, "beginRoomEntryVisit");
        dis.dispatch({ action: Action.ViewRoom, room_id: roomId });
        await untilDispatch(Action.ActiveRoomChanged, dis);
        dis.dispatch({ action: Action.ViewRoom, room_id: roomId2 });
        await untilDispatch(Action.ActiveRoomChanged, dis);
        dis.dispatch({ action: Action.ViewRoom, room_id: roomId });
        await untilDispatch(Action.ActiveRoomChanged, dis);

        expect(begin.mock.calls.map(([, id]) => id)).toEqual([roomId, roomId2, roomId]);
        expect(begin.mock.calls[0][0]).toBe(MatrixClientPeg.safeGet());
        begin.mockRestore();
    });

    it("does not begin a visit for the room already open, or for leaving rooms", async () => {
        dis.dispatch({ action: Action.ViewRoom, room_id: roomId });
        await untilDispatch(Action.ActiveRoomChanged, dis);
        const begin = vi.spyOn(roomEntry, "beginRoomEntryVisit");

        dis.dispatch({ action: Action.ViewRoom, room_id: roomId, highlighted: true, event_id: "$event" });
        await sleep(0);
        dis.dispatch({ action: Action.ViewHomePage });
        await untilDispatch(Action.ActiveRoomChanged, dis);

        expect(begin).not.toHaveBeenCalled();
        begin.mockRestore();
    });

    it("invokes room activity listeners when the viewed room changes", async () => {
        const callback = vi.fn();
        roomViewStore.addRoomListener(roomId, callback);
        dis.dispatch({ action: Action.ViewRoom, room_id: roomId });
        (await untilDispatch(Action.ActiveRoomChanged, dis)) as ActiveRoomChangedPayload;
        expect(callback).toHaveBeenCalledWith(true);
        expect(callback).not.toHaveBeenCalledWith(false);

        dis.dispatch({ action: Action.ViewRoom, room_id: roomId2 });
        (await untilDispatch(Action.ActiveRoomChanged, dis)) as ActiveRoomChangedPayload;
        expect(callback).toHaveBeenCalledWith(false);
    });

    it("can be used to view a room by alias and join", async () => {
        mockClient.getRoomIdForAlias.mockResolvedValue({ room_id: roomId, servers: [] });
        dis.dispatch({ action: Action.ViewRoom, room_alias: alias });
        await untilDispatch((p) => {
            // wait for the re-dispatch with the room ID
            return p.action === Action.ViewRoom && p.room_id === roomId;
        }, dis);

        // roomId is set to id of the room alias
        expect(roomViewStore.getRoomId()).toBe(roomId);

        // join the room
        dis.dispatch({ action: Action.JoinRoom }, true);

        await untilDispatch(Action.JoinRoomReady, dis);

        expect(roomViewStore.isJoining()).toBeTruthy();
        expect(mockClient.joinRoom).toHaveBeenCalledWith(alias, { acceptSharedHistory: true, viaServers: [] });
    });

    it("emits ViewRoomError if the alias lookup fails", async () => {
        alias = "#something-different:to-ensure-cache-miss";
        mockClient.getRoomIdForAlias.mockRejectedValue(new Error("network error or something"));
        dis.dispatch({ action: Action.ViewRoom, room_alias: alias });
        const payload = await untilDispatch(Action.ViewRoomError, dis);
        expect(payload.room_id).toBeNull();
        expect(payload.room_alias).toEqual(alias);
        expect(roomViewStore.getRoomAlias()).toEqual(alias);
    });

    it("requests the summary by alias alongside an uncached alias lookup", async () => {
        alias = "#prefetched-summary:example.org";
        mockClient.getRoomIdForAlias.mockResolvedValue({ room_id: roomId, servers: ["example.org"] });
        dis.dispatch({ action: Action.ViewRoom, room_alias: alias, via_servers: ["via.example.org"] });
        await untilDispatch((p) => p.action === Action.ViewRoom && p.room_id === roomId, dis);
        expect(mockClient.getRoomSummary).toHaveBeenCalledWith(alias, ["via.example.org"]);
    });

    it("reuses an alias lookup that startup already began", async () => {
        alias = "#opened-at-startup:example.org";
        mockClient.getRoomIdForAlias.mockResolvedValue({ room_id: roomId, servers: ["example.org"] });
        prefetchAliasPreview(mockClient, alias);
        mockClient.getRoomIdForAlias.mockClear();
        mockClient.getRoomSummary.mockClear();
        dis.dispatch({ action: Action.ViewRoom, room_alias: alias });
        await untilDispatch((p) => p.action === Action.ViewRoom && p.room_id === roomId, dis);
        expect(mockClient.getRoomIdForAlias).not.toHaveBeenCalled();
        expect(mockClient.getRoomSummary).not.toHaveBeenCalled();
        expect(roomViewStore.getRoomId()).toBe(roomId);
    });

    it("emits JoinRoomError if joining the room fails", async () => {
        const joinErr = new Error("network error or something");
        mockClient.joinRoom.mockRejectedValue(joinErr);
        dis.dispatch({ action: Action.ViewRoom, room_id: roomId });
        dis.dispatch({ action: Action.JoinRoom });
        await untilDispatch(Action.JoinRoomError, dis);
        expect(roomViewStore.isJoining()).toBe(false);
        expect(roomViewStore.getJoinError()).toEqual(joinErr);
    });

    it("remembers the event being replied to when swapping rooms", async () => {
        dis.dispatch({ action: Action.ViewRoom, room_id: roomId });
        await untilDispatch(Action.ActiveRoomChanged, dis);
        const replyToEvent = {
            getRoomId: () => roomId,
        };
        dis.dispatch({ action: "reply_to_event", event: replyToEvent, context: TimelineRenderingType.Room });
        await untilEmission(roomViewStore, UPDATE_EVENT);
        expect(roomViewStore.getQuotingEvent()).toEqual(replyToEvent);
        // view the same room, should remember the event.
        // set the highlighed flag to make sure there is a state change so we get an update event
        dis.dispatch({ action: Action.ViewRoom, room_id: roomId, highlighted: true });
        await untilEmission(roomViewStore, UPDATE_EVENT);
        expect(roomViewStore.getQuotingEvent()).toEqual(replyToEvent);
    });

    it("swaps to the replied event room if it is not the current room", async () => {
        dis.dispatch({ action: Action.ViewRoom, room_id: roomId });
        await untilDispatch(Action.ActiveRoomChanged, dis);
        const replyToEvent = {
            getRoomId: () => roomId2,
        };
        dis.dispatch({ action: "reply_to_event", event: replyToEvent, context: TimelineRenderingType.Room });
        await untilDispatch(Action.ViewRoom, dis);
        expect(roomViewStore.getQuotingEvent()).toEqual(replyToEvent);
        expect(roomViewStore.getRoomId()).toEqual(roomId2);
    });

    it("should ignore reply_to_event for Thread panels", async () => {
        expect(roomViewStore.getQuotingEvent()).toBeFalsy();
        const replyToEvent = {
            getRoomId: () => roomId2,
        };
        dis.dispatch({ action: "reply_to_event", event: replyToEvent, context: TimelineRenderingType.Thread });
        await sleep(100);
        expect(roomViewStore.getQuotingEvent()).toBeFalsy();
    });

    it.each([TimelineRenderingType.Room, TimelineRenderingType.File, TimelineRenderingType.Notification])(
        "Should respect reply_to_event for %s rendering context",
        async (context) => {
            const replyToEvent = {
                getRoomId: () => roomId,
            };
            dis.dispatch({ action: "reply_to_event", event: replyToEvent, context });
            await untilDispatch(Action.ViewRoom, dis);
            expect(roomViewStore.getQuotingEvent()).toEqual(replyToEvent);
        },
    );

    it("does not change room when replying to event in a room displayed in module", async () => {
        // Spy on dispatch to check later if ViewRoom was dispatched
        vi.spyOn(dis, "dispatch");

        // Set up current room
        dis.dispatch({ action: Action.ViewRoom, room_id: roomId });
        await untilDispatch(Action.ActiveRoomChanged, dis);
        expect(roomViewStore.getRoomId()).toEqual(roomId);

        ModuleApi.instance.extras.getVisibleRoomBySpaceKey("space1", () => [roomId, roomId2]);
        // @ts-ignore
        stores.spaceStore.activeSpace = "space1";

        // Create reply event for roomId2 (which is displayed in module)
        const replyToEvent = {
            getRoomId: () => roomId2,
        };

        // Dispatch reply_to_event - should not change room since roomId2 is in module
        dis.dispatch({ action: "reply_to_event", event: replyToEvent, context: TimelineRenderingType.Room });
        await flushPromises();

        // Room should remain the same (roomId), not change to roomId2
        expect(dis.dispatch).not.toHaveBeenCalledWith({
            action: Action.ViewRoom,
            room_id: roomId2,
            replyingToEvent: replyToEvent,
            metricsTrigger: undefined,
        });
    });

    it("keeps the summary of the open room until another room is opened", async () => {
        const summary = {
            room_id: roomId,
            num_joined_members: 1,
            world_readable: false,
            guest_can_join: false,
        };
        dis.dispatch({ action: Action.ViewRoom, room_id: roomId });
        await untilDispatch(Action.ActiveRoomChanged, dis);

        // A summary for a room that isn't open is ignored
        roomViewStore.setRoomSummary(roomId2, { ...summary, room_id: roomId2 });
        expect(roomViewStore.getRoomSummary()).toBeUndefined();

        const onUpdate = vi.fn();
        roomViewStore.on(UPDATE_EVENT, onUpdate);
        roomViewStore.setRoomSummary(roomId, summary);
        expect(roomViewStore.getRoomSummary()).toBe(summary);
        expect(onUpdate).toHaveBeenCalled();

        dis.dispatch({ action: Action.ViewRoom, room_id: roomId2 });
        await untilDispatch(Action.ActiveRoomChanged, dis);
        expect(roomViewStore.getRoomSummary()).toBeUndefined();
    });

    it("removes the roomId on ViewHomePage", async () => {
        dis.dispatch({ action: Action.ViewRoom, room_id: roomId });
        await untilDispatch(Action.ActiveRoomChanged, dis);
        expect(roomViewStore.getRoomId()).toEqual(roomId);

        dis.dispatch({ action: Action.ViewHomePage });
        await untilEmission(roomViewStore, UPDATE_EVENT);
        expect(roomViewStore.getRoomId()).toBeNull();
    });

    it("removes the roomId when the desktop shell opens Discover", async () => {
        const getValue = SettingsStore.getValue.bind(SettingsStore);
        const settings = vi
            .spyOn(SettingsStore, "getValue")
            .mockImplementation((name, ...args) => (name === "feature_desktop_shell" ? true : getValue(name, ...args)));
        try {
            dis.dispatch({ action: Action.ViewRoom, room_id: roomId });
            await untilDispatch(Action.ActiveRoomChanged, dis);

            dis.dispatch({ action: Action.ViewDiscover });
            await untilEmission(roomViewStore, UPDATE_EVENT);
            expect(roomViewStore.getRoomId()).toBeNull();
        } finally {
            settings.mockRestore();
        }
    });

    it("keeps the room when Discover opens as a dialog outside the desktop shell", async () => {
        dis.dispatch({ action: Action.ViewRoom, room_id: roomId });
        await untilDispatch(Action.ActiveRoomChanged, dis);

        dis.dispatch({ action: Action.ViewDiscover }, true);
        expect(roomViewStore.getRoomId()).toEqual(roomId);
    });

    it("when viewing a call without a broadcast, it should not raise an error", async () => {
        const call = { presented: false } as Call;
        const getCallSpy = vi.spyOn(CallStore.instance, "getCall").mockReturnValue(call);
        await setupAsyncStoreWithClient(CallStore.instance, MatrixClientPeg.safeGet());

        dis.dispatch<ViewRoomPayload>({
            action: Action.ViewRoom,
            room_id: roomId,
            view_call: true,
            metricsTrigger: undefined,
        });
        await untilDispatch(Action.ViewRoom, dis);

        expect(getCallSpy).toHaveBeenCalledWith(roomId);
        expect(call.presented).toEqual(true);
    });

    it("implicitly views an active call", async () => {
        const call = { presented: false } as Call;
        vi.spyOn(CallStore.instance, "getCall").mockReturnValue(call);
        vi.spyOn(CallStore.instance, "getActiveCall").mockImplementation((rId) => (rId === roomId ? call : null));
        await setupAsyncStoreWithClient(CallStore.instance, MatrixClientPeg.safeGet());

        // View the room without explicitly setting view_call to true
        dis.dispatch<ViewRoomPayload>({
            action: Action.ViewRoom,
            room_id: roomId,
            metricsTrigger: undefined,
        });
        await untilDispatch(Action.ViewRoom, dis);

        expect(call.presented).toEqual(true);
    });

    it.each([false, true])(
        "keeps desktop audio calls visible in the conversation (skip lobby: %s)",
        async (skipLobby) => {
            const original = SettingsStore.getValue.bind(SettingsStore);
            const setting = vi
                .spyOn(SettingsStore, "getValue")
                .mockImplementation((name, ...args) =>
                    name === "feature_desktop_shell" ? true : original(name, ...args),
                );
            const call = {
                presented: false,
                connectionState: ConnectionState.Disconnected,
                widget: { id: "!widget:example.org" },
                participants: new Map(),
                start: vi.fn(),
            } as unknown as Call;
            vi.spyOn(CallStore.instance, "getCall").mockReturnValue(call);
            const persistence = vi.spyOn(ActiveWidgetStore.instance, "setWidgetPersistence");
            await setupAsyncStoreWithClient(CallStore.instance, MatrixClientPeg.safeGet());
            dis.dispatch<ViewRoomPayload>({
                action: Action.ViewRoom,
                room_id: roomId,
                view_call: true,
                voiceOnly: true,
                skipLobby,
                metricsTrigger: undefined,
            });
            await untilDispatch(Action.ViewRoom, dis);
            expect(roomViewStore.isViewingCall()).toBe(true);
            expect(persistence).not.toHaveBeenCalled();
            expect(call.start).toHaveBeenCalledWith({ voiceOnly: true, skipLobby });
            setting.mockRestore();
        },
    );

    describe("switching desktop calls", () => {
        afterEach(() => {
            vi.mocked(SettingsStore.getValue).mockRestore();
            vi.mocked(CallStore.instance.getCall).mockRestore();
            vi.spyOn(CallStore.instance, "connectedCalls", "get").mockRestore();
        });

        function prepareSwitch(): { oldCall: Call; newCall: Call; view: () => Promise<void> } {
            const original = SettingsStore.getValue.bind(SettingsStore);
            vi.spyOn(SettingsStore, "getValue").mockImplementation((name, ...args) =>
                name === "feature_desktop_shell" ? true : original(name, ...args),
            );
            const oldCall = {
                roomId: roomId2,
                presented: true,
                disconnect: vi.fn().mockResolvedValue(undefined),
            } as unknown as Call;
            const newCall = {
                roomId,
                presented: false,
                connectionState: ConnectionState.Disconnected,
                start: vi.fn(),
            } as unknown as Call;
            vi.spyOn(CallStore.instance, "connectedCalls", "get").mockReturnValue(new Set([oldCall]));
            vi.spyOn(CallStore.instance, "getCall").mockImplementation((id) => (id === roomId ? newCall : oldCall));
            vi.mocked(confirmVoiceChannelSwitch).mockResolvedValue(true);
            return {
                oldCall,
                newCall,
                view: () =>
                    roomViewStore.viewRoom({
                        action: Action.ViewRoom,
                        room_id: roomId,
                        view_call: true,
                        voiceOnly: true,
                        skipLobby: true,
                        metricsTrigger: undefined,
                    }),
            };
        }

        it("waits for confirmation and hangup before starting the destination call", async () => {
            const { oldCall, newCall, view } = prepareSwitch();
            const confirmation = Promise.withResolvers<boolean>();
            const hangup = Promise.withResolvers<void>();
            vi.mocked(confirmVoiceChannelSwitch).mockReturnValue(confirmation.promise);
            vi.mocked(oldCall.disconnect).mockReturnValue(hangup.promise);
            const switching = view();
            expect(confirmVoiceChannelSwitch).toHaveBeenCalledWith(room.name);
            expect(oldCall.disconnect).not.toHaveBeenCalled();
            expect(newCall.start).not.toHaveBeenCalled();
            confirmation.resolve(true);
            await flushPromises();
            expect(oldCall.presented).toBe(false);
            expect(oldCall.disconnect).toHaveBeenCalledOnce();
            expect(newCall.start).not.toHaveBeenCalled();
            hangup.resolve();
            await switching;
            expect(newCall.start).toHaveBeenCalledWith({ voiceOnly: true, skipLobby: true });
            expect(roomViewStore.getRoomId()).toBe(roomId);
        });

        it("keeps the original call intact on cancellation", async () => {
            const { oldCall, newCall, view } = prepareSwitch();
            vi.mocked(confirmVoiceChannelSwitch).mockResolvedValue(false);
            await view();
            expect(oldCall.presented).toBe(true);
            expect(oldCall.disconnect).not.toHaveBeenCalled();
            expect(newCall.start).not.toHaveBeenCalled();
        });

        it("rejoins a selected voice channel when it is clicked after leaving", async () => {
            const { newCall } = prepareSwitch();
            vi.spyOn(CallStore.instance, "connectedCalls", "get").mockReturnValue(new Set());
            const callRoom = vi.spyOn(room, "isCallRoom").mockReturnValue(true);
            try {
                await roomViewStore.viewRoom({
                    action: Action.ViewRoom,
                    room_id: roomId,
                    view_call: false,
                    metricsTrigger: undefined,
                });
                expect(roomViewStore.isViewingCall()).toBe(false);
                await roomViewStore.viewRoom({
                    action: Action.ViewRoom,
                    room_id: roomId,
                    metricsTrigger: "RoomList",
                });
                expect(roomViewStore.isViewingCall()).toBe(true);
                expect(newCall.presented).toBe(true);
                expect(newCall.start).toHaveBeenCalledOnce();
            } finally {
                callRoom.mockRestore();
            }
        });

        describe("clicking a voice channel in the list", () => {
            /** A voice channel's call, as the store sees it before anyone has joined it. */
            function voiceCall(state: { joinRequested?: boolean } = {}): ElementCall {
                // Real getters and instanceof checks, without a widget, a client or Element Call behind them.
                return Object.defineProperties(Object.create(ElementCall.prototype), {
                    roomId: { value: roomId },
                    presented: { value: false, writable: true },
                    _connectionState: { value: ConnectionState.Disconnected },
                    _joinRequested: { value: state.joinRequested ?? false, writable: true },
                    localLeavePending: { value: false, writable: true },
                    componentOptions: { value: { config: { skipLobby: true } } },
                    emit: { value: vi.fn() },
                    widget: { value: { id: "call-widget", roomId } },
                    start: { value: vi.fn().mockResolvedValue(null) },
                }) as ElementCall;
            }
            function inDesktopShell(): void {
                const original = SettingsStore.getValue.bind(SettingsStore);
                vi.spyOn(SettingsStore, "getValue").mockImplementation((name, ...args) =>
                    name === "feature_desktop_shell" ? true : original(name, ...args),
                );
                vi.spyOn(CallStore.instance, "connectedCalls", "get").mockReturnValue(new Set());
                vi.spyOn(CallStore.instance, "getCall").mockReturnValue(null);
            }

            it("joins it where the user is, without opening it", async () => {
                inDesktopShell();
                const call = voiceCall();
                vi.spyOn(CallStore.instance, "getCall").mockReturnValue(call);
                const persist = vi.spyOn(ActiveWidgetStore.instance, "setWidgetPersistence");
                const callRoom = vi.spyOn(room, "isCallRoom").mockReturnValue(true);
                try {
                    await roomViewStore.viewRoom({
                        action: Action.ViewRoom,
                        room_id: roomId2,
                        metricsTrigger: undefined,
                    });
                    expect(roomViewStore.joinVoiceChannel(room)).toBe(true);
                    await flushPromises();
                    expect(roomViewStore.getRoomId()).toBe(roomId2);
                    // The join shows at once; the call itself starts once that is painted.
                    expect(call.joinRequested).toBe(true);
                    expect(afterNextPaint).toHaveBeenCalledOnce();
                    expect(call.start).not.toHaveBeenCalled();
                    paintQueue.splice(0).forEach((work) => work());
                    expect(call.start).toHaveBeenCalledOnce();
                    expect(persist).toHaveBeenCalledWith("call-widget", roomId, true);
                } finally {
                    callRoom.mockRestore();
                    persist.mockRestore();
                }
            });

            it("does not start a call left again before it started", async () => {
                inDesktopShell();
                const call = voiceCall();
                vi.spyOn(CallStore.instance, "getCall").mockReturnValue(call);
                const callRoom = vi.spyOn(room, "isCallRoom").mockReturnValue(true);
                try {
                    await roomViewStore.viewRoom({
                        action: Action.ViewRoom,
                        room_id: roomId2,
                        metricsTrigger: undefined,
                    });
                    expect(roomViewStore.joinVoiceChannel(room)).toBe(true);
                    await flushPromises();
                    call.setJoinRequested(false);
                    paintQueue.splice(0).forEach((work) => work());
                    expect(call.start).not.toHaveBeenCalled();
                } finally {
                    callRoom.mockRestore();
                }
            });

            it("opens the call of a channel the user is already joining or in", async () => {
                inDesktopShell();
                vi.spyOn(CallStore.instance, "getCall").mockReturnValue(voiceCall({ joinRequested: true }));
                const callRoom = vi.spyOn(room, "isCallRoom").mockReturnValue(true);
                try {
                    await roomViewStore.viewRoom({
                        action: Action.ViewRoom,
                        room_id: roomId2,
                        metricsTrigger: undefined,
                    });
                    expect(roomViewStore.joinVoiceChannel(room)).toBe(false);
                } finally {
                    callRoom.mockRestore();
                }
            });

            it("opens the channel when the user is looking at another voice channel's call", async () => {
                inDesktopShell();
                const call = voiceCall();
                vi.spyOn(CallStore.instance, "getCall").mockReturnValue(call);
                const callRoom = vi.spyOn(room, "isCallRoom").mockReturnValue(true);
                const otherCallRoom = vi.spyOn(room2, "isCallRoom").mockReturnValue(true);
                try {
                    await roomViewStore.viewRoom({
                        action: Action.ViewRoom,
                        room_id: roomId2,
                        view_call: false,
                        metricsTrigger: undefined,
                    });
                    expect(roomViewStore.joinVoiceChannel(room)).toBe(false);
                    expect(call.start).not.toHaveBeenCalled();
                } finally {
                    callRoom.mockRestore();
                    otherCallRoom.mockRestore();
                }
            });

            it("leaves text channels and other rooms to be opened", () => {
                inDesktopShell();
                expect(roomViewStore.joinVoiceChannel(room)).toBe(false);
            });
        });

        describe("following a moderator's move to another voice channel", () => {
            /** The call the user is in, which leaves the store's connected calls once it is left, as a real one does. */
            function prepareMove(presented: boolean): { oldCall: Call; newCall: ElementCall; connected: Set<Call> } {
                const original = SettingsStore.getValue.bind(SettingsStore);
                vi.spyOn(SettingsStore, "getValue").mockImplementation((name, ...args) =>
                    name === "feature_desktop_shell" ? true : original(name, ...args),
                );
                const connected = new Set<Call>();
                const oldCall = {
                    roomId: roomId2,
                    presented,
                    disconnect: vi.fn(async () => {
                        connected.delete(oldCall);
                    }),
                } as unknown as Call;
                connected.add(oldCall);
                const newCall = Object.defineProperties(Object.create(ElementCall.prototype), {
                    roomId: { value: roomId },
                    presented: { value: false, writable: true },
                    _connectionState: { value: ConnectionState.Disconnected },
                    _joinRequested: { value: false, writable: true },
                    localLeavePending: { value: false, writable: true },
                    componentOptions: { value: { config: { skipLobby: true } } },
                    emit: { value: vi.fn() },
                    widget: { value: { id: "call-widget", roomId } },
                    start: { value: vi.fn().mockResolvedValue(null) },
                }) as ElementCall;
                vi.spyOn(CallStore.instance, "connectedCalls", "get").mockImplementation(() => connected);
                vi.spyOn(CallStore.instance, "getCall").mockImplementation((id) => (id === roomId ? newCall : oldCall));
                vi.spyOn(room, "isCallRoom").mockReturnValue(true);
                return { oldCall, newCall, connected };
            }

            afterEach(() => {
                vi.mocked(room.isCallRoom).mockRestore?.();
            });

            it("leaves the call without asking and joins the new channel where the user is", async () => {
                const { oldCall, newCall } = prepareMove(false);
                await roomViewStore.viewRoom({ action: Action.ViewRoom, room_id: roomId2, metricsTrigger: undefined });

                await roomViewStore.followVoiceMove(roomId);

                expect(confirmVoiceChannelSwitch).not.toHaveBeenCalled();
                expect(oldCall.disconnect).toHaveBeenCalledOnce();
                expect(roomViewStore.getRoomId()).toBe(roomId2);
                expect(newCall.joinRequested).toBe(true);
                paintQueue.splice(0).forEach((work) => work());
                expect(newCall.start).toHaveBeenCalledOnce();
            });

            it("shows the new channel's call to someone who was watching the old one", async () => {
                prepareMove(true);
                await roomViewStore.viewRoom({ action: Action.ViewRoom, room_id: roomId2, metricsTrigger: undefined });
                // Opening the call is the view's own job, tested above; only the request to open it matters here.
                const dispatch = vi.spyOn(dis, "dispatch").mockImplementation(() => {});

                await roomViewStore.followVoiceMove(roomId);

                expect(confirmVoiceChannelSwitch).not.toHaveBeenCalled();
                expect(dispatch).toHaveBeenCalledWith(
                    expect.objectContaining({ action: Action.ViewRoom, room_id: roomId, view_call: true }),
                );
                dispatch.mockRestore();
            });

            it("does nothing for a room that is not a voice channel", async () => {
                const { oldCall } = prepareMove(false);
                vi.mocked(room.isCallRoom).mockReturnValue(false);
                await roomViewStore.followVoiceMove(roomId);
                expect(oldCall.disconnect).not.toHaveBeenCalled();
            });
        });

        it("does not duplicate a switch when the same call is clicked twice", async () => {
            const { oldCall, newCall, view } = prepareSwitch();
            const confirmation = Promise.withResolvers<boolean>();
            vi.mocked(confirmVoiceChannelSwitch).mockReturnValue(confirmation.promise);
            const switching = view();
            await view();
            confirmation.resolve(true);
            await switching;
            expect(confirmVoiceChannelSwitch).toHaveBeenCalledOnce();
            expect(oldCall.disconnect).toHaveBeenCalledOnce();
            expect(newCall.start).toHaveBeenCalledOnce();
        });

        it("abandons the pending switch when the user navigates elsewhere", async () => {
            const { oldCall, newCall, view } = prepareSwitch();
            const confirmation = Promise.withResolvers<boolean>();
            vi.mocked(confirmVoiceChannelSwitch).mockReturnValue(confirmation.promise);
            const switching = view();
            await roomViewStore.viewRoom({
                action: Action.ViewRoom,
                room_id: roomId2,
                view_call: false,
                metricsTrigger: undefined,
            });
            confirmation.resolve(true);
            await switching;
            expect(oldCall.disconnect).not.toHaveBeenCalled();
            expect(newCall.start).not.toHaveBeenCalled();
            expect(roomViewStore.getRoomId()).toBe(roomId2);
        });

        it("does not start another call if the current call cannot be disconnected", async () => {
            const { oldCall, newCall, view } = prepareSwitch();
            vi.mocked(oldCall.disconnect).mockRejectedValue(new Error("hangup failed"));
            await view();
            expect(newCall.start).not.toHaveBeenCalled();
            expect(Modal.createDialog).toHaveBeenCalledWith(ErrorDialog, expect.anything());
        });
    });

    it("opens a voice-intent call directly in picture-in-picture rather than maximised", async () => {
        const call = {
            presented: false,
            connectionState: ConnectionState.Disconnected,
            widget: { id: "!widget:example.org" },
            participants: new Map(),
            start: vi.fn(),
        } as unknown as Call;
        vi.spyOn(CallStore.instance, "getCall").mockReturnValue(call);
        const persistenceSpy = vi.spyOn(ActiveWidgetStore.instance, "setWidgetPersistence");
        await setupAsyncStoreWithClient(CallStore.instance, MatrixClientPeg.safeGet());

        dis.dispatch<ViewRoomPayload>({
            action: Action.ViewRoom,
            room_id: roomId,
            view_call: true,
            voiceOnly: true,
            metricsTrigger: undefined,
        });
        await untilDispatch(Action.ViewRoom, dis);

        // The call is started and marked persistent so it renders in the PiP container...
        expect(call.presented).toEqual(true);
        expect(persistenceSpy).toHaveBeenCalledWith("!widget:example.org", roomId, true);
        expect(call.start).toHaveBeenCalledWith(expect.objectContaining({ voiceOnly: true }));
        // ...but the room is not switched to the maximised call view.
        expect(roomViewStore.isViewingCall()).toEqual(false);
    });

    it("opens a voice-intent call maximised when the call is already in progress", async () => {
        const call = {
            presented: false,
            connectionState: ConnectionState.Disconnected,
            widget: { id: "!widget:example.org" },
            participants: new Map([[{ userId: "@alice:example.org" }, new Set(["DEVICE"])]]),
            start: vi.fn(),
        } as unknown as Call;
        vi.spyOn(CallStore.instance, "getCall").mockReturnValue(call);
        const persistenceSpy = vi.spyOn(ActiveWidgetStore.instance, "setWidgetPersistence");
        await setupAsyncStoreWithClient(CallStore.instance, MatrixClientPeg.safeGet());

        dis.dispatch<ViewRoomPayload>({
            action: Action.ViewRoom,
            room_id: roomId,
            view_call: true,
            voiceOnly: true,
            metricsTrigger: undefined,
        });
        await untilDispatch(Action.ViewRoom, dis);

        expect(call.presented).toEqual(true);
        expect(persistenceSpy).not.toHaveBeenCalled();
        expect(roomViewStore.isViewingCall()).toEqual(true);
    });

    it("opens a voice-intent call in PiP when the call is already in progress but the lobby is skipped", async () => {
        const call = {
            presented: false,
            connectionState: ConnectionState.Disconnected,
            widget: { id: "!widget:example.org" },
            participants: new Map([[{ userId: "@alice:example.org" }, new Set(["DEVICE"])]]),
            start: vi.fn(),
        } as unknown as Call;
        vi.spyOn(CallStore.instance, "getCall").mockReturnValue(call);
        const persistenceSpy = vi.spyOn(ActiveWidgetStore.instance, "setWidgetPersistence");
        await setupAsyncStoreWithClient(CallStore.instance, MatrixClientPeg.safeGet());

        // As dispatched by the incoming call toast's Join button
        dis.dispatch<ViewRoomPayload>({
            action: Action.ViewRoom,
            room_id: roomId,
            view_call: true,
            skipLobby: true,
            voiceOnly: true,
            metricsTrigger: undefined,
        });
        await untilDispatch(Action.ViewRoom, dis);

        expect(call.presented).toEqual(true);
        expect(persistenceSpy).toHaveBeenCalledWith("!widget:example.org", roomId, true);
        expect(roomViewStore.isViewingCall()).toEqual(false);
    });

    it("opens a video-intent call maximised in the room", async () => {
        const call = {
            presented: false,
            connectionState: ConnectionState.Disconnected,
            widget: { id: "!widget:example.org" },
            start: vi.fn(),
        } as unknown as Call;
        vi.spyOn(CallStore.instance, "getCall").mockReturnValue(call);
        const persistenceSpy = vi.spyOn(ActiveWidgetStore.instance, "setWidgetPersistence");
        await setupAsyncStoreWithClient(CallStore.instance, MatrixClientPeg.safeGet());

        dis.dispatch<ViewRoomPayload>({
            action: Action.ViewRoom,
            room_id: roomId,
            view_call: true,
            voiceOnly: false,
            metricsTrigger: undefined,
        });
        await untilDispatch(Action.ViewRoom, dis);

        expect(call.presented).toEqual(true);
        expect(persistenceSpy).not.toHaveBeenCalled();
        expect(call.start).toHaveBeenCalledWith(expect.objectContaining({ voiceOnly: false }));
        expect(roomViewStore.isViewingCall()).toEqual(true);
    });

    it("should display an error message when the room is unreachable via the roomId", async () => {
        // View and wait for the room
        dis.dispatch({ action: Action.ViewRoom, room_id: roomId });
        await untilDispatch(Action.ActiveRoomChanged, dis);
        // Generate error to display the expected error message
        const error = new MatrixError(undefined, 404);
        roomViewStore.showJoinRoomError(error, roomId);

        // Check the modal props
        expect(vi.mocked(Modal).createDialog.mock.calls[0][1]).toMatchSnapshot();
    });
    // The server bob is on will affect the message we send.
    it.each(["server", "another-server"])(
        "should display an invite-specific error message when the room is unreachable",
        async (bobsServer) => {
            room.getMyMembership.mockReturnValue(KnownMembership.Invite);
            room.getMember.mockImplementationOnce((memberUserId) => {
                if (userId === memberUserId) {
                    const member = mkRoomMember(roomId, userId, KnownMembership.Invite);
                    member.events.member!.getSender = () => `@bob:${bobsServer}`;
                    return member;
                }
                return null;
            });
            dis.dispatch({ action: Action.ViewRoom, room_id: roomId });
            await untilDispatch(Action.ActiveRoomChanged, dis);

            // Generate error to display the expected error message
            const error = new MatrixError(undefined, 404);
            roomViewStore.showJoinRoomError(error, roomId);

            // Check the modal props
            expect(vi.mocked(Modal).createDialog.mock.calls[0][1]).toMatchSnapshot();
        },
    );

    it("should display an error message when the provided room is invalid", async () => {
        dis.dispatch({ action: Action.JoinRoom, room_id: "" });
        const result = await untilDispatch(Action.JoinRoomError, dis);
        expect(result.err.cause.message).toEqual("Cannot join room: no room ID or alias to join");
    });

    it("should display the generic error message when the roomId doesnt match", async () => {
        // When
        // Generate error to display the expected error message
        const error = new MatrixError({ error: "my 404 error" }, 404);
        roomViewStore.showJoinRoomError(error, roomId);

        // Check the modal props
        expect(vi.mocked(Modal).createDialog.mock.calls[0][1]).toMatchSnapshot();
    });

    it("clears the unread flag when viewing a room", async () => {
        room.getAccountData.mockReturnValue(
            mkEvent({ type: "m.marked_unread", user: "@anyone:example.org", content: { unread: true }, event: true }),
        );
        dis.dispatch({ action: Action.ViewRoom, room_id: roomId });
        await untilDispatch(Action.ActiveRoomChanged, dis);
        expect(mockClient.setRoomAccountData).toHaveBeenCalledWith(roomId, "m.marked_unread", {
            unread: false,
        });
    });

    describe("Sliding Sync", function () {
        beforeEach(() => {
            vi.spyOn(SettingsStore, "getValue").mockImplementation((settingName, roomId, value) => {
                return settingName === "feature_simplified_sliding_sync"; // this is enabled, everything else is disabled.
            });
            // The client syncs with sliding sync.
            vi.mocked(slidingSyncManager.isActiveFor).mockReturnValue(true);
        });

        afterEach(() => {
            // Restore immediately: this mock makes RoomViewStore.viewRoom() take the "simplified sliding sync"
            // branch, which re-dispatches Action.ViewRoom asynchronously. If left in place after this describe
            // block, it leaks into later tests (vi.clearAllMocks() clears call history but not implementations)
            // and can cause a dangling re-dispatch that fires during a later test and crashes on
            // MatrixClientPeg.safeGet() once that room is no longer set up.
            vi.mocked(SettingsStore.getValue).mockRestore();
            vi.mocked(slidingSyncManager.isActiveFor).mockReset();
        });

        it("opens rooms as regular sync does when the client fell back to it", async () => {
            vi.mocked(slidingSyncManager.isActiveFor).mockReturnValue(false);
            const setRoomVisible = vi.spyOn(slidingSyncManager, "setRoomVisible");
            dis.dispatch({ action: Action.ViewRoom, room_id: "!sub1:localhost" });
            await untilDispatch(Action.ActiveRoomChanged, dis);
            expect(roomViewStore.getRoomId()).toBe("!sub1:localhost");
            expect(setRoomVisible).not.toHaveBeenCalled();
        });

        it("subscribes to the room", async () => {
            const setRoomVisible = vi.spyOn(slidingSyncManager, "setRoomVisible").mockResolvedValue("known");
            const subscribedRoomId = "!sub1:localhost";
            dis.dispatch({ action: Action.ViewRoom, room_id: subscribedRoomId });
            await untilDispatch(Action.ActiveRoomChanged, dis);
            expect(roomViewStore.getRoomId()).toBe(subscribedRoomId);
            expect(setRoomVisible).toHaveBeenCalledWith(subscribedRoomId);
        });

        // Previously a regression test for an in-the-wild bug where rooms would rapidly switch forever in sliding sync mode
        // although that was before the complexity was removed with similified mode. I've removed the complexity but kept the
        // test anyway.
        it("doesn't get stuck in a loop if you view rooms quickly", async () => {
            const setRoomVisible = vi.spyOn(slidingSyncManager, "setRoomVisible").mockResolvedValue("known");
            const subscribedRoomId = "!sub1:localhost";
            const subscribedRoomId2 = "!sub2:localhost";
            dis.dispatch({ action: Action.ViewRoom, room_id: subscribedRoomId }, true);
            dis.dispatch({ action: Action.ViewRoom, room_id: subscribedRoomId2 }, true);
            await untilDispatch(Action.ActiveRoomChanged, dis);
            // should view 1, then 2
            const wantCalls = [[subscribedRoomId], [subscribedRoomId2]];
            expect(setRoomVisible).toHaveBeenCalledTimes(wantCalls.length);
            wantCalls.forEach((v, i) => {
                try {
                    expect(setRoomVisible.mock.calls[i][0]).toEqual(v[0]);
                } catch {
                    throw new Error(`i=${i} got ${setRoomVisible.mock.calls[i]} want ${v}`);
                }
            });
        });

        it.each(["timeout", "replaced", "known"] as const)(
            "does not return to a room that finished loading (%s) after another room was opened",
            async (outcome) => {
                const slow = Promise.withResolvers<"known" | "absent" | "timeout" | "replaced">();
                vi.spyOn(slidingSyncManager, "setRoomVisible").mockImplementation((id) =>
                    id === "!slow:localhost" ? slow.promise : Promise.resolve("known"),
                );
                dis.dispatch({ action: Action.ViewRoom, room_id: "!slow:localhost" }, true);
                await new Promise((resolve) => setTimeout(resolve, 0));
                dis.dispatch({ action: Action.ViewRoom, room_id: "!fast:localhost" }, true);
                await untilDispatch(Action.ActiveRoomChanged, dis);
                expect(roomViewStore.getRoomId()).toBe("!fast:localhost");
                slow.resolve(outcome);
                await new Promise((resolve) => setTimeout(resolve, 10));
                expect(roomViewStore.getRoomId()).toBe("!fast:localhost");
            },
        );

        it("opens a room the client has at once, updating its subscription alongside", async () => {
            // The subscription is still being updated when the room is shown.
            const setRoomVisible = vi
                .spyOn(slidingSyncManager, "setRoomVisible")
                .mockReturnValue(new Promise(() => {}));
            dis.dispatch({ action: Action.ViewRoom, room_id: room.roomId });
            await untilDispatch(Action.ActiveRoomChanged, dis);
            expect(roomViewStore.getRoomId()).toBe(room.roomId);
            expect(roomViewStore.isRoomLoading()).toBe(false);
            expect(roomViewStore.isLoadedForView()).toBe(true);
            expect(setRoomVisible).toHaveBeenCalledWith(room.roomId);
        });

        it("opens a room the server did not send, so the room view can offer to join it", async () => {
            vi.spyOn(slidingSyncManager, "setRoomVisible").mockResolvedValue("absent");
            dis.dispatch({ action: Action.ViewRoom, room_id: "!missing:localhost" });
            await untilDispatch(Action.ActiveRoomChanged, dis);
            expect(roomViewStore.getRoomId()).toBe("!missing:localhost");
            await vi.waitFor(() => expect(roomViewStore.isRoomLoading()).toBe(false));
        });

        it("does not open a room when the client was replaced while it loaded", async () => {
            vi.spyOn(slidingSyncManager, "setRoomVisible").mockResolvedValue("replaced");
            const dispatch = vi.spyOn(dis, "dispatch");
            dis.dispatch({ action: Action.ViewRoom, room_id: "!gone:localhost" }, true);
            await new Promise((resolve) => setTimeout(resolve, 10));
            const viewRooms = dispatch.mock.calls.filter(([payload]) => payload.action === Action.ViewRoom);
            expect(viewRooms).toHaveLength(1);
        });
    });

    describe("Action.JoinRoom", () => {
        it("dispatches Action.JoinRoomError and Action.AskToJoin when the join fails with 403", async () => {
            const err = new MatrixError({}, 403);

            vi.spyOn(dis, "dispatch");
            vi.spyOn(mockClient, "joinRoom").mockRejectedValueOnce(err);

            const roomId = "!hello:world";

            dis.dispatch<JoinRoomPayload>({
                action: Action.JoinRoom,
                canAskToJoin: true,
                roomId,
                metricsTrigger: "RoomPreview",
            });
            await untilDispatch(Action.PromptAskToJoin, dis);

            expect(vi.mocked(dis.dispatch).mock.calls[0][0]).toEqual({
                action: Action.JoinRoom,
                canAskToJoin: true,
                metricsTrigger: "RoomPreview",
                roomId,
            });
            expect(vi.mocked(dis.dispatch).mock.calls[1][0]).toEqual({
                action: Action.JoinRoomError,
                roomId,
                err,
                canAskToJoin: true,
            });
            expect(vi.mocked(dis.dispatch).mock.calls[2][0]).toEqual({ action: Action.PromptAskToJoin });
        });

        it("sets 'acceptSharedHistory'", async () => {
            dis.dispatch<ViewRoomPayload>({ action: Action.ViewRoom, room_id: roomId, metricsTrigger: "RoomList" });
            dis.dispatch<JoinRoomPayload>({ action: Action.JoinRoom, roomId: roomId, metricsTrigger: "RoomPreview" });
            await untilDispatch(Action.JoinRoomReady, dis);
            expect(mockClient.joinRoom).toHaveBeenCalledWith(roomId, { acceptSharedHistory: true, viaServers: [] });
        });
    });

    describe("Action.JoinRoomError", () => {
        const err = new MatrixError();
        beforeEach(() => vi.spyOn(roomViewStore, "showJoinRoomError"));

        it("calls showJoinRoomError()", async () => {
            dis.dispatch<JoinRoomErrorPayload>({ action: Action.JoinRoomError, roomId, err });
            await untilDispatch(Action.JoinRoomError, dis);
            expect(roomViewStore.showJoinRoomError).toHaveBeenCalledWith(err, roomId);
        });

        it("does not call showJoinRoomError() when canAskToJoin is true", async () => {
            dis.dispatch<JoinRoomErrorPayload>({ action: Action.JoinRoomError, roomId, err, canAskToJoin: true });
            await untilDispatch(Action.JoinRoomError, dis);
            expect(roomViewStore.showJoinRoomError).not.toHaveBeenCalled();
        });
    });

    describe("askToJoin()", () => {
        it("returns false", () => {
            expect(roomViewStore.promptAskToJoin()).toBe(false);
        });

        it("returns true", async () => {
            await dispatchPromptAskToJoin();
            expect(roomViewStore.promptAskToJoin()).toBe(true);
        });
    });

    describe("Action.SubmitAskToJoin", () => {
        const reason = "some reason";
        beforeEach(async () => await dispatchPromptAskToJoin());

        it("calls knockRoom() and sets promptAskToJoin state to false", async () => {
            vi.spyOn(mockClient, "knockRoom").mockResolvedValue({ room_id: roomId });
            await dispatchSubmitAskToJoin(roomId, reason);

            expect(mockClient.knockRoom).toHaveBeenCalledWith(roomId, { reason, viaServers: [] });
            expect(roomViewStore.promptAskToJoin()).toBe(false);
        });

        it("calls knockRoom(), sets promptAskToJoin state to false and shows an error dialog", async () => {
            const error = new MatrixError(undefined, 403);
            vi.spyOn(mockClient, "knockRoom").mockRejectedValue(error);
            await dispatchSubmitAskToJoin(roomId, reason);

            expect(mockClient.knockRoom).toHaveBeenCalledWith(roomId, { reason, viaServers: [] });
            expect(roomViewStore.promptAskToJoin()).toBe(false);
            expect(Modal.createDialog).toHaveBeenCalledWith(ErrorDialog, {
                description: "You need an invite to access this room.",
                title: "Failed to join",
            });
        });

        it("shows an error dialog with a generic error message", async () => {
            const error = new MatrixError();
            vi.spyOn(mockClient, "knockRoom").mockRejectedValue(error);
            await dispatchSubmitAskToJoin(roomId);

            expect(Modal.createDialog).toHaveBeenCalledWith(ErrorDialog, {
                description: error.message,
                title: "Failed to join",
            });
        });
    });

    describe("Action.CancelAskToJoin", () => {
        beforeEach(async () => {
            vi.spyOn(mockClient, "knockRoom").mockResolvedValue({ room_id: roomId });
            await dispatchSubmitAskToJoin(roomId);
        });

        it("calls leave()", async () => {
            vi.spyOn(mockClient, "leave").mockResolvedValue({});
            await dispatchCancelAskToJoin(roomId);

            expect(mockClient.leave).toHaveBeenCalledWith(roomId);
        });

        it("calls leave() and shows an error dialog", async () => {
            const error = new MatrixError();
            vi.spyOn(mockClient, "leave").mockRejectedValue(error);
            await dispatchCancelAskToJoin(roomId);

            expect(mockClient.leave).toHaveBeenCalledWith(roomId);
            expect(Modal.createDialog).toHaveBeenCalledWith(ErrorDialog, {
                description: error.message,
                title: "Failed to cancel",
            });
        });
    });
});
