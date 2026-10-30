/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventType, MatrixEvent, Room, type MatrixClient } from "matrix-js-sdk/src/matrix";
import { BaseViewModel, RoomNotifState, type RoomListItemViewSnapshot } from "@element-hq/web-shared-components";
import { stubClient } from "test-utils";

import { ChannelMenuViewModel, type ChannelMenuItemSource } from "./ChannelMenuViewModel";
import defaultDispatcher from "../../dispatcher/dispatcher";
import { Action } from "../../dispatcher/actions";
import Modal from "../../Modal";
import ExportDialog from "../../components/views/dialogs/ExportDialog";
import { ReportRoomDialog } from "../../components/views/dialogs/ReportRoomDialog";
import { PollHistoryDialog } from "../../components/views/dialogs/PollHistoryDialog";
import RightPanelStore from "../../stores/right-panel/RightPanelStore";
import { RightPanelPhases } from "../../stores/right-panel/RightPanelStorePhases";
import { RoomSettingsTab } from "../../components/views/dialogs/RoomSettingsDialog-tab";
import { DeleteChannelDialog } from "../../components/views/dialogs/DeleteChannelDialog";

vi.mock("../../Modal");

const ROOM_ID = "!room:example.org";
const USER_ID = "@alice:example.org";

class FakeItem extends BaseViewModel<RoomListItemViewSnapshot, object> implements ChannelMenuItemSource {
    public onMarkAsRead = vi.fn();
    public onToggleFavorite = vi.fn();
    public onInvite = vi.fn();
    public onCopyRoomLink = vi.fn();
    public onSetRoomNotifState = vi.fn();
    public onLeaveRoom = vi.fn();
    public onEditChannel = vi.fn();

    public constructor(snapshot: Partial<RoomListItemViewSnapshot>) {
        super({}, {
            channelKind: "text",
            canMarkAsRead: true,
            isFavourite: false,
            canInvite: true,
            canCopyRoomLink: true,
            showNotificationMenu: true,
            roomNotifState: RoomNotifState.AllMessages,
            ...snapshot,
        } as RoomListItemViewSnapshot);
    }

    public set(change: Partial<RoomListItemViewSnapshot>): void {
        this.snapshot.merge(change);
    }
}

const makeItem = (snapshot: Partial<RoomListItemViewSnapshot> = {}): FakeItem => new FakeItem(snapshot);

