/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    KnownMembership,
    type MatrixClient,
    NotificationCountType,
    Room,
    RoomEvent,
    TypedEventEmitter,
} from "matrix-js-sdk/src/matrix";
import { stubClient } from "test-utils";

import { SMALL_GROUP_SIZE, UnreadConversationsViewModel } from "./UnreadConversationsViewModel";
import { RoomNotificationStateStore } from "../../stores/notifications/RoomNotificationStateStore";
import { type RoomNotificationState } from "../../stores/notifications/RoomNotificationState";
import { NotificationStateEvents } from "../../stores/notifications/NotificationState";
import * as RoomNotifs from "../../RoomNotifs";
import { NotificationLevel } from "../../stores/notifications/NotificationLevel";
import { TimedMutes } from "../../stores/notifications/TimedMutes";
import { MetaSpace } from "../../stores/spaces";
import type SpaceStore from "../../stores/spaces/SpaceStore";
import DMRoomMap from "../../utils/DMRoomMap";
import * as notifications from "../../utils/notifications";
import defaultDispatcher from "../../dispatcher/dispatcher";
import { Action } from "../../dispatcher/actions";

const ME = "@me:example.org";

/** A room's unread messages that notify the person, and whether they muted it. */
interface FakeState {
    count: number;
    mentions?: number;
    muted?: boolean;
}

