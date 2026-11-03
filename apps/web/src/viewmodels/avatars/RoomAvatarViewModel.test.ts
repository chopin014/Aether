/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
    type MatrixClient,
    RoomEvent,
    RoomMember,
    Room,
    MatrixEvent,
    EventType,
    KnownMembership,
    RoomStateEvent,
    ClientEvent,
} from "matrix-js-sdk/src/matrix";
import { act } from "react";
import { createTestClient, mkStubRoom } from "test-utils";

import { RoomAvatarViewModel } from "./RoomAvatarViewModel";
import { LocalRoom } from "../../models/LocalRoom";
import DMRoomMap from "../../utils/DMRoomMap";
import { DirectoryMember } from "../../utils/direct-messages";
import * as Avatar from "../../Avatar";

vi.mock("../../customisations/Media", () => ({
    mediaFromMxc: vi.fn(() => ({
        srcHttp: "https://example.org/avatar.png",
        getThumbnailOfSourceHttp: vi.fn(() => "https://example.org/avatar-thumbnail.png"),
    })),
}));

describe("RoomAvatarViewModel", () => {
    let client: MatrixClient;

    beforeEach(() => {
        client = createTestClient();
        DMRoomMap.setShared({
            getUserIdForRoomId: vi.fn().mockReturnValue(undefined),
        } as unknown as DMRoomMap);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("uses the room data in the initial snapshot", () => {
        const room = mkStubRoom("!room:example.com", "Room name", client);
        room.name = "Room name";

        const vm = new RoomAvatarViewModel({ room, size: "36px" });

        expect(vm.getSnapshot()).toMatchObject({
            name: "Room name",
            idName: room.roomId,
            type: "round",
            isClickable: false,
        });
    });

    it("updates the snapshot when the room name changes", () => {
        const room = mkStubRoom("!room:example.com", "Room name", client);
        room.name = "Room name";

        const vm = new RoomAvatarViewModel({ room, size: "36px" });
        const listener = vi.fn();
        vm.subscribe(listener);

        room.name = "Updated room name";

        act(() => {
            room.emit(RoomEvent.Name, room);
        });

        expect(vm.getSnapshot().name).toBe("Updated room name");
        expect(listener).toHaveBeenCalled();
    });

    it("skips snapshot updates for unchanged values", () => {
        const room = mkStubRoom("!room:example.com", "Room name", client);
        room.name = "Room name";

        const vm = new RoomAvatarViewModel({ room, size: "36px" });
        const listener = vi.fn();
        vm.subscribe(listener);

        vm.setViewProps({ size: "36px" });
        vm.setRoom(room);
        vm.setViewAvatarOnClick(undefined);
        vm.setOnClick(undefined);

        expect(listener).not.toHaveBeenCalled();
    });

    it("refreshes once after a large member import and uses the final room state", async () => {
        const room = new Room("!large:example.com", client, client.getSafeUserId());
        vi.spyOn(room, "getMyMembership").mockReturnValue(KnownMembership.Join);
        const avatar = vi
            .spyOn(Avatar, "avatarUrlForRoom")
            .mockImplementation((value) => `${value?.getMembers().length}.png`);
        const vm = new RoomAvatarViewModel({ room, size: "36px" });
        avatar.mockClear();
        const members = Array.from(
            { length: 1000 },
            (_, i) =>
                new MatrixEvent({
                    type: EventType.RoomMember,
                    state_key: `@member${i}:example.com`,
                    room_id: room.roomId,
                    sender: `@member${i}:example.com`,
                    content: { membership: KnownMembership.Join, displayname: `Member ${i}` },
                }),
        );

        room.currentState.markOutOfBandMembersStarted();
        room.currentState.setOutOfBandMembers(members);
        await Promise.resolve();

        expect(room.getMembers()).toHaveLength(1000);
        expect(avatar).toHaveBeenCalledTimes(1);
        expect(vm.getSnapshot().urls).toEqual(["1000.png"]);
        vm.dispose();
    });

    it("ignores unrelated account data and other rooms' state", async () => {
        const room = new Room("!room:example.com", client, client.getSafeUserId());
        const other = new Room("!other:example.com", client, client.getSafeUserId());
        vi.spyOn(room, "getMyMembership").mockReturnValue(KnownMembership.Join);
        const avatar = vi.spyOn(Avatar, "avatarUrlForRoom");
        const vm = new RoomAvatarViewModel({ room, size: "36px" });
        avatar.mockClear();

        client.emit(ClientEvent.AccountData, new MatrixEvent({ type: EventType.FullyRead, content: {} }));
        other.currentState.emit(RoomStateEvent.Update, other.currentState);
        await Promise.resolve();
        expect(avatar).not.toHaveBeenCalled();

        client.emit(ClientEvent.AccountData, new MatrixEvent({ type: EventType.Direct, content: {} }));
        await Promise.resolve();
        expect(avatar).toHaveBeenCalledTimes(1);
        vm.dispose();
    });

    it("drops a queued refresh when the room changes or the view model is disposed", async () => {
        const room = new Room("!room:example.com", client, client.getSafeUserId());
        const nextRoom = new Room("!next:example.com", client, client.getSafeUserId());
        vi.spyOn(room, "getMyMembership").mockReturnValue(KnownMembership.Join);
        vi.spyOn(nextRoom, "getMyMembership").mockReturnValue(KnownMembership.Join);
        const avatar = vi.spyOn(Avatar, "avatarUrlForRoom");
        const vm = new RoomAvatarViewModel({ room, size: "36px" });

        room.currentState.emit(RoomStateEvent.Update, room.currentState);
        vm.setRoom(nextRoom);
        avatar.mockClear();
        await Promise.resolve();
        expect(avatar).not.toHaveBeenCalled();

        nextRoom.currentState.emit(RoomStateEvent.Update, nextRoom.currentState);
        vm.dispose();
        await Promise.resolve();
        expect(avatar).not.toHaveBeenCalled();
    });

    it("derives a DM identity name when available", () => {
        const room = mkStubRoom("!room:example.com", "DM room", client);
        const userId = "@dm_user:example.com";
        vi.spyOn(room, "getMember").mockReturnValue(new RoomMember(room.roomId, userId));

        vi.spyOn(DMRoomMap.shared(), "getUserIdForRoomId").mockReturnValue(userId);
        const vm = new RoomAvatarViewModel({ room, size: "36px" });

        expect(vm.getSnapshot().idName).toBe(userId);
    });

    it("prefers the local room target when there is one", () => {
        const localRoom = new LocalRoom("local+room", client, client.getSafeUserId());
        localRoom.targets.push(new DirectoryMember({ user_id: "@local:example.com" }));

        const vm = new RoomAvatarViewModel({ room: localRoom, size: "36px" });

        expect(vm.getSnapshot().idName).toBe("@local:example.com");
    });

    it("invokes the supplied click handler when avatar lightbox is disabled", () => {
        const room = mkStubRoom("!room:example.com", "Room name", client);
        room.name = "Room name";
        const onClick = vi.fn();
        const vm = new RoomAvatarViewModel({ room, size: "36px", onClick });

        vm.onClick();

        expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("respects an explicit type override", () => {
        const room = mkStubRoom("!room:example.com", "Room name", client);

        const vm = new RoomAvatarViewModel({ room, size: "36px", type: "square" });

        expect(vm.getSnapshot().type).toBe("square");
    });

    it("skips snapshot update when setType is called with the same value", () => {
        const room = mkStubRoom("!room:example.com", "Room name", client);

        const vm = new RoomAvatarViewModel({ room, size: "36px", type: "square" });
        const listener = vi.fn();
        vm.subscribe(listener);

        vm.setType("square");

        expect(listener).not.toHaveBeenCalled();
    });
});