describe("ChannelMenuViewModel", () => {
    let client: MatrixClient;
    let room: Room;
    const space = new Room("!space:example.org", {} as MatrixClient, USER_ID);
    const spaceStore = { activeSpaceRoom: null as Room | null, isRoomInSpace: vi.fn(() => true) };

    const state = (type: string, content: object): MatrixEvent =>
        new MatrixEvent({ type, state_key: "", room_id: ROOM_ID, sender: USER_ID, content });
    const create = (item = makeItem()) => new ChannelMenuViewModel({ room, client, item, spaceStore });

    beforeEach(() => {
        client = stubClient();
        vi.spyOn(client, "getSafeUserId").mockReturnValue(USER_ID);
        vi.spyOn(client, "isRoomEncrypted").mockReturnValue(false);
        room = new Room(ROOM_ID, client, USER_ID);
        spaceStore.activeSpaceRoom = null;
    });
    afterEach(() => vi.restoreAllMocks());

    describe("snapshot", () => {
        it("reflects favourites, unread state and notifications from the room list item", () => {
            const vm = create(
                makeItem({ isFavourite: true, canMarkAsRead: false, roomNotifState: RoomNotifState.Mute }),
            );
            expect(vm.getSnapshot()).toMatchObject({
                isFavourite: true,
                canMarkAsRead: false,
                roomNotifState: RoomNotifState.Mute,
                canInvite: true,
                canChangeNotifications: true,
                kind: "text",
            });
        });

        it("follows the item when its favourite state changes", () => {
            const item = makeItem();
            const vm = create(item);
            const listener = vi.fn();
            vm.subscribe(listener);
            item.set({ isFavourite: true });
            expect(vm.getSnapshot().isFavourite).toBe(true);
            expect(listener).toHaveBeenCalled();
        });

        it("offers editing only to people who may rename or retopic the room", () => {
            expect(create().getSnapshot()).toMatchObject({ canEditChannel: true, canEditTopic: true });
            room.currentState.setStateEvents([state(EventType.RoomPowerLevels, { state_default: 50 })]);
            expect(create().getSnapshot()).toMatchObject({ canEditChannel: false, canEditTopic: false });
        });

        it("reports the topic, encryption and history visibility", () => {
            vi.spyOn(client, "isRoomEncrypted").mockReturnValue(true);
            room.currentState.setStateEvents([
                state(EventType.RoomTopic, { topic: "Plans" }),
                state(EventType.RoomHistoryVisibility, { history_visibility: "shared" }),
            ]);
            expect(create().getSnapshot()).toMatchObject({
                topic: "Plans",
                isEncrypted: true,
                historyVisibility: "shared",
            });
        });

        it("updates the topic when the room state changes", () => {
            const vm = create();
            room.currentState.setStateEvents([state(EventType.RoomTopic, { topic: "New" })]);
            expect(vm.getSnapshot().topic).toBe("New");
        });

        it("leaves the Matrix extras to rooms with messages", () => {
            expect(create().getSnapshot().hasMessages).toBe(true);
            vi.spyOn(room, "isCallRoom").mockReturnValue(true);
            expect(create().getSnapshot().hasMessages).toBe(false);
        });

        it("offers a new channel only inside a Space where the user may add rooms", () => {
            expect(create().getSnapshot().canCreateChannel).toBe(false);

            spaceStore.activeSpaceRoom = space;
            vi.spyOn(space, "getLiveTimeline").mockReturnValue({
                getState: () => ({ maySendStateEvent: () => true }),
            } as never);
            expect(create().getSnapshot().canCreateChannel).toBe(true);

            vi.spyOn(space, "getLiveTimeline").mockReturnValue({
                getState: () => ({ maySendStateEvent: () => false }),
            } as never);
            expect(create().getSnapshot().canCreateChannel).toBe(false);

            spaceStore.isRoomInSpace.mockReturnValueOnce(false);
            expect(create().getSnapshot().canCreateChannel).toBe(false);
        });

        it("offers deletion only for a linked channel the administrator can close", () => {
            vi.spyOn(room, "membersLoaded").mockReturnValue(true);
            const parent = new Room("!parent:example.org", client, USER_ID);
            for (const target of [room, parent]) {
                target.currentState.setStateEvents([
                    new MatrixEvent({
                        type: EventType.RoomCreate,
                        room_id: target.roomId,
                        sender: USER_ID,
                        state_key: "",
                        content: { creator: USER_ID, room_version: "11" },
                    }),
                    new MatrixEvent({
                        type: EventType.RoomMember,
                        room_id: target.roomId,
                        sender: USER_ID,
                        state_key: USER_ID,
                        content: { membership: "join" },
                    }),
                    new MatrixEvent({
                        type: EventType.RoomPowerLevels,
                        room_id: target.roomId,
                        state_key: "",
                        content: { users: { [USER_ID]: 100 } },
                    }),
                ]);
            }
            parent.currentState.setStateEvents([
                new MatrixEvent({
                    type: EventType.SpaceChild,
                    room_id: parent.roomId,
                    state_key: ROOM_ID,
                    content: { via: ["example.org"] },
                }),
            ]);
            spaceStore.activeSpaceRoom = parent;
            const vm = create();
            expect(vm.getSnapshot().canDeleteChannel).toBe(true);
            vm.onDelete();
            expect(Modal.createDialog).toHaveBeenCalledWith(
                DeleteChannelDialog,
                { room, space: parent, client },
                undefined,
                false,
                true,
            );

            // Removing the server link refreshes both the menu and the action's permission guard.
            vi.mocked(Modal.createDialog).mockClear();
            parent.currentState.setStateEvents([
                new MatrixEvent({
                    type: EventType.SpaceChild,
                    room_id: parent.roomId,
                    state_key: ROOM_ID,
                    content: {},
                }),
            ]);
            expect(vm.getSnapshot().canDeleteChannel).toBe(false);
            vm.onDelete();
            expect(Modal.createDialog).not.toHaveBeenCalled();
            vm.dispose();
        });
    });

    describe("actions", () => {
        it("delegates marking read, favourites, invite, link, notifications and leave to the room list item", async () => {
            const item = makeItem();
            const vm = create(item);
            vm.onMarkAsRead();
            vm.onToggleFavourite();
            vm.onInvite();
            vm.onCopyLink();
            vm.onSetNotifState(RoomNotifState.MentionsOnly);
            vm.onEditChannel();
            vm.onLeave();
            expect(item.onMarkAsRead).toHaveBeenCalled();
            expect(item.onToggleFavorite).toHaveBeenCalled();
            expect(item.onInvite).toHaveBeenCalled();
            expect(item.onCopyRoomLink).toHaveBeenCalled();
            expect(item.onSetRoomNotifState).toHaveBeenCalledWith(RoomNotifState.MentionsOnly);
            expect(item.onEditChannel).toHaveBeenCalled();
            expect(item.onLeaveRoom).toHaveBeenCalled();
        });

        it("opens the topic and security settings tabs of this room", () => {
            const dispatch = vi.spyOn(defaultDispatcher, "dispatch");
            const vm = create();
            vm.onEditTopic();
            vm.onOpenSecuritySettings();
            expect(dispatch).toHaveBeenCalledWith({
                action: "open_room_settings",
                room_id: ROOM_ID,
                initial_tab_id: RoomSettingsTab.General,
            });
            expect(dispatch).toHaveBeenCalledWith({
                action: "open_room_settings",
                room_id: ROOM_ID,
                initial_tab_id: RoomSettingsTab.Security,
            });
        });

        it("creates a channel in the active Space", () => {
            spaceStore.activeSpaceRoom = space;
            const dispatch = vi.spyOn(defaultDispatcher, "dispatch");
            create().onCreateChannel();
            expect(dispatch).toHaveBeenCalledWith({ action: Action.CreateRoom, parent_space: space });
        });

        it("searches for files with has:file", () => {
            const dispatch = vi.spyOn(defaultDispatcher, "dispatch");
            create().onFiles();
            expect(dispatch).toHaveBeenCalledWith({ action: Action.FocusMessageSearch, initialText: "has:file" });
        });

        it("opens poll history, export and report as the existing dialogs", async () => {
            vi.mocked(Modal.createDialog).mockReturnValue({ finished: Promise.resolve([false]) } as never);
            const item = makeItem();
            const vm = create(item);
            vm.onPolls();
            expect(Modal.createDialog).toHaveBeenCalledWith(
                PollHistoryDialog,
                expect.objectContaining({ room, matrixClient: client }),
            );
            vm.onExport();
            expect(Modal.createDialog).toHaveBeenCalledWith(ExportDialog, { room });
            await vm.onReport();
            expect(Modal.createDialog).toHaveBeenCalledWith(ReportRoomDialog, { roomId: ROOM_ID });
            expect(item.onLeaveRoom).not.toHaveBeenCalled();
        });

        it("leaves the channel when the report dialog asks to", async () => {
            vi.mocked(Modal.createDialog).mockReturnValue({ finished: Promise.resolve([true]) } as never);
            const item = makeItem();
            await create(item).onReport();
            expect(item.onLeaveRoom).toHaveBeenCalled();
        });

        it("shows extensions as a right panel card", () => {
            const setCard = vi.spyOn(RightPanelStore.instance, "setCard").mockImplementation(() => {});
            create().onExtensions();
            expect(setCard).toHaveBeenCalledWith({ phase: RightPanelPhases.Extensions });
        });
    });
});
