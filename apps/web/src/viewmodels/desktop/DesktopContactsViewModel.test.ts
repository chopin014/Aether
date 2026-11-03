/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    EventType,
    MatrixEvent,
    Room,
    RoomMemberEvent,
    RoomMember,
    User,
    UserEvent,
    type MatrixClient,
} from "matrix-js-sdk/src/matrix";
import { stubClient } from "test-utils";

import { DesktopContactsViewModel } from "./DesktopContactsViewModel";
import SdkConfig from "../../SdkConfig";
import defaultDispatcher from "../../dispatcher/dispatcher";
import { Action } from "../../dispatcher/actions";

describe("DesktopContactsViewModel", () => {
    let client: MatrixClient;
    let vm: DesktopContactsViewModel;
    let room: Room;
    let user: User;
    beforeEach(() => {
        client = stubClient();
        user = new User("@bob:example.org");
        user.displayName = "Bob";
        user.setPresenceEvent(new MatrixEvent({ type: "m.presence", content: { presence: "online" } }));
        room = new Room("!dm:example.org", client, client.getSafeUserId());
        vi.spyOn(room, "getMyMembership").mockReturnValue("join");
        vi.mocked(client.getRooms).mockReturnValue([room]);
        vi.mocked(client.getRoom).mockImplementation((id) => (id === room.roomId ? room : null));
        vi.mocked(client.getUser).mockImplementation((id) => (id === user.userId ? user : null));
        vi.mocked(client.getAccountData).mockReturnValue(
            new MatrixEvent({ type: EventType.Direct, content: { [user.userId]: [room.roomId] } }),
        );
        vi.spyOn(defaultDispatcher, "dispatch").mockImplementation(() => undefined);
        vm = new DesktopContactsViewModel({ client });
    });
    afterEach(() => {
        vm.dispose();
        vi.restoreAllMocks();
        SdkConfig.reset();
    });
    it("derives contacts only from actual joined direct rooms, excluding unrelated rooms and duplicate conversations", () => {
        expect(vm.getSnapshot().contacts).toMatchObject([
            { userId: user.userId, name: "Bob", roomId: room.roomId, presence: "online" },
        ]);
        expect(vm.getSnapshot().pendingCount).toBe(0);
    });
    it("updates presence live, filters by name or Matrix ID and preserves offline contacts in All", async () => {
        user.presence = "offline";
        client.emit(UserEvent.Presence, undefined, user);
        await Promise.resolve();
        expect(vm.getSnapshot().contacts).toEqual([]);
        vm.setTab("all");
        expect(vm.getSnapshot().contacts).toHaveLength(1);
        vm.setQuery("example.org");
        expect(vm.getSnapshot().contacts).toHaveLength(1);
        vm.setQuery("unknown");
        expect(vm.getSnapshot().contacts).toEqual([]);
    });
    it("should keep missing presence neutral in All and exclude it from Online", async () => {
        delete user.events.presence;
        user.presence = "offline";
        client.emit(UserEvent.LastPresenceTs, undefined, user);
        await Promise.resolve();
        expect(vm.getSnapshot().onlineContacts).toEqual([]);
        expect(vm.getSnapshot().contacts).toEqual([]);
        vm.setTab("all");
        expect(vm.getSnapshot().contacts[0].presence).toBe("unknown");
        user.setPresenceEvent(new MatrixEvent({ type: "m.presence", content: { presence: "offline" } }));
        client.emit(UserEvent.LastPresenceTs, user.events.presence!, user);
        await Promise.resolve();
        expect(vm.getSnapshot().contacts[0].presence).toBe("offline");
    });

    it("should hide known presence when explicitly disabled", async () => {
        SdkConfig.put({ enable_presence_by_hs_url: { [client.baseUrl]: false } });
        client.emit(UserEvent.LastPresenceTs, user.events.presence!, user);
        await Promise.resolve();
        expect(vm.getSnapshot().onlineContacts).toEqual([]);
        vm.setTab("all");
        expect(vm.getSnapshot().contacts[0].presence).toBe("unknown");
    });

    it("opens the existing DM rather than creating a replacement room", () => {
        vm.openConversation(user.userId);
        expect(defaultDispatcher.dispatch).toHaveBeenCalledWith({
            action: Action.ViewRoom,
            room_id: room.roomId,
            metricsTrigger: undefined,
        });
        expect(client.createRoom).not.toHaveBeenCalled();
    });
    it("uses the existing invitation APIs and navigates after successful join", async () => {
        vi.mocked(room.getMyMembership).mockReturnValue("invite");
        client.emit(UserEvent.Presence, undefined, user);
        await Promise.resolve();
        vm.setTab("pending");
        expect(vm.getSnapshot().pendingCount).toBe(1);
        vi.mocked(client.joinRoom).mockResolvedValue(room);
        await vm.acceptInvitation(room.roomId);
        expect(client.joinRoom).toHaveBeenCalledWith(room.roomId);
        expect(defaultDispatcher.dispatch).toHaveBeenCalledWith({
            action: Action.ViewRoom,
            room_id: room.roomId,
            metricsTrigger: undefined,
        });
        await vm.declineInvitation(room.roomId);
        expect(client.leave).toHaveBeenCalledWith(room.roomId);
        await vm.acceptInvitation("!unknown:example.org");
        expect(client.joinRoom).toHaveBeenCalledTimes(1);
    });
    it("preserves failed invitations and allows retry after network errors", async () => {
        vi.mocked(room.getMyMembership).mockReturnValue("invite");
        client.emit(UserEvent.Presence, undefined, user);
        await Promise.resolve();
        vm.setTab("pending");
        vi.mocked(client.joinRoom).mockRejectedValue(new Error("Offline"));
        await vm.acceptInvitation(room.roomId);
        expect(vm.getSnapshot()).toMatchObject({
            pendingCount: 1,
            busyIds: [],
            error: "That action could not be completed. Please try again.",
        });
        expect(vm.getSnapshot().contacts).toHaveLength(1);
    });
    it("uses Matrix ignored-user account data for Blocked and unblocks only the selected user", async () => {
        let ignored = [user.userId, "@other:example.org"];
        vi.mocked(client.getIgnoredUsers).mockImplementation(() => ignored);
        vi.mocked(client.setIgnoredUsers).mockImplementation(async (ids) => {
            ignored = ids;
            return {};
        });
        client.emit(UserEvent.Presence, undefined, user);
        await Promise.resolve();
        expect(vm.getSnapshot().contacts).toEqual([]);
        vm.setTab("blocked");
        expect(vm.getSnapshot().contacts).toHaveLength(2);
        await vm.unblock(user.userId);
        expect(client.setIgnoredUsers).toHaveBeenCalledWith(["@other:example.org"]);
        expect(vm.getSnapshot().contacts).toHaveLength(1);
    });
    it("coalesces a roster import into one refresh and publishes the latest contact state", async () => {
        const getRooms = vi.mocked(client.getRooms);
        getRooms.mockClear();
        const event = new MatrixEvent({ type: EventType.RoomMember });
        const member = new RoomMember(room.roomId, user.userId);
        for (let i = 0; i < 1000; i++) client.emit(RoomMemberEvent.Name, event, member, "Bob");
        user.displayName = "Updated Bob";
        client.emit(UserEvent.DisplayName, new MatrixEvent({ type: "m.presence" }), user);
        expect(getRooms).not.toHaveBeenCalled();
        await Promise.resolve();
        expect(getRooms).toHaveBeenCalledTimes(1);
        expect(vm.getSnapshot().contacts[0].name).toBe("Updated Bob");
    });

    it("discards a queued refresh when disposed", async () => {
        const getRooms = vi.mocked(client.getRooms);
        getRooms.mockClear();
        client.emit(UserEvent.Presence, undefined, user);
        vm.dispose();
        await Promise.resolve();
        expect(getRooms).not.toHaveBeenCalled();
    });

    it("removes client listeners on disposal", () => {
        const off = vi.spyOn(client, "off");
        vm.dispose();
        expect(off).toHaveBeenCalledWith(UserEvent.Presence, expect.any(Function));
    });
});
