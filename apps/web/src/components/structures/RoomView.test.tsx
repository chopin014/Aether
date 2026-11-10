/*
Copyright 2024 New Vector Ltd.
Copyright 2022 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// @vitest-environment happy-dom

import {
    vi,
    describe,
    it,
    expect,
    beforeEach,
    afterEach,
    type Mock,
    type MockedObject,
    type MockInstance,
} from "vitest";
import React, { createRef, type RefObject, type ReactElement } from "react";
import {
    EventTimeline,
    EventType,
    type IEvent,
    JoinRule,
    RoomType,
    type MatrixClient,
    MatrixError,
    MatrixEvent,
    Room,
    RoomEvent,
    RoomMember,
    RoomStateEvent,
    SearchResult,
    User,
} from "matrix-js-sdk/src/matrix";
import { type CryptoApi, CryptoEvent, UserVerificationStatus } from "matrix-js-sdk/src/crypto-api";
import { KnownMembership } from "matrix-js-sdk/src/types";
import { act, cleanup, fireEvent, render, type RenderResult, screen, waitFor, findByRole } from "test-utils-rtl";
import userEvent from "@testing-library/user-event";
import {
    createTestClient,
    emitPromise,
    filterConsole,
    flushPromises,
    mkEvent,
    mkRoomMemberJoinEvent,
    mkThirdPartyInviteEvent,
    mockPlatformPeg,
    setupAsyncStoreWithClient,
    resetAsyncStoreWithClient,
    stubClient,
    TestSDKContext,
    unmockPlatformPeg,
    untilDispatch,
} from "test-utils";

import { MatrixClientPeg } from "../../MatrixClientPeg";
import { Action } from "../../dispatcher/actions";
import defaultDispatcher from "../../dispatcher/dispatcher";
import { type ViewRoomPayload } from "../../dispatcher/payloads/ViewRoomPayload";
import { RoomView } from "./RoomView";
import SettingsStore from "../../settings/SettingsStore";
import { SettingLevel } from "../../settings/SettingLevel";
import DMRoomMap from "../../utils/DMRoomMap";
import { NotificationState } from "../../stores/notifications/NotificationState";
import { RightPanelPhases } from "../../stores/right-panel/RightPanelStorePhases";
import { type LocalRoom, LocalRoomState } from "../../models/LocalRoom";
import { DirectoryMember } from "../../utils/direct-messages";
import { createDmLocalRoom } from "../../utils/dm/createDmLocalRoom";
import { UPDATE_EVENT } from "../../stores/AsyncStore";
import RoomScrollStateStore from "../../stores/RoomScrollStateStore";
import { SDKContext } from "../../contexts/SDKContext";
import WidgetUtils from "../../utils/WidgetUtils";
import { WidgetType } from "../../widgets/WidgetType";
import WidgetStore from "../../stores/WidgetStore";
import { type ViewRoomErrorPayload } from "../../dispatcher/payloads/ViewRoomErrorPayload";
import { SearchScope } from "../../Searching";
import { MEGOLM_ENCRYPTION_ALGORITHM } from "../../utils/crypto";
import MatrixClientContext from "../../contexts/MatrixClientContext";
import { type ViewUserPayload } from "../../dispatcher/payloads/ViewUserPayload.ts";
import { CallStore } from "../../stores/CallStore.ts";
import MediaDeviceHandler, { MediaDeviceKindEnum } from "../../MediaDeviceHandler.ts";
import Modal, { type ComponentProps } from "../../Modal.tsx";
import ErrorDialog from "../views/dialogs/ErrorDialog.tsx";
import * as pinnedEventHooks from "../../hooks/usePinnedEvents";
import { TimelineRenderingType } from "../../contexts/RoomContext";
import { ModuleApi } from "../../modules/Api";
import MatrixClientBackedController from "../../settings/controllers/MatrixClientBackedController.ts";
import { type ComposerInsertPayload, ComposerType } from "../../dispatcher/payloads/ComposerInsertPayload.ts";
import { notifyRoomEntryReady } from "../../performance/RoomEntryReady";
import { ElementCall } from "../../models/Call";
import { ScopedRoomContextProvider } from "../../contexts/ScopedRoomContext";
import { RoomTimelineViewModel } from "../../viewmodels/room/timeline/RoomTimelineViewModel";

// Used by group calls
vi.spyOn(MediaDeviceHandler, "getDevices").mockResolvedValue({
    [MediaDeviceKindEnum.AudioInput]: [],
    [MediaDeviceKindEnum.VideoInput]: [],
    [MediaDeviceKindEnum.AudioOutput]: [],
});

describe("RoomView", () => {
    let cli: MockedObject<MatrixClient>;
    let room: Room;
    let rooms: Map<string, Room>;
    let stores: TestSDKContext;
    let crypto: CryptoApi;

    // mute some noise
    filterConsole("RVS update", "does not have an m.room.create event", "Current version: 1", "Version capability");

    beforeEach(() => {
        mockPlatformPeg({ reload: () => {} });
        cli = vi.mocked(stubClient());
        MatrixClientBackedController.matrixClient = cli;

        const roomName = (expect.getState().currentTestName ?? "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();

        room = new Room(`!${roomName}:example.org`, cli, "@alice:example.org");
        vi.spyOn(room, "findPredecessor");
        room.getPendingEvents = () => [];
        rooms = new Map();
        rooms.set(room.roomId, room);
        cli.getRoom.mockImplementation((roomId: string | undefined) => rooms.get(roomId || "") || null);
        cli.getRooms.mockImplementation(() => [...rooms.values()]);
        // Re-emit certain events on the mocked client
        room.on(RoomEvent.Timeline, (...args) => cli.emit(RoomEvent.Timeline, ...args));
        room.on(RoomEvent.TimelineReset, (...args) => cli.emit(RoomEvent.TimelineReset, ...args));

        DMRoomMap.makeShared(cli);
        stores = new TestSDKContext();
        stores._client = cli;
        stores.rightPanelStore.useUnitTestClient(cli);

        crypto = cli.getCrypto()!;
        vi.spyOn(cli, "getCrypto").mockReturnValue(undefined);
    });

    afterEach(() => {
        unmockPlatformPeg();
        vi.clearAllMocks();

        // Can't vi.restoreAllMocks() because some tests will break
        vi.spyOn(pinnedEventHooks, "usePinnedEvents").mockRestore();
        vi.spyOn(pinnedEventHooks, "useSortedFetchedPinnedEvents").mockRestore();

        cleanup();
        // Later tests delegate to the real getter; retaining an earlier spy would recurse into itself.
        vi.spyOn(SettingsStore, "getValue").mockRestore();
        // The sliding sync manager is shared by every test's context.
        vi.spyOn(stores.slidingSyncManager, "isActiveFor").mockRestore();
    });

    const mountRoomView = async (
        ref?: RefObject<RoomView | null>,
        props?: Partial<ComponentProps<typeof RoomView>>,
    ): Promise<RenderResult> => {
        if (stores.roomViewStore.getRoomId() !== room.roomId) {
            const switchedRoom = new Promise<void>((resolve) => {
                const subFn = () => {
                    if (stores.roomViewStore.getRoomId()) {
                        stores.roomViewStore.off(UPDATE_EVENT, subFn);
                        resolve();
                    }
                };
                stores.roomViewStore.on(UPDATE_EVENT, subFn);
            });

            act(() =>
                defaultDispatcher.dispatch<ViewRoomPayload>({
                    action: Action.ViewRoom,
                    room_id: room.roomId,
                    metricsTrigger: undefined,
                }),
            );

            await switchedRoom;
        }

        const roomView = render(
            <RoomView
                // threepidInvite should be optional on RoomView props
                // it is treated as optional in RoomView
                threepidInvite={undefined as any}
                forceTimeline={false}
                ref={ref}
                {...props}
            />,
            {
                wrapper: ({ children }) => (
                    <MatrixClientContext.Provider value={cli}>
                        <SDKContext.Provider value={stores}>{children}</SDKContext.Provider>
                    </MatrixClientContext.Provider>
                ),
            },
        );
        await flushPromises();
        return roomView;
    };

    const renderRoomView = async (switchRoom = true): Promise<ReturnType<typeof render>> => {
        if (switchRoom && stores.roomViewStore.getRoomId() !== room.roomId) {
            const switchedRoom = new Promise<void>((resolve) => {
                const subFn = () => {
                    if (stores.roomViewStore.getRoomId()) {
                        stores.roomViewStore.off(UPDATE_EVENT, subFn);
                        resolve();
                    }
                };
                stores.roomViewStore.on(UPDATE_EVENT, subFn);
            });

            defaultDispatcher.dispatch<ViewRoomPayload>({
                action: Action.ViewRoom,
                room_id: room.roomId,
                metricsTrigger: undefined,
            });

            await switchedRoom;
        }

        const roomView = render(
            <MatrixClientContext.Provider value={cli}>
                <SDKContext.Provider value={stores}>
                    <RoomView
                        // threepidInvite should be optional on RoomView props
                        // it is treated as optional in RoomView
                        threepidInvite={undefined}
                        forceTimeline={false}
                        onRegistered={vi.fn()}
                    />
                </SDKContext.Provider>
            </MatrixClientContext.Provider>,
        );
        await flushPromises();
        return roomView;
    };
    const getRoomViewInstance = async (): Promise<RoomView> => {
        const ref = createRef<RoomView>();
        await mountRoomView(ref);
        return ref.current!;
    };

    it.each([true, false])(
        "keeps a known joined room and composer hidden before readiness with encryption %s",
        async (encrypted) => {
            cli.clientRunning = true;
            cli.isInitialSyncComplete.mockReturnValue(false);
            vi.spyOn(cli, "getCrypto").mockReturnValue(crypto);
            vi.spyOn(crypto, "isEncryptionEnabledInRoom").mockResolvedValue(encrypted);
            vi.spyOn(room, "getMyMembership").mockReturnValue(KnownMembership.Join);
            const instance = await getRoomViewInstance();
            expect(instance.state.room).toBe(room);
            expect(instance.state.matrixClientIsReady).toBe(false);
            expect(document.querySelector(".mx_RoomView_messagePanel")).toBeNull();
            expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "Join the discussion" })).not.toBeInTheDocument();
        },
    );

    it("defers automatic public roster hydration until first conversation paint", async () => {
        cli.hasLazyLoadMembersEnabled.mockReturnValue(true);
        vi.spyOn(room, "getMyMembership").mockReturnValue(KnownMembership.Join);
        const load = vi.spyOn(stores.memberListStore, "ensureMembersLoaded").mockResolvedValue(undefined);
        await mountRoomView(undefined, { hideHeader: true, hideComposer: true });
        expect(load).not.toHaveBeenCalled();
        act(() => notifyRoomEntryReady(cli, room.roomId));
        await waitFor(() => expect(load).toHaveBeenCalledWith(room.roomId));
    });

    it("cancels automatic public roster hydration when leaving before first paint", async () => {
        cli.hasLazyLoadMembersEnabled.mockReturnValue(true);
        vi.spyOn(room, "getMyMembership").mockReturnValue(KnownMembership.Join);
        const load = vi.spyOn(stores.memberListStore, "ensureMembersLoaded").mockResolvedValue(undefined);
        const { unmount } = await mountRoomView(undefined, { hideHeader: true, hideComposer: true });
        unmount();
        act(() => notifyRoomEntryReady(cli, room.roomId));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(load).not.toHaveBeenCalled();
    });

    it("clears an old permalink when returning to the live timeline", async () => {
        const view = await getRoomViewInstance();
        const eventId = "$old-permalink";
        const event = mkEvent({
            type: EventType.RoomMessage,
            room: room.roomId,
            user: cli.getSafeUserId(),
            event: true,
            content: { body: "Old" },
        });
        vi.spyOn(room, "findEventById").mockReturnValue(event);
        await act(() =>
            stores.roomViewStore.viewRoom({
                action: Action.ViewRoom,
                room_id: room.roomId,
                event_id: eventId,
                highlighted: true,
                metricsTrigger: undefined,
            }),
        );
        expect(view.state.initialEventId).toBe(eventId);
        await act(() =>
            stores.roomViewStore.viewRoom({
                action: Action.ViewRoom,
                room_id: room.roomId,
                metricsTrigger: undefined,
            }),
        );
        expect(view.state.initialEventId).toBeUndefined();
    });

    it("gets a room view store from MultiRoomViewStore when given a room ID", async () => {
        stores.multiRoomViewStore.getRoomViewStoreForRoom = vi.fn().mockReturnValue(stores.roomViewStore);

        const ref = createRef<RoomView>();
        render(
            <MatrixClientContext.Provider value={cli}>
                <SDKContext.Provider value={stores}>
                    <RoomView
                        threepidInvite={undefined as any}
                        forceTimeline={false}
                        ref={ref}
                        roomId="!room:example.dummy"
                    />
                </SDKContext.Provider>
            </MatrixClientContext.Provider>,
        );

        expect(stores.multiRoomViewStore.getRoomViewStoreForRoom).toHaveBeenCalledWith("!room:example.dummy");
    });

    it("should show member list right panel phase on Action.ViewUser without `payload.member`", async () => {
        const spy = vi.spyOn(stores.rightPanelStore, "showOrHidePhase");
        await renderRoomView(false);

        defaultDispatcher.dispatch<ViewUserPayload>(
            {
                action: Action.ViewUser,
                member: undefined,
            },
            true,
        );

        expect(spy).toHaveBeenCalledWith(RightPanelPhases.MemberList);
    });

    it("when there is no room predecessor, getHiddenHighlightCount should return 0", async () => {
        const instance = await getRoomViewInstance();
        expect(instance.getHiddenHighlightCount()).toBe(0);
    });

    it("should hide the composer when hideComposer=true", async () => {
        // Join the room
        vi.spyOn(room, "getMyMembership").mockReturnValue(KnownMembership.Join);
        const { asFragment } = await mountRoomView(undefined, { hideComposer: true });

        expect(screen.queryByRole("textbox", { name: "Send an unencrypted message…" })).not.toBeInTheDocument();
        expect(asFragment()).toMatchSnapshot();
    });

    it("should hide the header when hideHeader=true", async () => {
        // Join the room
        vi.spyOn(room, "getMyMembership").mockReturnValue(KnownMembership.Join);
        const { asFragment } = await mountRoomView(undefined, { hideHeader: true });

        // Check that the room name button in the header is not rendered
        expect(screen.queryByRole("button", { name: room.name })).not.toBeInTheDocument();
        expect(asFragment()).toMatchSnapshot();
    });

    it("should hide the right panel when hideRightPanel=true", async () => {
        // Join the room
        vi.spyOn(room, "getMyMembership").mockReturnValue(KnownMembership.Join);
        const { asFragment, rerender } = await mountRoomView(undefined);

        defaultDispatcher.dispatch<ViewUserPayload>(
            {
                action: Action.ViewUser,
                member: undefined,
            },
            true,
        );

        // Check that the right panel is rendered
        await expect(screen.findByTestId("right-panel")).resolves.toBeTruthy();
        // Now rerender with hideRightPanel=true
        rerender(<RoomView threepidInvite={undefined} forceTimeline={false} hideRightPanel={true} />);
        // Check that the right panel is not rendered
        await expect(screen.findByTestId("right-panel")).rejects.toThrow();
        expect(asFragment()).toMatchSnapshot();
    });

    it("should hide the pinned message banner when hidePinnedMessageBanner=true", async () => {
        // Join the room
        vi.spyOn(room, "getMyMembership").mockReturnValue(KnownMembership.Join);

        const pinnedEvent = new MatrixEvent({
            type: EventType.RoomMessage,
            sender: "@alice:example.org",
            content: {
                body: "First pinned message",
                msgtype: "m.text",
            },
            room_id: room.roomId,
            origin_server_ts: 0,
            event_id: "$eventId",
        });

        vi.spyOn(pinnedEventHooks, "usePinnedEvents").mockReturnValue([pinnedEvent.getId()!]);
        vi.spyOn(pinnedEventHooks, "useSortedFetchedPinnedEvents").mockReturnValue([pinnedEvent]);

        const { asFragment, rerender } = await mountRoomView(undefined);
        // Check that the pinned message banner is rendered
        await expect(screen.findByTestId("pinned-message-banner")).resolves.toBeTruthy();
        // Now rerender with hidePinnedMessagesBanner=true
        rerender(<RoomView threepidInvite={undefined} forceTimeline={false} hidePinnedMessageBanner={true} />);
        // Check that the pinned message banner is not rendered
        await expect(screen.findByTestId("pinned-message-banner")).rejects.toThrow();
        expect(asFragment()).toMatchSnapshot();
    });

    it("keeps a newer view when an older permalink's event arrives after it", async () => {
        // The event of a permalink the client does not have is fetched first; someone may ask for the room's latest
        // messages meanwhile.
        const ref = createRef<RoomView>();
        await mountRoomView(ref);
        const fetched = Promise.withResolvers<Awaited<ReturnType<MatrixClient["fetchRoomEvent"]>>>();
        cli.fetchRoomEvent = vi.fn().mockReturnValue(fetched.promise);

        await act(async () => {
            defaultDispatcher.dispatch<ViewRoomPayload>(
                { action: Action.ViewRoom, room_id: room.roomId, event_id: "$elsewhere", metricsTrigger: undefined },
                true,
            );
            await flushPromises();
        });
        await waitFor(() => expect(cli.fetchRoomEvent).toHaveBeenCalledWith(room.roomId, "$elsewhere"));
        await act(async () => {
            defaultDispatcher.dispatch<ViewRoomPayload>(
                { action: Action.ViewRoom, room_id: room.roomId, metricsTrigger: undefined },
                true,
            );
            await flushPromises();
        });
        expect(ref.current?.state.initialEventId).toBeUndefined();

        await act(async () => {
            fetched.resolve({
                event_id: "$elsewhere",
                room_id: room.roomId,
                type: "m.room.message",
                sender: "@other:example.org",
                origin_server_ts: 1,
                content: { body: "Old", msgtype: "m.text" },
            });
            await flushPromises();
        });
        expect(ref.current?.state.initialEventId).toBeUndefined();
    });

    it("sets the room up when someone moves on while the permalink it opened on is fetched", async () => {
        // While the first update waits, others are ignored: the room view has no room yet.
        const fetched = Promise.withResolvers<Awaited<ReturnType<MatrixClient["fetchRoomEvent"]>>>();
        cli.fetchRoomEvent = vi.fn().mockReturnValue(fetched.promise);
        const named = new Promise<void>((resolve) => {
            const onUpdate = (): void => {
                if (!stores.roomViewStore.getRoomId()) return;
                stores.roomViewStore.off(UPDATE_EVENT, onUpdate);
                resolve();
            };
            stores.roomViewStore.on(UPDATE_EVENT, onUpdate);
        });
        act(() =>
            defaultDispatcher.dispatch<ViewRoomPayload>({
                action: Action.ViewRoom,
                room_id: room.roomId,
                event_id: "$elsewhere",
                metricsTrigger: undefined,
            }),
        );
        await named;
        expect(stores.roomViewStore.getInitialEventId()).toBe("$elsewhere");
        const ref = createRef<RoomView>();
        await mountRoomView(ref);
        await waitFor(() => expect(cli.fetchRoomEvent).toHaveBeenCalledWith(room.roomId, "$elsewhere"));
        expect(ref.current?.state.roomId).toBeUndefined();

        await act(async () => {
            defaultDispatcher.dispatch<ViewRoomPayload>(
                { action: Action.ViewRoom, room_id: room.roomId, metricsTrigger: undefined },
                true,
            );
            await flushPromises();
        });
        await act(async () => {
            fetched.resolve({
                event_id: "$elsewhere",
                room_id: room.roomId,
                type: "m.room.message",
                sender: "@other:example.org",
                origin_server_ts: 1,
                content: { body: "Old", msgtype: "m.text" },
            });
            await flushPromises();
        });
        await waitFor(() => expect(ref.current?.state.roomId).toBe(room.roomId));
        expect(ref.current?.state.room).toBe(room);
        expect(ref.current?.state.initialEventId).toBeUndefined();
    });

    // Given as long as its waits may take together on a loaded machine, beyond the default five seconds for a test.
    it("returns to the position someone left a room at, once sliding sync has loaded it", async () => {
        // Under sliding sync a room the client does not have yet is named while its subscription loads, then again
        // once it has brought the room.
        RoomScrollStateStore.setScrollState(room.roomId, { focussedEvent: "$left-here", pixelOffset: 42 });
        vi.spyOn(stores.slidingSyncManager, "isActiveFor").mockReturnValue(true);
        const visible = Promise.withResolvers<"known">();
        vi.spyOn(stores.slidingSyncManager, "setRoomVisible").mockReturnValue(visible.promise);
        rooms.delete(room.roomId);
        const ref = createRef<RoomView>();
        await mountRoomView(ref);
        expect(stores.roomViewStore.isRoomLoading()).toBe(true);

        await act(async () => {
            rooms.set(room.roomId, room);
            visible.resolve("known");
            await flushPromises();
        });
        // Given time on a loaded machine: the store's second update is dispatched asynchronously.
        await waitFor(() => expect(stores.roomViewStore.isRoomLoading()).toBe(false), { timeout: 5000 });
        await waitFor(() => expect(ref.current?.state.initialEventId).toBe("$left-here"), { timeout: 5000 });
        expect(ref.current?.state.initialEventPixelOffset).toBe(42);
        RoomScrollStateStore.setScrollState(room.roomId, null);
    }, 15_000);

    it("opens the latest messages when asked again for the room while sliding sync loads it", async () => {
        // Such as someone clicking the room again: a request for its live timeline, not the end of the first load.
        RoomScrollStateStore.setScrollState(room.roomId, { focussedEvent: "$left-here", pixelOffset: 42 });
        vi.spyOn(stores.slidingSyncManager, "isActiveFor").mockReturnValue(true);
        const visible = Promise.withResolvers<"known">();
        vi.spyOn(stores.slidingSyncManager, "setRoomVisible").mockReturnValue(visible.promise);
        rooms.delete(room.roomId);
        const ref = createRef<RoomView>();
        await mountRoomView(ref);
        expect(stores.roomViewStore.isRoomLoading()).toBe(true);

        await act(async () => {
            defaultDispatcher.dispatch<ViewRoomPayload>({
                action: Action.ViewRoom,
                room_id: room.roomId,
                metricsTrigger: undefined,
            });
            await flushPromises();
        });
        await waitFor(() => expect(stores.roomViewStore.isRoomLoading()).toBe(false));
        expect(ref.current?.state.initialEventId).toBeUndefined();

        // The first request's load finishing later changes nothing: the newer request replaced it.
        await act(async () => {
            rooms.set(room.roomId, room);
            visible.resolve("known");
            await flushPromises();
        });
        expect(ref.current?.state.initialEventId).toBeUndefined();
        RoomScrollStateStore.setScrollState(room.roomId, null);
    });

    it("opens a room the client has at once under sliding sync, at the position it was left at", async () => {
        RoomScrollStateStore.setScrollState(room.roomId, { focussedEvent: "$left-here", pixelOffset: 42 });
        vi.spyOn(stores.slidingSyncManager, "isActiveFor").mockReturnValue(true);
        // The room's subscription is still being updated.
        vi.spyOn(stores.slidingSyncManager, "setRoomVisible").mockReturnValue(new Promise(() => {}));
        const ref = createRef<RoomView>();
        await mountRoomView(ref);

        expect(stores.roomViewStore.isRoomLoading()).toBe(false);
        await waitFor(() => expect(ref.current?.state.initialEventId).toBe("$left-here"));
        expect(ref.current?.state.initialEventPixelOffset).toBe(42);
        expect(ref.current?.state.room).toBe(room);
        RoomScrollStateStore.setScrollState(room.roomId, null);
    });

    it("shares native sliding-sync roster hydration with the member list instead of importing cached members", async () => {
        await mountRoomView();
        const getValue = SettingsStore.getValue.bind(SettingsStore);
        vi.spyOn(SettingsStore, "getValue").mockImplementation((name, ...args) =>
            name === "feature_simplified_sliding_sync" ? true : getValue(name, ...args),
        );
        vi.spyOn(stores.slidingSyncManager, "isActiveFor").mockReturnValue(true);
        cli.hasLazyLoadMembersEnabled.mockReturnValue(true);
        vi.spyOn(room, "getMyMembership").mockReturnValue(KnownMembership.Join);
        const cachedHydration = vi.spyOn(room, "loadMembersIfNeeded");
        const response = Promise.withResolvers<Awaited<ReturnType<MatrixClient["members"]>>>();
        cli.members = vi.fn().mockReturnValue(response.promise);
        act(() => {
            cli.emit(RoomEvent.MyMembership, room, KnownMembership.Join, KnownMembership.Leave);
        });
        const memberList = stores.memberListStore.loadMemberList(room.roomId);
        await waitFor(() => expect(cli.members).toHaveBeenCalledTimes(1));
        await act(async () => {
            response.resolve({ chunk: [] });
            await memberList;
        });
        expect(cachedHydration).not.toHaveBeenCalled();
        expect(cli.members).toHaveBeenCalledTimes(1);
    });

    it("leaves the jump-to-latest and unread buttons to the MVVM timeline, which draws its own", async () => {
        const getValue = SettingsStore.getValue.bind(SettingsStore);
        vi.spyOn(SettingsStore, "getValue").mockImplementation((name, ...args) =>
            name === "feature_new_timeline" ? true : getValue(name, ...args),
        );
        vi.spyOn(room, "getMyMembership").mockReturnValue(KnownMembership.Join);
        const { container } = await mountRoomView();
        await waitFor(() => expect(container.querySelector(".mx_NewTimelinePanel")).not.toBeNull());
        expect(container.querySelector(".mx_JumpToBottomButton")).toBeNull();
        expect(container.querySelector(".mx_TopUnreadMessagesBar")).toBeNull();
    });

    describe("desktop pinned messages", () => {
        let desktopShell: boolean;
        let pinnedEvent: MatrixEvent;
        let restoreSettings: () => void;

        beforeEach(() => {
            desktopShell = true;
            const getValue = SettingsStore.getValue.bind(SettingsStore);
            const setting = vi.spyOn(SettingsStore, "getValue").mockImplementation((name, ...args) => {
                return name === "feature_desktop_shell" ? desktopShell : getValue(name, ...args);
            });
            restoreSettings = () => setting.mockRestore();
            vi.spyOn(room, "getMyMembership").mockReturnValue(KnownMembership.Join);
            pinnedEvent = new MatrixEvent({
                type: EventType.RoomMessage,
                sender: "@alice:example.org",
                content: { body: "A pinned channel message", msgtype: "m.text" },
                room_id: room.roomId,
                origin_server_ts: 0,
                event_id: "$pinnedEvent",
            });
            room.currentState.setStateEvents([
                new MatrixEvent({
                    type: EventType.RoomPinnedEvents,
                    state_key: "",
                    room_id: room.roomId,
                    content: { pinned: [pinnedEvent.getId()!] },
                }),
            ]);
            vi.spyOn(pinnedEventHooks, "useSortedFetchedPinnedEvents").mockReturnValue([pinnedEvent]);
        });

        afterEach(() => {
            restoreSettings();
        });

        it.each([true, false])(
            "places the header above the content split only in desktop mode (%s)",
            async (enabled) => {
                desktopShell = enabled;
                await mountRoomView();
                const header = screen.getByRole("banner");
                expect(header.closest(".mx_MainSplit") === null).toBe(enabled);
                expect(screen.getAllByRole("banner")).toHaveLength(1);
            },
        );

        it("should not mount the banner or open the pins panel by default in desktop text channels", async () => {
            await mountRoomView();

            expect(screen.getByTestId("timeline")).toBeInTheDocument();
            expect(screen.queryByTestId("pinned-message-banner")).not.toBeInTheDocument();
            expect(screen.queryByText("A pinned channel message")).not.toBeInTheDocument();
            expect(stores.rightPanelStore.currentCardForRoom(room.roomId).phase).not.toBe(
                RightPanelPhases.PinnedMessages,
            );
            expect(pinnedEventHooks.useSortedFetchedPinnedEvents).not.toHaveBeenCalled();
            expect(room.currentState.getStateEvents(EventType.RoomPinnedEvents, "")?.getContent().pinned).toEqual([
                pinnedEvent.getId(),
            ]);
        });

        it("updates the desktop panel size when an already open member panel changes to a thread", async () => {
            const ref = createRef<RoomView>();
            await mountRoomView(ref);
            await act(() => stores.rightPanelStore.setCard({ phase: RightPanelPhases.MemberList }, false, room.roomId));
            const timeline = screen.getByTestId("timeline");
            expect(ref.current?.state.rightPanelPhase).toBe(RightPanelPhases.MemberList);
            await act(() =>
                stores.rightPanelStore.openThread(
                    { phase: RightPanelPhases.ThreadView, state: { threadHeadEvent: pinnedEvent } },
                    room.roomId,
                ),
            );
            expect(ref.current?.state.rightPanelPhase).toBe(RightPanelPhases.ThreadView);
            expect(screen.getByTestId("timeline")).toBe(timeline);
            await act(() => stores.rightPanelStore.closeThread(room.roomId));
            expect(ref.current?.state.rightPanelPhase).toBe(RightPanelPhases.MemberList);
            expect(screen.getByTestId("timeline")).toBe(timeline);
        });

        it("opens the desktop pins popover without replacing the channel's right panel", async () => {
            cli.setRoomAccountData.mockResolvedValue({});
            const fetchEvent = vi.spyOn(pinnedEventHooks, "fetchPinnedEvent").mockResolvedValue(pinnedEvent);
            const user = userEvent.setup();
            try {
                await mountRoomView();
                const previousCard = stores.rightPanelStore.currentCardForRoom(room.roomId);
                const wasOpen = stores.rightPanelStore.isOpenForRoom(room.roomId);
                const trigger = screen.getByRole("button", { name: "Pinned messages" });
                const popover = document.getElementById(trigger.getAttribute("aria-controls")!)!;

                await user.click(trigger);
                // Happy DOM does not implement the native popover toggle default action.
                fireEvent(popover, Object.assign(new Event("toggle"), { oldState: "closed", newState: "open" }));

                expect(trigger).toHaveAttribute("aria-expanded", "true");
                expect(await screen.findByText("A pinned channel message")).toBeInTheDocument();
                expect(stores.rightPanelStore.currentCardForRoom(room.roomId)).toBe(previousCard);
                expect(stores.rightPanelStore.isOpenForRoom(room.roomId)).toBe(wasOpen);
                expect(screen.queryByTestId("pinned-message-banner")).not.toBeInTheDocument();

                await user.click(trigger);
                fireEvent(popover, Object.assign(new Event("toggle"), { oldState: "open", newState: "closed" }));

                expect(trigger).toHaveAttribute("aria-expanded", "false");
                expect(screen.queryByText("A pinned channel message")).not.toBeInTheDocument();
                expect(stores.rightPanelStore.currentCardForRoom(room.roomId)).toBe(previousCard);
                expect(stores.rightPanelStore.isOpenForRoom(room.roomId)).toBe(wasOpen);
            } finally {
                fetchEvent.mockRestore();
            }
        });

        it("should retain the automatic pinned message banner outside the desktop shell", async () => {
            desktopShell = false;
            await mountRoomView();

            expect(await screen.findByTestId("pinned-message-banner")).toBeInTheDocument();
            expect(screen.getByText("A pinned channel message")).toBeInTheDocument();
        });
    });

    it("watches each setting of the room once, however often the room view store updates", async () => {
        const watch = vi.spyOn(SettingsStore, "watchSetting");
        const unwatch = vi.spyOn(SettingsStore, "unwatchSetting");
        const { unmount } = await mountRoomView();
        // The store updates many times while a room is shown, such as for each reply quoted.
        for (let i = 0; i < 3; i++) {
            await act(async () => {
                stores.roomViewStore.emit(UPDATE_EVENT);
            });
        }
        await flushPromises();

        const isRoomWatch = ([name, roomId]: Parameters<typeof SettingsStore.watchSetting>): boolean =>
            name === "showDisplaynameChanges" && roomId === room.roomId;
        expect(watch.mock.calls.filter(isRoomWatch)).toHaveLength(1);
        const watcher = watch.mock.results[watch.mock.calls.findIndex(isRoomWatch)].value;

        unmount();
        expect(unwatch).toHaveBeenCalledWith(watcher);
    });

    describe("enableReadReceiptsAndMarkersOnActivity", () => {
        it.each([
            {
                enabled: false,
                testName: "should send read receipts and update read marker on focus when disabled",
                checkCall: (sendReadReceiptsSpy: Mock, updateReadMarkerSpy: Mock) => {
                    expect(sendReadReceiptsSpy).toHaveBeenCalled();
                    expect(updateReadMarkerSpy).toHaveBeenCalled();
                },
            },
            {
                enabled: true,
                testName: "should not send read receipts and update read marker on focus when enabled",
                checkCall: (sendReadReceiptsSpy: Mock, updateReadMarkerSpy: Mock) => {
                    expect(sendReadReceiptsSpy).not.toHaveBeenCalled();
                    expect(updateReadMarkerSpy).not.toHaveBeenCalled();
                },
            },
        ])("$testName", async ({ enabled, checkCall }) => {
            // Join the room
            vi.spyOn(room, "getMyMembership").mockReturnValue(KnownMembership.Join);
            const ref = createRef<RoomView>();
            await mountRoomView(ref, {
                enableReadReceiptsAndMarkersOnActivity: enabled,
            });

            // Wait for the timeline to be rendered
            await waitFor(() => expect(screen.getByTestId("timeline")).not.toBeNull());

            // Get the RoomView instance and mock the messagePanel methods
            const instance = ref.current!;
            const sendReadReceiptsSpy = vi.fn();
            const updateReadMarkerSpy = vi.fn();
            // @ts-ignore - accessing private property for testing
            instance.messagePanel = {
                sendReadReceipts: sendReadReceiptsSpy,
                updateReadMarker: updateReadMarkerSpy,
                getScrollState: vi.fn(),
            };

            // Find the main RoomView div and trigger focus
            const timeline = screen.getByTestId("timeline");
            fireEvent.focus(timeline);

            // Verify that sendReadReceipts and updateReadMarker were called or not based on the enabled state
            checkCall(sendReadReceiptsSpy, updateReadMarkerSpy);
        });

        it("leaves read state to focus in the MVVM timeline when disabled", async () => {
            const getValue = SettingsStore.getValue.bind(SettingsStore);
            vi.spyOn(SettingsStore, "getValue").mockImplementation((name, ...args) =>
                name === "feature_new_timeline" ? true : getValue(name, ...args),
            );
            vi.spyOn(room, "getMyMembership").mockReturnValue(KnownMembership.Join);
            // Private: the view model's loop that moves the fully read marker on while the reader is active.
            const onActivity = vi.spyOn(RoomTimelineViewModel.prototype as any, "moveReadMarkerOnWhileActive");
            const sendReceipt = vi.spyOn(RoomTimelineViewModel.prototype, "sendReadReceiptNow");
            const moveMarker = vi.spyOn(RoomTimelineViewModel.prototype, "moveReadMarkerOnNow");
            const { container } = await mountRoomView(undefined, { enableReadReceiptsAndMarkersOnActivity: false });
            await waitFor(() => expect(container.querySelector(".mx_NewTimelinePanel")).not.toBeNull());
            expect(onActivity).not.toHaveBeenCalled();
            // The room view can already take focus as it mounts; count from a focus of our own.
            sendReceipt.mockClear();
            moveMarker.mockClear();

            fireEvent.focus(screen.getByTestId("timeline"));

            expect(sendReceipt).toHaveBeenCalledTimes(1);
            expect(moveMarker).toHaveBeenCalledTimes(1);
        });
    });

    describe("invites", () => {
        beforeEach(() => {
            const member = new RoomMember(room.roomId, cli.getSafeUserId());
            member.membership = KnownMembership.Invite;
            member.events.member = new MatrixEvent({
                sender: "@bob:example.org",
                content: { membership: KnownMembership.Invite },
            });
            room.getMyMembership = vi.fn().mockReturnValue(KnownMembership.Invite);
            room.getMember = vi.fn().mockReturnValue(member);
        });

        it("renders an invite room", async () => {
            const { asFragment } = await mountRoomView();
            expect(asFragment()).toMatchSnapshot();
        });

        it("handles accepting an invite", async () => {
            const { getByRole } = await mountRoomView();

            fireEvent.click(getByRole("button", { name: "Accept" }));

            await expect(untilDispatch(Action.JoinRoomReady, defaultDispatcher)).resolves.toStrictEqual(
                expect.objectContaining({
                    roomId: "!roomviewinviteshandlesacceptinganinvite:example.org",
                }),
            );
        });
        it("handles declining an invite", async () => {
            const { getByRole } = await mountRoomView();
            vi.spyOn(Modal, "createDialog").mockReturnValue({
                finished: Promise.resolve([true, false, false]),
                close: vi.fn(),
            });
            await fireEvent.click(getByRole("button", { name: "Decline" }));
            await waitFor(() => expect(cli.leave).toHaveBeenCalledWith(room.roomId));
            expect(cli.setIgnoredUsers).not.toHaveBeenCalled();
        });
        it("handles declining an invite and ignoring the user", async () => {
            const { getByRole } = await mountRoomView();
            cli.getIgnoredUsers.mockReturnValue(["@carol:example.org"]);
            vi.spyOn(Modal, "createDialog").mockReturnValue({
                finished: Promise.resolve([true, true, false]),
                close: vi.fn(),
            });
            await act(() => fireEvent.click(getByRole("button", { name: "Decline and block" })));
            expect(cli.leave).toHaveBeenCalledWith(room.roomId);
            expect(cli.setIgnoredUsers).toHaveBeenCalledWith(["@carol:example.org", "@bob:example.org"]);
        });
        it("prevents ignoring own user", async () => {
            const member = new RoomMember(room.roomId, cli.getSafeUserId());
            member.membership = KnownMembership.Invite;
            member.events.member = new MatrixEvent({
                /*
                It doesn't matter that this is an invite event coming from own user, we just
                want to simulate a situation where the sender of the membership event somehow
                ends up being own user.
                 */
                sender: cli.getSafeUserId(),
                content: { membership: KnownMembership.Invite },
            });
            vi.spyOn(room, "getMyMembership").mockReturnValue(KnownMembership.Invite);
            vi.spyOn(room, "getMember").mockReturnValue(member);

            const { getByRole } = await mountRoomView();
            cli.getIgnoredUsers.mockReturnValue(["@carol:example.org"]);
            vi.spyOn(Modal, "createDialog").mockReturnValue({
                finished: Promise.resolve([true, true, false]),
                close: vi.fn(),
            });

            await act(() => fireEvent.click(getByRole("button", { name: "Decline and block" })));

            // Should show error in a modal dialog
            await waitFor(() => {
                expect(Modal.createDialog).toHaveBeenLastCalledWith(ErrorDialog, {
                    title: "Failed to reject invite",
                    description: "Cannot determine which user to ignore since the member event has changed.",
                });
            });

            // The ignore call should not go through
            expect(cli.setIgnoredUsers).not.toHaveBeenCalled();
        });
        it("handles declining an invite and reporting the room", async () => {
            const { getByRole } = await mountRoomView();
            vi.spyOn(Modal, "createDialog").mockReturnValue({
                finished: Promise.resolve([true, false, "with a reason"]),
                close: vi.fn(),
            });
            await fireEvent.click(getByRole("button", { name: "Decline and block" }));
            expect(cli.leave).toHaveBeenCalledWith(room.roomId);
            expect(cli.reportRoom).toHaveBeenCalledWith(room.roomId, "with a reason");
        });
    });

    describe("when there is an old room", () => {
        let instance: RoomView;
        let oldRoom: Room;

        beforeEach(async () => {
            instance = await getRoomViewInstance();
            oldRoom = new Room("!old:example.com", cli, cli.getSafeUserId());
            rooms.set(oldRoom.roomId, oldRoom);
            vi.spyOn(room, "findPredecessor").mockReturnValue({ roomId: oldRoom.roomId });
        });

        it("and it has 0 unreads, getHiddenHighlightCount should return 0", async () => {
            vi.spyOn(oldRoom, "getUnreadNotificationCount").mockReturnValue(0);
            expect(instance.getHiddenHighlightCount()).toBe(0);
            // assert that msc3946ProcessDynamicPredecessor is false by default
            expect(room.findPredecessor).toHaveBeenCalledWith(false);
        });

        it("and it has 23 unreads, getHiddenHighlightCount should return 23", async () => {
            vi.spyOn(oldRoom, "getUnreadNotificationCount").mockReturnValue(23);
            expect(instance.getHiddenHighlightCount()).toBe(23);
        });

        describe("and feature_dynamic_room_predecessors is enabled", () => {
            beforeEach(() => {
                act(() => instance.setState({ msc3946ProcessDynamicPredecessor: true }));
            });

            afterEach(() => {
                act(() => instance.setState({ msc3946ProcessDynamicPredecessor: false }));
            });

            it("should pass the setting to findPredecessor", async () => {
                expect(instance.getHiddenHighlightCount()).toBe(0);
                expect(room.findPredecessor).toHaveBeenCalledWith(true);
            });
        });
    });

    it("updates url preview visibility on encryption state change", async () => {
        room.getMyMembership = vi.fn().mockReturnValue(KnownMembership.Join);
        vi.spyOn(cli, "getCrypto").mockReturnValue(crypto);
        // we should be starting unencrypted
        expect(await cli.getCrypto()?.isEncryptionEnabledInRoom(room.roomId)).toEqual(false);

        const roomViewInstance = await getRoomViewInstance();

        // in a default (non-encrypted room, it should start out with url previews enabled)
        // This is a white-box test in that we're asserting things about the state, which
        // is not ideal, but asserting that a URL preview just isn't there could risk the
        // test being invalid because the previews just hasn't rendered yet. This feels
        // like the safest way I think?
        // This also relies on the default settings being URL previews on normally and
        // off for e2e rooms because 1) it's probably useful to assert this and
        // 2) SettingsStore is a static class and so very hard to mock out.
        expect(roomViewInstance.state.showUrlPreview).toBe(true);

        // now enable encryption
        vi.spyOn(cli.getCrypto()!, "isEncryptionEnabledInRoom").mockResolvedValue(true);

        // and fake an encryption event into the room to prompt it to re-check
        act(() => {
            const encryptionEvent = new MatrixEvent({
                type: EventType.RoomEncryption,
                sender: cli.getUserId()!,
                content: {},
                event_id: "someid",
                room_id: room.roomId,
            });
            const roomState = room.getLiveTimeline().getState(EventTimeline.FORWARDS)!;
            cli.emit(RoomStateEvent.Events, encryptionEvent, roomState, null);
        });

        // URL previews should now be disabled
        await waitFor(() => expect(roomViewInstance.state.showUrlPreview).toBe(false));
    });

    it("should not display the timeline when the room encryption is loading", async () => {
        vi.spyOn(room, "getMyMembership").mockReturnValue(KnownMembership.Join);
        vi.spyOn(cli, "getCrypto").mockReturnValue(crypto);
        const deferred = Promise.withResolvers<boolean>();
        vi.spyOn(cli.getCrypto()!, "isEncryptionEnabledInRoom").mockImplementation(() => deferred.promise);

        const { asFragment, container } = await mountRoomView();
        expect(container.querySelector(".mx_RoomView_messagePanel")).toBeNull();
        expect(asFragment()).toMatchSnapshot();

        deferred.resolve(true);
        await waitFor(() => expect(container.querySelector(".mx_RoomView_messagePanel")).not.toBeNull());
        expect(asFragment()).toMatchSnapshot();
    });

    describe("while crypto is asked whether the room is encrypted", () => {
        let ask: MockInstance<CryptoApi["isEncryptionEnabledInRoom"]>;

        beforeEach(() => {
            vi.spyOn(room, "getMyMembership").mockReturnValue(KnownMembership.Join);
            vi.spyOn(cli, "getCrypto").mockReturnValue(crypto);
            ask = vi.spyOn(crypto, "isEncryptionEnabledInRoom");
        });

        const encryptionEvent = (): MatrixEvent =>
            new MatrixEvent({
                type: EventType.RoomEncryption,
                state_key: "",
                sender: cli.getSafeUserId(),
                content: { algorithm: MEGOLM_ENCRYPTION_ALGORITHM },
                event_id: "$encryption",
                room_id: room.roomId,
            });

        it("keeps URL previews off until crypto answers, even if their setting changes meanwhile", async () => {
            const answer = Promise.withResolvers<boolean>();
            ask.mockReturnValue(answer.promise);
            const ref = createRef<RoomView>();
            await mountRoomView(ref, { hideHeader: true, hideComposer: true });

            // As when either URL preview setting changes. Private, so called as the setting watchers call it.
            act(() =>
                (ref.current as unknown as { onUrlPreviewsEnabledChange: () => void }).onUrlPreviewsEnabledChange(),
            );
            expect(ref.current!.state.showUrlPreview).toBe(false);

            await act(async () => answer.resolve(false));
            await waitFor(() => expect(ref.current!.state.showUrlPreview).toBe(true));
        });

        it("asks crypto once as the room is set up", async () => {
            ask.mockReturnValue(new Promise(() => {}));
            await mountRoomView(undefined, { hideHeader: true, hideComposer: true });
            expect(ask).toHaveBeenCalledTimes(1);
        });

        it("asks crypto again when the room is encrypted while a check waits", async () => {
            const before = Promise.withResolvers<boolean>();
            const after = Promise.withResolvers<boolean>();
            ask.mockReturnValueOnce(before.promise).mockReturnValueOnce(after.promise);
            const ref = createRef<RoomView>();
            await mountRoomView(ref, { hideHeader: true, hideComposer: true });

            act(() => {
                const event = encryptionEvent();
                room.currentState.setStateEvents([event]);
                cli.emit(RoomStateEvent.Events, event, room.currentState, null);
            });
            expect(ask).toHaveBeenCalledTimes(2);

            await act(async () => {
                before.resolve(false);
                after.resolve(true);
            });
            await waitFor(() => expect(ref.current!.state.isRoomEncrypted).toBe(true));
        });

        it("shows the newest answer when an older one comes back after it", async () => {
            const before = Promise.withResolvers<boolean>();
            const after = Promise.withResolvers<boolean>();
            ask.mockReturnValueOnce(before.promise).mockReturnValueOnce(after.promise);
            const ref = createRef<RoomView>();
            await mountRoomView(ref, { hideHeader: true, hideComposer: true });

            act(() => {
                const event = encryptionEvent();
                room.currentState.setStateEvents([event]);
                cli.emit(RoomStateEvent.Events, event, room.currentState, null);
            });
            // The check asked once the room was encrypted answers first; the one asked before it comes back later.
            await act(async () => after.resolve(true));
            await act(async () => before.resolve(false));

            expect(ref.current!.state.isRoomEncrypted).toBe(true);
            // By the setting for encrypted rooms, off by default, rather than the one for other rooms.
            expect(ref.current!.state.showUrlPreview).toBe(false);
        });

        it("stops URL previews as soon as the room is encrypted, before its trust shield is worked out", async () => {
            ask.mockResolvedValue(false);
            const ref = createRef<RoomView>();
            await mountRoomView(ref, { hideHeader: true, hideComposer: true });
            await waitFor(() => expect(ref.current!.state.showUrlPreview).toBe(true));

            // Crypto has not answered yet, and the shield would wait for the room's members for good.
            const answer = Promise.withResolvers<boolean>();
            ask.mockReturnValue(answer.promise);
            vi.spyOn(room, "getEncryptionTargetMembers").mockReturnValue(new Promise(() => {}));
            act(() => {
                const event = encryptionEvent();
                room.currentState.setStateEvents([event]);
                cli.emit(RoomStateEvent.Events, event, room.currentState, null);
            });
            expect(ref.current!.state.showUrlPreview).toBe(false);

            await act(async () => answer.resolve(true));
            expect(ref.current!.state.isRoomEncrypted).toBe(true);
            expect(ref.current!.state.showUrlPreview).toBe(false);
        });

        it("goes by the room's state when there is no crypto, keeping URL previews to the encrypted rooms' setting", async () => {
            vi.spyOn(cli, "getCrypto").mockReturnValue(undefined);
            room.currentState.setStateEvents([encryptionEvent()]);
            const ref = createRef<RoomView>();
            await mountRoomView(ref, { hideHeader: true, hideComposer: true });

            await waitFor(() => expect(ref.current!.state.isRoomEncrypted).toBe(true));
            expect(ref.current!.state.showUrlPreview).toBe(false);
        });
    });

    it("updates live timeline when a timeline reset happens", async () => {
        const roomViewInstance = await getRoomViewInstance();
        const oldTimeline = roomViewInstance.state.liveTimeline;

        act(() => room.getUnfilteredTimelineSet().resetLiveTimeline());
        expect(roomViewInstance.state.liveTimeline).not.toEqual(oldTimeline);
    });

    it("should update when the e2e status when the user verification changed", async () => {
        room.currentState.setStateEvents([
            mkRoomMemberJoinEvent(cli.getSafeUserId(), room.roomId),
            mkRoomMemberJoinEvent("user@example.com", room.roomId),
        ]);
        room.getMyMembership = vi.fn().mockReturnValue(KnownMembership.Join);
        // Not all the calls to cli.isRoomEncrypted are migrated, so we need to mock both.
        vi.mocked(cli.isRoomEncrypted).mockReturnValue(true);
        vi.spyOn(cli, "getCrypto").mockReturnValue(crypto);
        vi.spyOn(cli.getCrypto()!, "isEncryptionEnabledInRoom").mockResolvedValue(true);
        vi.spyOn(cli.getCrypto()!, "getUserVerificationStatus").mockResolvedValue(
            new UserVerificationStatus(false, false, false),
        );
        vi.spyOn(cli.getCrypto()!, "getUserDeviceInfo").mockResolvedValue(
            new Map([["user@example.com", new Map<string, any>()]]),
        );

        const { container } = await renderRoomView();
        // We no longer show the grey shield for encrypted rooms, so it should not be there.
        await waitFor(() => expect(container.querySelector(".mx_E2EIcon")).not.toBeInTheDocument());

        const verificationStatus = new UserVerificationStatus(true, true, false);
        vi.spyOn(cli.getCrypto()!, "getUserVerificationStatus").mockResolvedValue(verificationStatus);
        cli.emit(CryptoEvent.UserTrustStatusChanged, cli.getSafeUserId(), verificationStatus);
        await waitFor(() =>
            expect(container.querySelector(".mx_E2EIcon")).toHaveAccessibleName("Everyone in this room is verified"),
        );
    });

    describe("video rooms", () => {
        let startCall: MockInstance<ElementCall["start"]>;

        beforeEach(async () => {
            // These tests exercise room layout; happy-dom cannot complete the widget handshake.
            startCall = vi.spyOn(ElementCall.prototype, "start").mockResolvedValue(null);
            await setupAsyncStoreWithClient(CallStore.instance, MatrixClientPeg.safeGet());
            // Make it a video room
            room.isElementVideoRoom = () => true;
            await SettingsStore.setValue("feature_video_rooms", null, SettingLevel.DEVICE, true);
        });

        afterEach(async () => {
            cleanup();
            await resetAsyncStoreWithClient(CallStore.instance);
            startCall.mockRestore();
        });

        it("normally doesn't open the chat panel", async () => {
            vi.spyOn(NotificationState.prototype, "isUnread", "get").mockReturnValue(false);
            await mountRoomView();
            expect(stores.rightPanelStore.isOpen).toEqual(false);
        });

        it("opens the chat panel if there are unread messages", async () => {
            vi.spyOn(NotificationState.prototype, "isUnread", "get").mockReturnValue(true);
            await mountRoomView();
            expect(stores.rightPanelStore.isOpen).toEqual(true);
            expect(stores.rightPanelStore.currentCard.phase).toEqual(RightPanelPhases.Timeline);
        });

        it("should render joined video room view", async () => {
            vi.spyOn(room, "getMyMembership").mockReturnValue(KnownMembership.Join);
            const { asFragment } = await mountRoomView();
            expect(asFragment()).toMatchSnapshot();
        });

        it("should open timeline card when navigating to permalink", async () => {
            vi.spyOn(room, "getMyMembership").mockReturnValue(KnownMembership.Join);
            await mountRoomView();

            stores.rightPanelStore.setCard({ phase: RightPanelPhases.RoomSummary });

            expect(stores.rightPanelStore.isOpen).toEqual(true);
            expect(stores.rightPanelStore.currentCard.phase).not.toEqual(RightPanelPhases.Timeline);

            await stores.roomViewStore.viewRoom({
                action: Action.ViewRoom,
                room_id: stores.roomViewStore.getRoomId()!,
                event_id: "$eventId",
                metricsTrigger: undefined,
            });

            expect(stores.rightPanelStore.isOpen).toEqual(true);
            expect(stores.rightPanelStore.currentCard.phase).toEqual(RightPanelPhases.Timeline);
        });
    });

    describe("group calls", () => {
        let startCall: MockInstance<ElementCall["start"]>;

        beforeEach(async () => {
            // Widget transport lifecycle is covered by the call tests, not these room layout fixtures.
            startCall = vi.spyOn(ElementCall.prototype, "start").mockResolvedValue(null);
            await setupAsyncStoreWithClient(CallStore.instance, MatrixClientPeg.safeGet());
            vi.spyOn(room, "getMyMembership").mockReturnValue(KnownMembership.Join);
        });

        afterEach(async () => {
            cleanup();
            await resetAsyncStoreWithClient(CallStore.instance);
            startCall.mockRestore();
        });

        it("keeps the desktop conversation timeline and composer beneath its call", async () => {
            const getValue = SettingsStore.getValue.bind(SettingsStore);
            vi.spyOn(SettingsStore, "getValue").mockImplementation((name, ...args) =>
                name === "feature_desktop_shell" ? true : getValue(name, ...args),
            );
            const { container } = await mountRoomView();
            await act(() =>
                stores.roomViewStore.viewRoom({
                    action: Action.ViewRoom,
                    room_id: room.roomId,
                    view_call: true,
                    metricsTrigger: undefined,
                }),
            );
            expect(screen.getByTestId("timeline")).toBeInTheDocument();
            expect(screen.getByRole("region", { name: "Message composer" })).toBeInTheDocument();
            expect(container.querySelector(".mx_RoomView_conversationCallStage")).toBeInTheDocument();
            // The timeline is the page's one main landmark; the call above it is a region of its own.
            expect(screen.getAllByRole("main")).toEqual([screen.getByTestId("timeline")]);
            expect(screen.getByRole("region", { name: "Call" })).toBeInTheDocument();
            expect(container.querySelector(".mx_RoomView_immersive")).not.toBeInTheDocument();
            const separator = screen.getByRole("separator", { name: "Resize call area" });
            const callArea = container.querySelector<HTMLElement>(".mx_RoomView_conversationCallStage")!;
            fireEvent.keyDown(separator, { key: "ArrowDown" });
            expect(callArea.style.height).toBe("272px");
            fireEvent.keyDown(separator, { key: "ArrowUp" });
            expect(callArea.style.height).toBe("248px");
            fireEvent.keyDown(separator, { key: "ArrowUp" });
            expect(callArea.style.height).toBe("248px");
            fireEvent.keyDown(separator, { key: "End" });
            expect(Number.parseFloat(callArea.style.height)).toBeGreaterThan(248);
            fireEvent.keyDown(separator, { key: "Home" });
            expect(callArea.style.height).toBe("248px");
            fireEvent.doubleClick(separator);
            expect(callArea.style.height).toBe("40vh");
        });

        it("makes a call that fills the room the page's one main landmark", async () => {
            await mountRoomView();
            await act(() =>
                stores.roomViewStore.viewRoom({
                    action: Action.ViewRoom,
                    room_id: room.roomId,
                    view_call: true,
                    metricsTrigger: undefined,
                }),
            );

            const main = screen.getAllByRole("main");
            expect(main).toHaveLength(1);
            expect(main[0]).toHaveClass("mx_CallView");
        });

        it("hides the right panel chat when closing a call", async () => {
            await mountRoomView();

            // Open the call
            await act(() =>
                stores.roomViewStore.viewRoom({
                    action: Action.ViewRoom,
                    room_id: stores.roomViewStore.getRoomId()!,
                    event_id: "$eventId",
                    metricsTrigger: undefined,
                    view_call: true,
                }),
            );
            // Open the chat in the right panel
            act(() => stores.rightPanelStore.setCard({ phase: RightPanelPhases.Timeline }));
            // Chat should be visible in the right panel
            await findByRole(await screen.findByRole("complementary"), "heading", { name: "Chat" });

            // Close the call
            await act(() =>
                stores.roomViewStore.viewRoom({
                    action: Action.ViewRoom,
                    room_id: stores.roomViewStore.getRoomId()!,
                    event_id: "$eventId",
                    metricsTrigger: undefined,
                    view_call: false,
                }),
            );
            // Right panel should be gone
            expect(screen.queryByRole("complementary")).toBe(null);
            // Opening the right panel again should just show the room summary
            act(() => stores.rightPanelStore.show(room.roomId));
            await findByRole(await screen.findByRole("complementary"), "heading", { name: room.roomId });
        });

        it("hides the right panel chat when returning to a room that previously showed a call", async () => {
            const room2 = new Room(`!roomswitchtest:example.org`, cli, "@alice:example.org");
            rooms.set(room2.roomId, room2);
            await mountRoomView();

            // Open the call
            await act(() =>
                stores.roomViewStore.viewRoom({
                    action: Action.ViewRoom,
                    room_id: room.roomId,
                    event_id: "$eventId",
                    metricsTrigger: undefined,
                    view_call: true,
                }),
            );
            // Open the chat in the right panel
            act(() => stores.rightPanelStore.setCard({ phase: RightPanelPhases.Timeline }));
            // Chat should be visible in the right panel
            await findByRole(await screen.findByRole("complementary"), "heading", { name: "Chat" });

            // Navigate away to another room
            await act(() =>
                stores.roomViewStore.viewRoom({
                    action: Action.ViewRoom,
                    room_id: room2.roomId,
                    event_id: "$eventId",
                    metricsTrigger: undefined,
                }),
            );
            // Navigate back to the original room
            await act(() =>
                stores.roomViewStore.viewRoom({
                    action: Action.ViewRoom,
                    room_id: room.roomId,
                    event_id: "$eventId",
                    metricsTrigger: undefined,
                }),
            );
            // Right panel should be gone
            expect(screen.queryByRole("complementary")).toBe(null);
        });
    });

    describe("for a local room", () => {
        let localRoom: LocalRoom;

        beforeEach(async () => {
            localRoom = room = await createDmLocalRoom(cli, [new DirectoryMember({ user_id: "@user:example.com" })]);
            rooms.set(localRoom.roomId, localRoom);
            cli.store.storeRoom(room);
        });

        it("should remove the room from the store on unmount", async () => {
            const { unmount } = await renderRoomView();
            unmount();
            expect(cli.store.removeRoom).toHaveBeenCalledWith(room.roomId);
        });

        describe("in state NEW", () => {
            it("should match the snapshot", async () => {
                const { container } = await renderRoomView();
                expect(container).toMatchSnapshot();
            });

            describe("that is encrypted", () => {
                beforeEach(() => {
                    // Not all the calls to cli.isRoomEncrypted are migrated, so we need to mock both.
                    vi.mocked(cli.isRoomEncrypted).mockReturnValue(true);
                    vi.spyOn(cli, "getCrypto").mockReturnValue(crypto);
                    vi.spyOn(cli.getCrypto()!, "isEncryptionEnabledInRoom").mockResolvedValue(true);
                    vi.spyOn(cli.getCrypto()!, "getUserVerificationStatus").mockResolvedValue(
                        new UserVerificationStatus(false, false, false),
                    );
                    localRoom.encrypted = true;
                    localRoom.currentState.setStateEvents([
                        new MatrixEvent({
                            event_id: `~${localRoom.roomId}:${cli.makeTxnId()}`,
                            type: EventType.RoomEncryption,
                            content: {
                                algorithm: MEGOLM_ENCRYPTION_ALGORITHM,
                            },
                            sender: cli.getUserId()!,
                            state_key: "",
                            room_id: localRoom.roomId,
                            origin_server_ts: Date.now(),
                        }),
                    ]);
                });

                it("should match the snapshot", async () => {
                    const { container } = await renderRoomView();
                    // Once the room's trust shield is worked out: a snapshot taken in a retried waitFor would only be
                    // written anew.
                    await waitFor(() => expect(screen.queryByTestId("e2e-icon")).not.toBeInTheDocument());
                    expect(container).toMatchSnapshot();
                });
            });
        });

        it("in state CREATING should match the snapshot", async () => {
            localRoom.state = LocalRoomState.CREATING;
            const { container } = await renderRoomView();
            expect(container).toMatchSnapshot();
        });

        describe("in state ERROR", () => {
            beforeEach(async () => {
                localRoom.state = LocalRoomState.ERROR;
            });

            it("should match the snapshot", async () => {
                const { container } = await renderRoomView();
                expect(container).toMatchSnapshot();
            });

            it("clicking retry should set the room state to new dispatch a local room event", async () => {
                vi.spyOn(defaultDispatcher, "dispatch");
                const { getByText } = await renderRoomView();
                fireEvent.click(getByText("Retry"));
                expect(localRoom.state).toBe(LocalRoomState.NEW);
                expect(defaultDispatcher.dispatch).toHaveBeenCalledWith({
                    action: "local_room_event",
                    roomId: room.roomId,
                });
            });
        });
    });

    describe("when rendering a DM room with a single third-party invite", () => {
        beforeEach(async () => {
            room.currentState.setStateEvents([
                mkRoomMemberJoinEvent(cli.getSafeUserId(), room.roomId),
                mkThirdPartyInviteEvent(cli.getSafeUserId(), "user@example.com", room.roomId),
            ]);
            vi.spyOn(DMRoomMap.shared(), "getUserIdForRoomId").mockReturnValue(cli.getSafeUserId());
            vi.spyOn(DMRoomMap.shared(), "getRoomIds").mockReturnValue(new Set([room.roomId]));
            vi.spyOn(cli, "getCrypto").mockReturnValue(crypto);
            vi.spyOn(cli.getCrypto()!, "isEncryptionEnabledInRoom").mockResolvedValue(true);
            await renderRoomView();
        });

        it("should render the »waiting for third-party« view", () => {
            expect(screen.getByText("Waiting for users to join Element")).toBeInTheDocument();
            expect(
                screen.getByText(
                    "Once invited users have joined Element, you will be able to chat and the room will be end-to-end encrypted",
                ),
            ).toBeInTheDocument();

            // no message composer
            expect(screen.queryByText("Send a message…")).not.toBeInTheDocument();
            expect(screen.queryByText("Send an unencrypted message…")).not.toBeInTheDocument();
        });
    });

    it("should show error view if failed to look up room alias", async () => {
        const { asFragment, findByText } = await renderRoomView(false);

        act(() =>
            defaultDispatcher.dispatch<ViewRoomErrorPayload>({
                action: Action.ViewRoomError,
                room_alias: "#addy:server",
                room_id: null,
                err: new MatrixError({ errcode: "M_NOT_FOUND" }),
            }),
        );
        await emitPromise(stores.roomViewStore, UPDATE_EVENT);

        await findByText("Are you sure you're at the right place?");
        expect(asFragment()).toMatchSnapshot();
    });

    describe("rooms the client does not know about", () => {
        beforeEach(() => {
            // All we know about the room is what its summary tells us
            rooms.delete(room.roomId);
        });

        describe("while sliding sync looks for the room", () => {
            beforeEach(() => {
                cli.clientRunning = true;
                cli.getRoomSummary.mockResolvedValue({
                    room_id: room.roomId,
                    join_rule: JoinRule.Public,
                    membership: KnownMembership.Leave,
                    world_readable: false,
                    guest_can_join: false,
                    num_joined_members: 3,
                });
            });

            it("asks for no summary of a room sliding sync then finds, such as one restored from this device", async () => {
                const loading = vi.spyOn(stores.roomViewStore, "isRoomLoading").mockReturnValue(true);
                await mountRoomView();
                await flushPromises();
                expect(cli.getRoomSummary).not.toHaveBeenCalled();
                // The saved room is restored, joined.
                vi.spyOn(room, "getMyMembership").mockReturnValue(KnownMembership.Join);
                rooms.set(room.roomId, room);
                loading.mockReturnValue(false);
                await act(async () => {
                    stores.roomViewStore.emit(UPDATE_EVENT);
                });
                await flushPromises();
                expect(cli.getRoomSummary).not.toHaveBeenCalled();
            });

            it("asks for the summary once sliding sync stops looking without finding the room", async () => {
                const loading = vi.spyOn(stores.roomViewStore, "isRoomLoading").mockReturnValue(true);
                await mountRoomView();
                await flushPromises();
                expect(cli.getRoomSummary).not.toHaveBeenCalled();
                loading.mockReturnValue(false);
                await act(async () => {
                    stores.roomViewStore.emit(UPDATE_EVENT);
                });
                await waitFor(() => expect(cli.getRoomSummary).toHaveBeenCalledWith(room.roomId, expect.anything()));
            });
        });

        describe("public Space previews", () => {
            beforeEach(() => {
                cli.clientRunning = true;
                cli.isInitialSyncComplete.mockReturnValue(false);
                cli.getRoomSummary.mockResolvedValue({
                    room_id: room.roomId,
                    room_type: RoomType.Space,
                    join_rule: JoinRule.Public,
                    membership: KnownMembership.Leave,
                    world_readable: true,
                    guest_can_join: true,
                    num_joined_members: 10000,
                });
                vi.spyOn(cli, "getRoomHierarchy").mockResolvedValue({
                    rooms: [
                        {
                            room_id: room.roomId,
                            room_type: RoomType.Space,
                            name: "Public community",
                            children_state: [
                                {
                                    type: EventType.SpaceChild,
                                    state_key: "!public-child:example.org",
                                    content: { via: ["example.org"] },
                                    sender: "@alice:example.org",
                                    origin_server_ts: 1,
                                },
                            ],
                            world_readable: true,
                            guest_can_join: true,
                            num_joined_members: 10000,
                            join_rule: JoinRule.Public,
                        },
                        {
                            room_id: "!public-child:example.org",
                            name: "Public text channel",
                            children_state: [],
                            world_readable: true,
                            guest_can_join: true,
                            num_joined_members: 10000,
                            join_rule: JoinRule.Public,
                        },
                    ],
                });
            });

            it("prefetches and browses a public hierarchy before Join without storing a joined room", async () => {
                const instance = await getRoomViewInstance();
                expect(await screen.findByText("Public text channel")).toBeInTheDocument();
                // The hierarchy styles and scrolling depend on the same layout as the joined Space overview.
                const overview = screen.getByRole("main");
                expect(overview).toHaveClass("mx_SpaceRoomView");
                expect(screen.getByRole("tree").closest(".mx_SpaceRoomView_landing")).toBe(
                    overview.querySelector(".mx_MainSplit > .mx_SpaceRoomView_landing"),
                );
                expect(screen.getByRole("button", { name: "Join the discussion" })).toBeInTheDocument();
                // Hierarchy Join errors must reach this room's store before the normal room view exists.
                const preview = instance.render() as ReactElement<{ roomViewStore: typeof stores.roomViewStore }>;
                expect(preview.type).toBe(ScopedRoomContextProvider);
                expect(preview.props.roomViewStore).toBe(stores.roomViewStore);
                expect(cli.getRoomHierarchy).toHaveBeenCalledTimes(1);
                expect(cli.joinRoom).not.toHaveBeenCalled();
                expect(cli.getRoom(room.roomId)).toBeNull();
                expect(instance.state.room).toBeUndefined();
                expect(instance.state.previewSpace?.getMyMembership()).not.toBe(KnownMembership.Join);
                expect(instance.state.matrixClientIsReady).toBe(false);
                expect(cli.peekInRoom).not.toHaveBeenCalled();
                expect(screen.queryByRole("textbox", { name: "Message" })).not.toBeInTheDocument();
            });

            it("keeps browsing after HTTP join acknowledgement while canonical membership is pending", async () => {
                const instance = await getRoomViewInstance();
                await screen.findByText("Public text channel");
                await act(async () => {
                    await instance["onAction"]({
                        action: Action.JoinRoomReady,
                        roomId: "!another:example.org",
                    });
                });
                expect(screen.getByRole("button", { name: "Join the discussion" })).toBeInTheDocument();
                await act(async () => {
                    await instance["onAction"]({ action: Action.JoinRoomReady, roomId: room.roomId });
                });
                expect(screen.queryByRole("button", { name: "Join the discussion" })).not.toBeInTheDocument();
                expect(screen.getByText("Public text channel")).toBeInTheDocument();
                expect(cli.getRoom(room.roomId)).toBeNull();
                expect(instance.state.room).toBeUndefined();
                expect(instance.state.matrixClientIsReady).toBe(false);
                expect(document.querySelector(".mx_RoomView_messagePanel")).toBeNull();
            });

            it("retains the Join prompt and hierarchy when the join request fails", async () => {
                const instance = await getRoomViewInstance();
                await screen.findByText("Public text channel");
                await act(async () => {
                    await instance["onAction"]({
                        action: Action.JoinRoomError,
                        roomId: room.roomId,
                        err: new MatrixError({ errcode: "M_FORBIDDEN", error: "Join refused" }),
                    });
                });
                expect(screen.getByRole("button", { name: "Join the discussion" })).toBeInTheDocument();
                expect(screen.getByText("Public text channel")).toBeInTheDocument();
                expect(instance.state.previewSpaceJoinAcknowledged).toBeUndefined();
                expect(cli.getRoom(room.roomId)).toBeNull();
            });

            it("starts the hierarchy alongside an unresolved summary and ignores both after unmount", async () => {
                const pending = Promise.withResolvers<Awaited<ReturnType<MatrixClient["getRoomSummary"]>>>();
                cli.getRoomSummary.mockReturnValue(pending.promise);
                const view = await mountRoomView();
                view.unmount();
                pending.resolve({
                    room_id: room.roomId,
                    room_type: RoomType.Space,
                    join_rule: JoinRule.Public,
                    membership: KnownMembership.Leave,
                    world_readable: true,
                    guest_can_join: true,
                    num_joined_members: 10000,
                });
                await flushPromises();
                expect(cli.getRoomHierarchy).toHaveBeenCalledOnce();
                expect(cli.getRoom(room.roomId)).toBeNull();
            });

            it("shows the overview from a hierarchy that resolves before the summary", async () => {
                const pending = Promise.withResolvers<Awaited<ReturnType<MatrixClient["getRoomSummary"]>>>();
                cli.getRoomSummary.mockReturnValue(pending.promise);
                const instance = await getRoomViewInstance();
                await flushPromises();
                expect(cli.getRoomHierarchy).toHaveBeenCalledOnce();
                // The overview is already loaded, so the summary only has to confirm the room type.
                pending.resolve({
                    room_id: room.roomId,
                    room_type: RoomType.Space,
                    join_rule: JoinRule.Public,
                    membership: KnownMembership.Leave,
                    world_readable: true,
                    guest_can_join: true,
                    num_joined_members: 10000,
                });
                expect(await screen.findByText("Public text channel")).toBeInTheDocument();
                expect(cli.getRoomHierarchy).toHaveBeenCalledOnce();
                expect(instance.state.previewSpace?.roomId).toBe(room.roomId);
            });

            it("opens a listed public child as a Join prompt before its summary arrives", async () => {
                const instance = await getRoomViewInstance();
                await screen.findByText("Public text channel");
                const childId = "!public-child:example.org";
                const childSummary = Promise.withResolvers<Awaited<ReturnType<MatrixClient["getRoomSummary"]>>>();
                cli.getRoomSummary.mockReturnValue(childSummary.promise);
                vi.spyOn(stores.roomViewStore, "getRoomId").mockReturnValue(childId);
                // The child summary never resolves here: the prompt must not depend on it. React has not yet
                // applied the new room ID when the seeded prompt is shown.
                await act(async () => {
                    instance.setState({ roomId: childId, previewSpace: undefined, roomSummary: undefined });
                    void instance["setupRoom"](undefined, childId, true);
                    await flushPromises();
                });
                expect(instance.state.roomSummary).toMatchObject({ room_id: childId, name: "Public text channel" });
                expect(instance.state.peekAndSummaryLoading).toBe(false);
                expect(stores.roomViewStore.getRoomSummary()?.join_rule).toBe(JoinRule.Public);
                expect(cli.peekInRoom).not.toHaveBeenCalled();
                // A child that is not a Space does not start another hierarchy request.
                expect(cli.getRoomHierarchy).toHaveBeenCalledOnce();
                childSummary.resolve({
                    room_id: childId,
                    join_rule: JoinRule.Public,
                    membership: KnownMembership.Leave,
                    world_readable: false,
                    guest_can_join: false,
                    num_joined_members: 10000,
                    encryption: "m.megolm.v1.aes-sha2",
                });
                await act(flushPromises);
                expect(instance.state.roomSummary?.encryption).toBe("m.megolm.v1.aes-sha2");
            });

            it("does not show a restricted Space hierarchy from its summary", async () => {
                cli.getRoomSummary.mockResolvedValue({
                    room_id: room.roomId,
                    room_type: RoomType.Space,
                    join_rule: JoinRule.Restricted,
                    membership: KnownMembership.Leave,
                    world_readable: false,
                    guest_can_join: false,
                    num_joined_members: 10000,
                });
                const instance = await getRoomViewInstance();
                expect(instance.state.previewSpace).toBeUndefined();
            });
        });

        it("resolves an alias and offers Join from its summary while initial sync is stalled", async () => {
            cli.clientRunning = true;
            cli.isInitialSyncComplete.mockReturnValue(false);
            const alias = `#${room.roomId.slice(1)}`;
            cli.getRoomIdForAlias.mockResolvedValue({ room_id: room.roomId, servers: ["example.org"] });
            cli.getRoomSummary.mockResolvedValue({
                room_id: room.roomId,
                membership: KnownMembership.Leave,
                world_readable: true,
                guest_can_join: true,
                num_joined_members: 10000,
            });
            await stores.roomViewStore.viewRoom({
                action: Action.ViewRoom,
                room_alias: alias,
                metricsTrigger: undefined,
            });
            await flushPromises();
            const instance = await getRoomViewInstance();
            expect(cli.getRoomIdForAlias).toHaveBeenCalledWith(alias);
            // The summary was requested by alias alongside the lookup, so no second request is made by ID.
            expect(cli.getRoomSummary).toHaveBeenCalledExactlyOnceWith(alias, undefined);
            expect(screen.getByRole("button", { name: "Join the discussion" })).toBeInTheDocument();
            expect(cli.peekInRoom).not.toHaveBeenCalled();
            expect(instance.state.matrixClientIsReady).toBe(false);
            expect(cli.isInitialSyncComplete()).toBe(false);
        });

        it("fetches the summary by ID when the alias summary describes another room", async () => {
            cli.clientRunning = true;
            const alias = `#moved-${room.roomId.slice(1)}`;
            cli.getRoomIdForAlias.mockResolvedValue({ room_id: room.roomId, servers: ["example.org"] });
            cli.getRoomSummary.mockImplementation(async (address) => ({
                room_id: address === alias ? "!previous:example.org" : room.roomId,
                membership: KnownMembership.Leave,
                world_readable: false,
                guest_can_join: false,
                num_joined_members: 10,
            }));
            await stores.roomViewStore.viewRoom({
                action: Action.ViewRoom,
                room_alias: alias,
                metricsTrigger: undefined,
            });
            await flushPromises();
            const instance = await getRoomViewInstance();
            await act(flushPromises);
            expect(cli.getRoomSummary).toHaveBeenNthCalledWith(2, room.roomId, ["example.org"]);
            expect(instance.state.roomSummary?.room_id).toBe(room.roomId);
        });

        it("keeps a joined summary loading until its joined room becomes ready", async () => {
            cli.clientRunning = true;
            cli.isInitialSyncComplete.mockReturnValue(false);
            cli.getRoomSummary.mockResolvedValue({
                room_id: room.roomId,
                membership: KnownMembership.Join,
                world_readable: true,
                guest_can_join: true,
                num_joined_members: 10000,
            });
            const instance = await getRoomViewInstance();
            expect(cli.getRoomSummary).toHaveBeenCalledWith(room.roomId, []);
            expect(screen.queryByRole("button", { name: "Join the discussion" })).not.toBeInTheDocument();
            expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
            expect(cli.peekInRoom).not.toHaveBeenCalled();
            expect(instance.state.matrixClientIsReady).toBe(false);
        });

        it("peeks into a world readable room", async () => {
            cli.getRoomSummary.mockResolvedValue({
                room_id: room.roomId,
                world_readable: true,
                guest_can_join: true,
                num_joined_members: 1,
            });
            cli.peekInRoom.mockResolvedValue(room);

            const instance = await getRoomViewInstance();

            expect(cli.peekInRoom).toHaveBeenCalledWith(room.roomId);
            expect(instance.state.room).toBe(room);
            expect(instance.state.isPeeking).toBe(true);
            expect(instance.state.peekAndSummaryLoading).toBe(false);
        });

        it("keeps Join interactive while optional public history is pending and after it fails", async () => {
            const pending = Promise.withResolvers<Room>();
            cli.getRoomSummary.mockResolvedValue({
                room_id: room.roomId,
                membership: KnownMembership.Leave,
                world_readable: true,
                guest_can_join: true,
                num_joined_members: 10000,
            });
            cli.peekInRoom.mockReturnValue(pending.promise);
            const instance = await getRoomViewInstance();
            expect(cli.peekInRoom).toHaveBeenCalledWith(room.roomId);
            expect(instance.state.isPeeking).toBe(true);
            expect(instance.state.peekAndSummaryLoading).toBe(false);
            expect(screen.getByRole("button", { name: "Join the discussion" })).toBeEnabled();
            expect(document.querySelector(".mx_RoomView_messagePanel")).toBeNull();
            expect(screen.queryByRole("textbox")).not.toBeInTheDocument();

            const dispatch = vi.spyOn(defaultDispatcher, "dispatch").mockImplementation(() => {});
            try {
                await act(async () => {
                    fireEvent.click(screen.getByRole("button", { name: "Join the discussion" }));
                });
                expect(dispatch).toHaveBeenCalledWith(
                    expect.objectContaining({ action: Action.JoinRoom, roomId: room.roomId }),
                );
            } finally {
                dispatch.mockRestore();
            }

            await act(async () => {
                pending.reject(new MatrixError({ errcode: "M_FORBIDDEN" }));
            });
            expect(instance.state.isPeeking).toBe(false);
            expect(screen.getByRole("button", { name: "Join the discussion" })).toBeEnabled();
            expect(instance.state.room).toBeUndefined();
            expect(cli.getRoom(room.roomId)).toBeNull();
        });

        it("keeps an already joined summary loading while its room preview is pending", async () => {
            cli.getRoomSummary.mockResolvedValue({
                room_id: room.roomId,
                membership: KnownMembership.Join,
                world_readable: true,
                guest_can_join: true,
                num_joined_members: 10000,
            });
            cli.peekInRoom.mockReturnValue(new Promise(() => {}));
            const instance = await getRoomViewInstance();
            expect(instance.state.peekAndSummaryLoading).toBe(true);
            expect(screen.queryByRole("button", { name: "Join the discussion" })).not.toBeInTheDocument();
            expect(document.querySelector(".mx_RoomView_messagePanel")).toBeNull();
        });

        it("keeps the early Join prompt available when account readiness starts optional history", async () => {
            cli.clientRunning = true;
            cli.isInitialSyncComplete.mockReturnValue(false);
            cli.getRoomSummary.mockResolvedValue({
                room_id: room.roomId,
                membership: KnownMembership.Leave,
                world_readable: true,
                guest_can_join: true,
                num_joined_members: 10000,
            });
            cli.peekInRoom.mockReturnValue(new Promise(() => {}));
            const instance = await getRoomViewInstance();
            expect(screen.getByRole("button", { name: "Join the discussion" })).toBeEnabled();
            expect(cli.peekInRoom).not.toHaveBeenCalled();
            cli.isInitialSyncComplete.mockReturnValue(true);
            await act(async () => {
                await instance["onAction"]({ action: "MatrixActions.sync" });
            });
            expect(cli.peekInRoom).toHaveBeenCalledWith(room.roomId);
            expect(screen.getByRole("button", { name: "Join the discussion" })).toBeEnabled();
            expect(document.querySelector(".mx_RoomView_messagePanel")).toBeNull();
        });

        it("shows the join prompt when peeking fails", async () => {
            cli.getRoomSummary.mockResolvedValue({
                room_id: room.roomId,
                world_readable: true,
                guest_can_join: true,
                num_joined_members: 1,
            });
            cli.peekInRoom.mockRejectedValue(new MatrixError({ errcode: "M_FORBIDDEN" }));

            const instance = await getRoomViewInstance();

            expect(screen.getByRole("button", { name: "Join the discussion" })).toBeInTheDocument();
            expect(instance.state.isPeeking).toBe(false);
        });

        it("does not peek into a room which is not world readable and hands the summary to the store", async () => {
            const summary = {
                room_id: room.roomId,
                membership: KnownMembership.Leave,
                world_readable: false,
                guest_can_join: false,
                num_joined_members: 1,
            };
            cli.getRoomSummary.mockResolvedValue(summary);

            await mountRoomView();

            expect(cli.peekInRoom).not.toHaveBeenCalled();
            expect(screen.getByRole("button", { name: "Join the discussion" })).toBeInTheDocument();
            expect(stores.roomViewStore.getRoomSummary()).toEqual(summary);
        });

        it("peeks into a room we have already joined", async () => {
            cli.getRoomSummary.mockResolvedValue({
                room_id: room.roomId,
                membership: KnownMembership.Join,
                world_readable: false,
                guest_can_join: false,
                num_joined_members: 1,
            });
            cli.peekInRoom.mockResolvedValue(room);

            const instance = await getRoomViewInstance();

            expect(cli.peekInRoom).toHaveBeenCalledWith(room.roomId);
            expect(instance.state.room).toBe(room);
            expect(instance.state.peekAndSummaryLoading).toBe(false);
        });
    });

    describe("knock rooms", () => {
        const client = createTestClient();

        beforeEach(() => {
            vi.spyOn(SettingsStore, "getValue").mockImplementation((setting) => setting === "feature_ask_to_join");
            vi.spyOn(room, "getJoinRule").mockReturnValue(JoinRule.Knock);
            vi.spyOn(defaultDispatcher, "dispatch");
        });

        it("allows to request to join", async () => {
            vi.spyOn(MatrixClientPeg, "safeGet").mockReturnValue(client);
            vi.spyOn(client, "knockRoom").mockResolvedValue({ room_id: room.roomId });

            await mountRoomView();
            fireEvent.click(screen.getByRole("button", { name: "Request to join" }));
            await untilDispatch(Action.SubmitAskToJoin, defaultDispatcher);

            expect(defaultDispatcher.dispatch).toHaveBeenCalledWith({
                action: "submit_ask_to_join",
                roomId: room.roomId,
                opts: { reason: undefined },
            });
        });

        it("allows to request to join a room we don't know about yet", async () => {
            rooms.delete(room.roomId);
            cli.getRoomSummary.mockResolvedValue({
                room_id: room.roomId,
                join_rule: JoinRule.Knock,
                world_readable: false,
                guest_can_join: false,
                num_joined_members: 1,
            });

            await mountRoomView();

            expect(screen.getByRole("heading", { name: "Ask to join?" })).toBeInTheDocument();
            expect(cli.peekInRoom).not.toHaveBeenCalled();
        });

        it("shows the join prompt when the room summary cannot be fetched", async () => {
            rooms.delete(room.roomId);
            cli.getRoomSummary.mockRejectedValue(new MatrixError({ errcode: "M_NOT_FOUND" }));

            await mountRoomView();

            expect(screen.getByRole("button", { name: "Join the discussion" })).toBeInTheDocument();
        });

        it("allows to cancel a join request", async () => {
            vi.spyOn(MatrixClientPeg, "safeGet").mockReturnValue(client);
            vi.spyOn(client, "leave").mockResolvedValue({});
            vi.spyOn(room, "getMyMembership").mockReturnValue(KnownMembership.Knock);

            await mountRoomView();
            fireEvent.click(screen.getByRole("button", { name: "Cancel request" }));
            await untilDispatch(Action.CancelAskToJoin, defaultDispatcher);

            expect(defaultDispatcher.dispatch).toHaveBeenCalledWith({
                action: "cancel_ask_to_join",
                roomId: room.roomId,
            });
        });
    });

    describe("message search", () => {
        const stubElementHover = (el: Element): (() => void) => {
            const original = HTMLElement.prototype.matches;
            const spy = vi.spyOn(HTMLElement.prototype, "matches").mockImplementation(function (
                this: HTMLElement,
                selector: string,
            ) {
                if (selector === ":hover") return this === el;
                return original.call(this, selector);
            });
            return () => spy.mockRestore();
        };

        it("should close search results when edit is clicked", async () => {
            room.getMyMembership = vi.fn().mockReturnValue(KnownMembership.Join);

            const eventMapper = (obj: Partial<IEvent>) => new MatrixEvent(obj);

            const roomViewRef = createRef<RoomView>();
            const { container, getByText, findByLabelText } = await mountRoomView(roomViewRef);
            await waitFor(() => expect(roomViewRef.current).toBeTruthy());
            // @ts-ignore - triggering a search organically is a lot of work
            act(() =>
                roomViewRef.current!.setState({
                    search: {
                        searchId: 1,
                        roomId: room.roomId,
                        term: "search term",
                        scope: SearchScope.Room,
                        promise: Promise.resolve({
                            results: [
                                SearchResult.fromJson(
                                    {
                                        rank: 1,
                                        result: {
                                            content: {
                                                body: "search term",
                                                msgtype: "m.text",
                                            },
                                            type: "m.room.message",
                                            event_id: "$eventId",
                                            sender: cli.getSafeUserId(),
                                            origin_server_ts: 123456789,
                                            room_id: room.roomId,
                                        },
                                        context: {
                                            events_before: [],
                                            events_after: [],
                                            profile_info: {},
                                        },
                                    },
                                    eventMapper,
                                ),
                            ],
                            highlights: [],
                            count: 1,
                        }),
                        inProgress: false,
                        count: 1,
                    },
                }),
            );

            await waitFor(() => {
                expect(container.querySelector(".mx_RoomView_searchResultsPanel")).toBeVisible();
            });

            const searchResultTile = getByText("search term").closest(".mx_EventTile");
            expect(searchResultTile).not.toBeNull();

            const unhover = stubElementHover(searchResultTile!);
            await userEvent.hover(searchResultTile!);
            await userEvent.click(await findByLabelText("Edit"), { skipHover: true });
            unhover();

            await waitFor(() => {
                expect(container.querySelector(".mx_RoomView_searchResultsPanel")).not.toBeInTheDocument();
            });
        });

        it("should switch rooms when edit is clicked on a search result for a different room", async () => {
            const room2 = new Room(`!roomswitchtest:example.org`, cli, "@alice:example.org");
            rooms.set(room2.roomId, room2);

            room.getMyMembership = vi.fn().mockReturnValue(KnownMembership.Join);

            const eventMapper = (obj: Partial<IEvent>) => new MatrixEvent(obj);

            const roomViewRef = createRef<RoomView>();
            const { container, getByText, findByLabelText } = await mountRoomView(roomViewRef);
            await waitFor(() => expect(roomViewRef.current).toBeTruthy());
            // @ts-ignore - triggering a search organically is a lot of work
            act(() =>
                roomViewRef.current!.setState({
                    search: {
                        searchId: 1,
                        roomId: room.roomId,
                        term: "search term",
                        scope: SearchScope.All,
                        promise: Promise.resolve({
                            results: [
                                SearchResult.fromJson(
                                    {
                                        rank: 1,
                                        result: {
                                            content: {
                                                body: "search term",
                                                msgtype: "m.text",
                                            },
                                            type: "m.room.message",
                                            event_id: "$eventId",
                                            sender: cli.getSafeUserId(),
                                            origin_server_ts: 123456789,
                                            room_id: room2.roomId,
                                        },
                                        context: {
                                            events_before: [],
                                            events_after: [],
                                            profile_info: {},
                                        },
                                    },
                                    eventMapper,
                                ),
                            ],
                            highlights: [],
                            count: 1,
                        }),
                        inProgress: false,
                        count: 1,
                    },
                }),
            );

            await waitFor(() => {
                expect(container.querySelector(".mx_RoomView_searchResultsPanel")).toBeVisible();
            });
            const prom = untilDispatch(Action.ViewRoom, defaultDispatcher);

            const searchResultTile = getByText("search term").closest(".mx_EventTile");
            expect(searchResultTile).not.toBeNull();

            const unhover = stubElementHover(searchResultTile!);
            await userEvent.hover(searchResultTile!);
            await userEvent.click(await findByLabelText("Edit"), { skipHover: true });
            unhover();

            await expect(prom).resolves.toEqual(expect.objectContaining({ room_id: room2.roomId }));
        });

        it("should pre-fill search field on FocusMessageSearch dispatch", async () => {
            room.getMyMembership = vi.fn().mockReturnValue(KnownMembership.Join);

            const roomViewRef = createRef<RoomView>();
            const { findByPlaceholderText } = await mountRoomView(roomViewRef);
            await waitFor(() => expect(roomViewRef.current).toBeTruthy());

            act(() =>
                defaultDispatcher.dispatch({
                    action: Action.FocusMessageSearch,
                    initialText: "search term",
                }),
            );

            await expect(findByPlaceholderText("Search messages…")).resolves.toHaveValue("search term");
        });
    });

    // Regression test for https://github.com/element-hq/element-web/issues/29072
    it("does not force a reload on sync unless the client is coming back online", async () => {
        cli.isInitialSyncComplete.mockReturnValue(false);

        const instance = await getRoomViewInstance();
        const onRoomViewUpdateMock = vi.fn();
        (instance as any).onRoomViewStoreUpdate = onRoomViewUpdateMock;

        act(() => {
            // As if a connectivity check happened (we are still offline)
            defaultDispatcher.dispatch({ action: "MatrixActions.sync" }, true);
            // ...so it still should not force a reload
            expect(onRoomViewUpdateMock).not.toHaveBeenCalledWith(true);
        });

        act(() => {
            // set us to online again
            cli.isInitialSyncComplete.mockReturnValue(true);
            defaultDispatcher.dispatch({ action: "MatrixActions.sync" }, true);
        });

        // It should now force a reload
        expect(onRoomViewUpdateMock).toHaveBeenCalledWith(true);
    });

    describe("handles Action.ComposerInsert", () => {
        it("redispatches an empty composerType with the current state", async () => {
            await mountRoomView();
            const promise = untilDispatch((payload) => {
                try {
                    expect(payload).toEqual({
                        action: Action.ComposerInsert,
                        text: "Hello world",
                        timelineRenderingType: TimelineRenderingType.Room,
                        composerType: ComposerType.Send,
                    });
                } catch {
                    return false;
                }
                return true;
            }, defaultDispatcher);
            defaultDispatcher.dispatch({
                action: Action.ComposerInsert,
                text: "Hello world",
                timelineRenderingType: TimelineRenderingType.Room,
            } satisfies ComposerInsertPayload);
            await promise;
        });
        it("ignores payloads with a timelineRenderingType != TimelineRenderingType.Thread", async () => {
            await mountRoomView();
            const promise = untilDispatch(
                (payload) => {
                    try {
                        expect(payload).toStrictEqual({
                            action: Action.ComposerInsert,
                            text: "Hello world",
                            timelineRenderingType: TimelineRenderingType.Thread,
                            composerType: ComposerType.Send,
                        });
                    } catch {
                        return false;
                    }
                    return true;
                },
                defaultDispatcher,
                500,
            );
            defaultDispatcher.dispatch({
                action: Action.ComposerInsert,
                text: "Hello world",
                composerType: ComposerType.Send,
                timelineRenderingType: TimelineRenderingType.Room,
                viaTest: true,
            } satisfies ComposerInsertPayload);
            await expect(promise).rejects.toThrow();
        });
    });

    it("should handle Action.ViewUser", async () => {
        await mountRoomView();
        vi.spyOn(stores.rightPanelStore, "setCards");
        const member = new User("@user:server");
        defaultDispatcher.dispatch(
            {
                action: Action.ViewUser,
                member,
            },
            true,
        );
        expect(stores.rightPanelStore.setCards).toHaveBeenCalledWith([
            { phase: RightPanelPhases.RoomSummary },
            { phase: RightPanelPhases.MemberList },
            { phase: RightPanelPhases.MemberInfo, state: { member } },
        ]);
    });

    it("should handle Action.ViewUser with push", async () => {
        await mountRoomView();
        vi.spyOn(stores.rightPanelStore, "pushCard");
        const member = new User("@user:server");
        defaultDispatcher.dispatch(
            {
                action: Action.ViewUser,
                member,
                push: true,
            },
            true,
        );
        expect(stores.rightPanelStore.pushCard).toHaveBeenCalledWith({
            phase: RightPanelPhases.MemberInfo,
            state: { member },
        });
    });

    it("leaves a person to the desktop profile card instead of the right panel when the desktop shell is on", async () => {
        const getValue = SettingsStore.getValue.bind(SettingsStore);
        vi.spyOn(SettingsStore, "getValue").mockImplementation((name, ...args) =>
            name === "feature_desktop_shell" ? true : getValue(name, ...args),
        );
        await mountRoomView();
        vi.spyOn(stores.rightPanelStore, "setCards");
        vi.spyOn(stores.rightPanelStore, "pushCard");
        vi.spyOn(stores.rightPanelStore, "showOrHidePhase");
        const member = new User("@user:server");
        defaultDispatcher.dispatch({ action: Action.ViewUser, member }, true);
        defaultDispatcher.dispatch({ action: Action.ViewUser, member, push: true }, true);
        expect(stores.rightPanelStore.setCards).not.toHaveBeenCalled();
        expect(stores.rightPanelStore.pushCard).not.toHaveBeenCalled();
        // Toggling the member list is still the right panel's job.
        defaultDispatcher.dispatch({ action: Action.ViewUser }, true);
        expect(stores.rightPanelStore.showOrHidePhase).toHaveBeenCalledWith(RightPanelPhases.MemberList);
    });

    it("should handle Action.View3pidInvite", async () => {
        await mountRoomView();
        vi.spyOn(stores.rightPanelStore, "showOrHidePhase");
        defaultDispatcher.dispatch(
            {
                action: Action.View3pidInvite,
            },
            true,
        );
        expect(stores.rightPanelStore.showOrHidePhase).toHaveBeenCalledWith("MemberList");
    });

    describe("when there is a RoomView", () => {
        const widget1Id = "widget1";
        const widget2Id = "widget2";
        const otherUserId = "@other:example.com";

        const addJitsiWidget = async (id: string, user: string, ts?: number): Promise<void> => {
            const widgetEvent = mkEvent({
                event: true,
                room: room.roomId,
                user,
                type: "im.vector.modular.widgets",
                content: {
                    id,
                    name: "Jitsi",
                    type: WidgetType.JITSI.preferred,
                    url: "https://example.com",
                },
                skey: id,
                ts,
            });
            await room.addLiveEvents([widgetEvent], { addToState: false });
            room.currentState.setStateEvents([widgetEvent]);
            cli.emit(RoomStateEvent.Events, widgetEvent, room.currentState, null);
            await flushPromises();
        };

        beforeEach(async () => {
            vi.spyOn(WidgetUtils, "setRoomWidget");
            const widgetStore = WidgetStore.instance;
            await setupAsyncStoreWithClient(widgetStore, cli);
            await getRoomViewInstance();
        });

        const itShouldNotRemoveTheLastWidget = (): void => {
            it("should not remove the last widget", (): void => {
                expect(WidgetUtils.setRoomWidget).not.toHaveBeenCalledWith(room.roomId, widget2Id);
            });
        };

        describe("and there is a Jitsi widget from another user", () => {
            beforeEach(async () => {
                await addJitsiWidget(widget1Id, otherUserId, 10_000);
            });

            describe("and the current user adds a Jitsi widget after 10s", () => {
                beforeEach(async () => {
                    await addJitsiWidget(widget2Id, cli.getSafeUserId(), 20_000);
                });

                it("the last Jitsi widget should be removed", () => {
                    expect(WidgetUtils.setRoomWidget).toHaveBeenCalledWith(cli, room.roomId, widget2Id);
                });
            });

            describe("and the current user adds a Jitsi widget after two minutes", () => {
                beforeEach(async () => {
                    await addJitsiWidget(widget2Id, cli.getSafeUserId(), 130_000);
                });

                itShouldNotRemoveTheLastWidget();
            });

            describe("and the current user adds a Jitsi widget without timestamp", () => {
                beforeEach(async () => {
                    await addJitsiWidget(widget2Id, cli.getSafeUserId());
                });

                itShouldNotRemoveTheLastWidget();
            });
        });

        describe("and there is a Jitsi widget from another user without timestamp", () => {
            beforeEach(async () => {
                await addJitsiWidget(widget1Id, otherUserId);
            });

            describe("and the current user adds a Jitsi widget", () => {
                beforeEach(async () => {
                    await addJitsiWidget(widget2Id, cli.getSafeUserId(), 10_000);
                });

                itShouldNotRemoveTheLastWidget();
            });
        });
    });

    it("should not change room when editing event in a room displayed in module", async () => {
        const room2 = new Room("!room2:example.org", cli, "@alice:example.org");
        rooms.set(room2.roomId, room2);
        room.getMyMembership = vi.fn().mockReturnValue(KnownMembership.Join);
        room2.getMyMembership = vi.fn().mockReturnValue(KnownMembership.Join);

        await mountRoomView();

        // Mock the spaceStore activeSpace and ModuleApi setup
        vi.spyOn(stores.spaceStore, "activeSpace", "get").mockReturnValue("space1");
        // Mock that room2 is displayed in a module
        ModuleApi.instance.extras.getVisibleRoomBySpaceKey("space1", () => [room2.roomId]);

        // Mock the roomViewStore method
        vi.spyOn(stores.roomViewStore, "isRoomDisplayedInModule").mockReturnValue(true);

        // Create an event in room2 to edit
        const eventInRoom2 = new MatrixEvent({
            type: "m.room.message",
            event_id: "$edit-event:example.org",
            room_id: room2.roomId,
            sender: "@alice:example.org",
            content: {
                body: "Original message",
                msgtype: "m.text",
            },
        });

        const dispatchSpy = vi.spyOn(defaultDispatcher, "dispatch");

        // Dispatch EditEvent for event in room2 (which is displayed in module)
        defaultDispatcher.dispatch({
            action: Action.EditEvent,
            event: eventInRoom2,
            timelineRenderingType: TimelineRenderingType.Room,
        });

        await flushPromises();

        // Should not dispatch ViewRoom action since room2 is displayed in module
        expect(dispatchSpy).not.toHaveBeenCalledWith(
            expect.objectContaining({
                action: Action.ViewRoom,
                room_id: room2.roomId,
            }),
        );
    });
});
