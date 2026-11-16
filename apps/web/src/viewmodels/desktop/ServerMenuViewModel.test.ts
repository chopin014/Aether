/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JoinRule, type MatrixClient, MatrixEvent, Room, RoomEvent } from "matrix-js-sdk/src/matrix";
import { stubClient } from "test-utils";

import { ServerMenuViewModel } from "./ServerMenuViewModel";
import { NotificationLevel } from "../../stores/notifications/NotificationLevel";
import { NotificationStateEvents } from "../../stores/notifications/NotificationState";
import { SpaceNotificationState } from "../../stores/notifications/SpaceNotificationState";
import * as ServerNotifications from "../../stores/notifications/ServerNotifications";
import { SpaceLayoutStore } from "../../stores/space-layout/SpaceLayoutStore";
import * as space from "../../utils/space";
import * as leave from "../../utils/leave-behaviour";
import * as categories from "../room-list/serverCategories";
import * as roomListUtils from "../room-list/utils";
import defaultDispatcher from "../../dispatcher/dispatcher";
import { Action } from "../../dispatcher/actions";
import SettingsStore from "../../settings/SettingsStore";

const SPACE_ID = "!server:example.org";

describe("ServerMenuViewModel", () => {
    let client: MatrixClient;
    let server: Room;
    let notificationState: SpaceNotificationState;
    let level: NotificationLevel;

    const create = (): ServerMenuViewModel =>
        new ServerMenuViewModel({
            space: server,
            client,
            spaceStore: { getNotificationState: () => notificationState },
        });

    beforeEach(() => {
        client = stubClient();
        server = new Room(SPACE_ID, client, client.getSafeUserId());
        level = NotificationLevel.None;
        notificationState = new SpaceNotificationState();
        vi.spyOn(notificationState, "level", "get").mockImplementation(() => level);
        vi.spyOn(server, "getJoinRule").mockReturnValue(JoinRule.Invite);
        vi.spyOn(server, "canInvite").mockReturnValue(true);
        vi.spyOn(server.currentState, "maySendStateEvent").mockReturnValue(true);
        vi.spyOn(ServerNotifications, "getServerMute").mockReturnValue(undefined);
        vi.spyOn(ServerNotifications, "getServerNotificationLevel").mockReturnValue("mentions");
        vi.spyOn(SpaceLayoutStore.instance, "isHidingMutedChannels").mockReturnValue(false);
        vi.spyOn(SpaceLayoutStore.instance, "canEditLayout").mockReturnValue(true);
        vi.spyOn(space, "shouldShowSpaceSettings").mockReturnValue(true);
        vi.spyOn(roomListUtils, "hasCreateRoomRights").mockReturnValue(true);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("describes what the person may do with the server", () => {
        expect(create().getSnapshot()).toEqual({
            canMarkAsRead: false,
            canInvite: true,
            isMuted: false,
            mutedUntil: undefined,
            notificationLevel: "mentions",
            hideMutedChannels: false,
            canOpenSettings: true,
            canCreateChannel: true,
            canCreateCategory: true,
            showDevtools: false,
        });
    });

    it("keeps out what a member may not do", () => {
        vi.mocked(server.canInvite).mockReturnValue(false);
        vi.mocked(server.currentState.maySendStateEvent).mockReturnValue(false);
        vi.mocked(SpaceLayoutStore.instance.canEditLayout).mockReturnValue(false);
        vi.mocked(space.shouldShowSpaceSettings).mockReturnValue(false);
        expect(create().getSnapshot()).toMatchObject({
            canInvite: false,
            canOpenSettings: false,
            canCreateChannel: false,
            canCreateCategory: false,
        });
    });

    it("follows unread channels, the person's settings and the mute's end", () => {
        vi.useFakeTimers();
        const vm = create();

        level = NotificationLevel.Activity;
        notificationState.emit(NotificationStateEvents.Update);
        expect(vm.getSnapshot().canMarkAsRead).toBe(true);

        const until = Date.now() + 60_000;
        vi.mocked(ServerNotifications.getServerMute).mockReturnValue({ until });
        vi.mocked(ServerNotifications.getServerNotificationLevel).mockReturnValue("all");
        client.emit(
            RoomEvent.AccountData,
            new MatrixEvent({ type: ServerNotifications.SERVER_NOTIFICATIONS_ACCOUNT_DATA_TYPE, content: {} }),
            server,
        );
        expect(vm.getSnapshot()).toMatchObject({ isMuted: true, mutedUntil: until, notificationLevel: "all" });

        vi.mocked(ServerNotifications.getServerMute).mockReturnValue(undefined);
        vi.advanceTimersByTime(60_001);
        expect(vm.getSnapshot()).toMatchObject({ isMuted: false, mutedUntil: undefined });
        vm.dispose();
    });

    it("ignores another room's account data", () => {
        const vm = create();
        vi.mocked(ServerNotifications.getServerNotificationLevel).mockReturnValue("all");
        client.emit(
            RoomEvent.AccountData,
            new MatrixEvent({ type: ServerNotifications.SERVER_NOTIFICATIONS_ACCOUNT_DATA_TYPE, content: {} }),
            new Room("!other:example.org", client, client.getSafeUserId()),
        );
        expect(vm.getSnapshot().notificationLevel).toBe("mentions");
    });

    it("acts on the server", async () => {
        const markRead = vi.spyOn(ServerNotifications, "markServerAsRead").mockResolvedValue();
        const mute = vi.spyOn(ServerNotifications, "muteServer").mockResolvedValue();
        const unmute = vi.spyOn(ServerNotifications, "unmuteServer").mockResolvedValue();
        const setLevel = vi.spyOn(ServerNotifications, "setServerNotificationLevel").mockResolvedValue();
        const setHiding = vi.spyOn(SpaceLayoutStore.instance, "setHidingMutedChannels").mockResolvedValue();
        const invite = vi.spyOn(space, "showSpaceInvite").mockImplementation(() => {});
        const settings = vi.spyOn(space, "showSpaceSettings").mockImplementation(() => {});
        const createRoom = vi.spyOn(space, "showCreateNewRoom").mockResolvedValue(undefined as never);
        const createCategory = vi.spyOn(categories, "showCreateCategory").mockImplementation(() => {});
        const leaveSpace = vi.spyOn(leave, "leaveSpace").mockImplementation(() => {});
        const vm = create();

        vm.markAsRead();
        vm.mute(60_000);
        vm.unmute();
        vm.setNotificationLevel("all");
        vm.toggleHideMutedChannels();
        vm.invite();
        vm.openSettings();
        vm.createChannel();
        vm.createCategory();
        vm.leave();

        expect(markRead).toHaveBeenCalledWith(server);
        expect(mute).toHaveBeenCalledWith(server, 60_000);
        expect(unmute).toHaveBeenCalledWith(server);
        expect(setLevel).toHaveBeenCalledWith(server, "all");
        expect(setHiding).toHaveBeenCalledWith(server, true);
        expect(invite).toHaveBeenCalledWith(server);
        expect(settings).toHaveBeenCalledWith(server);
        // One entry creates both kinds of channel: the dialog asks which.
        expect(createRoom).toHaveBeenCalledWith(server);
        expect(createCategory).toHaveBeenCalledWith(server);
        expect(leaveSpace).toHaveBeenCalledWith(server);
    });

    it("opens the server's timeline for developers", () => {
        const getValue = SettingsStore.getValue.bind(SettingsStore);
        vi.spyOn(SettingsStore, "getValue").mockImplementation((name, ...args) =>
            name === "developerMode" ? true : getValue(name, ...args),
        );
        const dispatch = vi.spyOn(defaultDispatcher, "dispatch").mockImplementation(() => {});
        const vm = create();
        expect(vm.getSnapshot().showDevtools).toBe(true);
        vm.openDevtools();
        expect(dispatch).toHaveBeenCalledWith(
            expect.objectContaining({ action: Action.ViewRoom, room_id: SPACE_ID, forceTimeline: true }),
        );
    });

    it("reports a failed change instead of throwing", async () => {
        const { logger } = await import("matrix-js-sdk/src/logger");
        const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
        vi.spyOn(ServerNotifications, "muteServer").mockRejectedValue(new Error("offline"));
        create().mute(null);
        await vi.waitFor(() => expect(warn).toHaveBeenCalledWith("Failed to mute a server", expect.any(Error)));
    });
});