describe("UnreadConversationsViewModel", () => {
    let client: MatrixClient;
    let rooms: Room[];
    let states: Map<string, FakeState>;
    let notificationStates: Map<string, RoomNotificationState>;
    let homeRooms: Set<string>;
    let directRooms: Set<string>;
    let spaceStore: SpaceStore;

    function addRoom(
        id: string,
        name: string,
        { lastActive = 0, members = 2, membership = KnownMembership.Join as string, space = false } = {},
    ): Room {
        const room = new Room(id, client, ME);
        room.name = name;
        vi.spyOn(room, "getLastActiveTimestamp").mockReturnValue(lastActive);
        vi.spyOn(room, "getJoinedMemberCount").mockReturnValue(members);
        vi.spyOn(room, "getMyMembership").mockReturnValue(membership);
        vi.spyOn(room, "isSpaceRoom").mockReturnValue(space);
        rooms.push(room);
        homeRooms.add(id);
        return room;
    }

    const unread = (count: number, extra: Partial<FakeState> = {}): FakeState => ({ count, ...extra });

    const create = (): UnreadConversationsViewModel => new UnreadConversationsViewModel({ client, spaceStore });
    const ids = (vm: UnreadConversationsViewModel): string[] =>
        vm.getSnapshot().conversations.map((conversation) => conversation.id);

    beforeEach(() => {
        client = stubClient();
        vi.mocked(client.getSafeUserId).mockReturnValue(ME);
        rooms = [];
        states = new Map();
        notificationStates = new Map();
        homeRooms = new Set();
        directRooms = new Set();
        vi.mocked(client.getVisibleRooms).mockImplementation(() => rooms);
        vi.mocked(client.getRoom).mockImplementation((id) => rooms.find((room) => room.roomId === id) ?? null);
        spaceStore = Object.assign(new TypedEventEmitter<string, Record<string, () => void>>(), {
            isRoomInSpace: vi.fn((space: string, id: string) => space === MetaSpace.Home && homeRooms.has(id)),
            setActiveSpace: vi.fn(),
        }) as unknown as SpaceStore;
        vi.spyOn(RoomNotifs, "getRoomNotifsState").mockImplementation((_client, roomId) =>
            states.get(roomId)?.muted ? RoomNotifs.RoomNotifState.Mute : RoomNotifs.RoomNotifState.AllMessages,
        );
        vi.spyOn(RoomNotifs, "getUnreadNotificationCount").mockImplementation((room, type) => {
            const state = states.get(room.roomId);
            if (!state) return 0;
            return type === NotificationCountType.Highlight ? (state.mentions ?? 0) : state.count;
        });
        // Each room's notification state, which tells the rail when the room's unread messages change.
        vi.spyOn(RoomNotificationStateStore.instance, "getRoomState").mockImplementation((room) => {
            let state = notificationStates.get(room.roomId);
            if (!state) {
                // It reports a failed send as Element does: an unsent level with a count of one.
                const unsent = (): boolean => room.getPendingEvents().length > 0;
                state = Object.defineProperties(new TypedEventEmitter(), {
                    muted: { get: () => !!states.get(room.roomId)?.muted },
                    isMention: { get: () => !!states.get(room.roomId)?.mentions },
                    level: {
                        get: () =>
                            unsent()
                                ? NotificationLevel.Unsent
                                : states.get(room.roomId)?.count
                                  ? NotificationLevel.Notification
                                  : NotificationLevel.None,
                    },
                    count: { get: () => (unsent() ? 1 : (states.get(room.roomId)?.count ?? 0)) },
                }) as unknown as RoomNotificationState;
                notificationStates.set(room.roomId, state);
            }
            return state;
        });
        vi.spyOn(DMRoomMap, "shared").mockReturnValue({
            getUserIdForRoomId: (id: string) => (directRooms.has(id) ? "@friend:example.org" : undefined),
        } as unknown as DMRoomMap);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("lists Home's unread conversations, newest first, with their counts", () => {
        addRoom("!old", "Old friend", { lastActive: 100 });
        addRoom("!new", "New friend", { lastActive: 300 });
        addRoom("!read", "Read", { lastActive: 500 });
        directRooms.add("!old").add("!new").add("!read");
        states.set("!old", unread(1));
        states.set("!new", unread(4));

        const vm = create();
        expect(vm.getSnapshot().conversations).toEqual([
            { id: "!new", name: "New friend", avatarUrl: undefined, count: 4 },
            { id: "!old", name: "Old friend", avatarUrl: undefined, count: 1 },
        ]);
    });

    it("leaves out muted conversations, read ones, and rooms outside Home", () => {
        addRoom("!muted", "Muted");
        addRoom("!read", "Read");
        addRoom("!server", "general");
        homeRooms.delete("!server");
        addRoom("!space", "A server", { space: true });
        states.set("!muted", unread(3, { muted: true }));
        states.set("!read", unread(0));
        states.set("!server", unread(2));
        states.set("!space", unread(2));

        expect(ids(create())).toEqual([]);
    });

    it("shows a large room only when it mentions the person", () => {
        addRoom("!small", "Small group", { members: SMALL_GROUP_SIZE });
        addRoom("!large", "Community", { members: SMALL_GROUP_SIZE + 1 });
        addRoom("!called", "Other community", { members: 500 });
        states.set("!small", unread(2));
        states.set("!large", unread(9));
        states.set("!called", unread(1, { mentions: 1 }));

        expect(ids(create()).sort()).toEqual(["!called", "!small"]);
    });

    it("leaves invitations to Home's own count", () => {
        addRoom("!invite", "Bob", { membership: KnownMembership.Invite, lastActive: 10 });
        states.set("!invite", unread(1, { mentions: 1 }));
        expect(ids(create())).toEqual([]);
    });

    it("follows new messages once a burst of changes settles", () => {
        vi.useFakeTimers();
        const room = addRoom("!dm", "Alice");
        directRooms.add("!dm");
        const vm = create();
        expect(ids(vm)).toEqual([]);

        states.set("!dm", unread(1));
        client.emit(RoomEvent.Timeline, undefined as never, room, undefined, false, {} as never);
        expect(ids(vm)).toEqual([]);
        vi.advanceTimersByTime(50);
        expect(ids(vm)).toEqual(["!dm"]);

        // Nothing new to show keeps the same list, so the rail does not draw again.
        const before = vm.getSnapshot().conversations;
        spaceStore.emit(MetaSpace.Home);
        vi.advanceTimersByTime(50);
        expect(vm.getSnapshot().conversations).toBe(before);
        vm.dispose();
    });

    it("counts only others' messages, whatever the person's own failed sends", () => {
        const room = addRoom("!dm", "Alice");
        directRooms.add("!dm");
        // A message of Alice's own that failed to send is not a message waiting for her.
        vi.spyOn(room, "getPendingEvents").mockReturnValue([{ status: "not_sent" } as never]);
        expect(ids(create())).toEqual([]);

        // Nor does it hide how many messages wait.
        states.set("!dm", unread(3));
        expect(create().getSnapshot().conversations[0].count).toBe(3);
    });

    it("follows a room's own notification changes, such as a mention decryption reveals", () => {
        vi.useFakeTimers();
        addRoom("!large", "Community", { members: 50 });
        states.set("!large", unread(4));
        const vm = create();
        expect(ids(vm)).toEqual([]);

        // Decrypting a message finds Alice mentioned; nothing but the room's own state changes.
        states.set("!large", unread(4, { mentions: 1 }));
        notificationStates.get("!large")!.emit(NotificationStateEvents.Update);
        vi.advanceTimersByTime(50);
        expect(ids(vm)).toEqual(["!large"]);

        // Once the room leaves Home, and when the rail goes, its state is no longer listened to.
        homeRooms.delete("!large");
        spaceStore.emit(MetaSpace.Home);
        vi.advanceTimersByTime(50);
        expect(notificationStates.get("!large")!.listenerCount(NotificationStateEvents.Update)).toBe(0);
        homeRooms.add("!large");
        spaceStore.emit(MetaSpace.Home);
        vi.advanceTimersByTime(50);
        expect(notificationStates.get("!large")!.listenerCount(NotificationStateEvents.Update)).toBe(1);
        vm.dispose();
        expect(notificationStates.get("!large")!.listenerCount(NotificationStateEvents.Update)).toBe(0);
    });

    it("opens a conversation in Home", () => {
        const dispatch = vi.spyOn(defaultDispatcher, "dispatch").mockImplementation(() => {});
        create().openConversation("!dm");
        expect(spaceStore.setActiveSpace).toHaveBeenCalledWith(MetaSpace.Home, false);
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ action: Action.ViewRoom, room_id: "!dm" }));
    });

    it("marks a conversation as read and mutes it", () => {
        const room = addRoom("!dm", "Alice");
        const clear = vi.spyOn(notifications, "clearRoomNotification").mockResolvedValue(undefined);
        const mute = vi.spyOn(TimedMutes.instance, "mute").mockResolvedValue(undefined);
        const vm = create();

        vm.markAsRead("!dm");
        expect(clear).toHaveBeenCalledWith(room, client);
        vm.mute("!dm", 60_000);
        expect(mute).toHaveBeenCalledWith([room], 60_000);

        vm.markAsRead("!gone");
        vm.mute("!gone", null);
        expect(clear).toHaveBeenCalledTimes(1);
        expect(mute).toHaveBeenCalledTimes(1);
    });
});
