/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Room, TypedEventEmitter } from "matrix-js-sdk/src/matrix";

import { ServerFolderItemViewModel, type ServerFolderItemProps } from "./ServerFolderItemViewModel";
import { RoomNotificationStateStore } from "../../stores/notifications/RoomNotificationStateStore";
import { type RoomNotificationState } from "../../stores/notifications/RoomNotificationState";
import { NotificationStateEvents } from "../../stores/notifications/NotificationState";
import * as RoomNotifs from "../../RoomNotifs";

vi.mock("../../customisations/Media", () => ({
    mediaFromMxc: (mxc: string) => ({ getThumbnailOfSourceHttp: () => `https://media/${mxc.slice(6)}` }),
}));

/** A room's notification state that a test can change and announce. */
class FakeState extends TypedEventEmitter<NotificationStateEvents, { [NotificationStateEvents.Update]: () => void }> {
    public hasAnyNotificationOrActivity = false;
    public isMention = false;
    public muted = false;
    public constructor(public readonly room: Room) {
        super();
    }
    public set(values: Partial<Pick<FakeState, "hasAnyNotificationOrActivity" | "isMention" | "muted">>): void {
        Object.assign(this, values);
        this.emit(NotificationStateEvents.Update);
    }
}

describe("ServerFolderItemViewModel", () => {
    let states: Map<Room, FakeState>;
    let props: ServerFolderItemProps;
    const room = (roomId: string): Room => ({ roomId }) as Room;

    beforeEach(() => {
        vi.useFakeTimers();
        states = new Map();
        vi.spyOn(RoomNotificationStateStore.instance, "getRoomState").mockImplementation((forRoom) => {
            if (!states.has(forRoom)) states.set(forRoom, new FakeState(forRoom));
            return states.get(forRoom) as unknown as RoomNotificationState;
        });
        vi.spyOn(RoomNotifs, "getUnreadNotificationCount").mockReturnValue(2);
        props = {
            folder: { roomId: "!advocacy:example.org", name: "Advocacy", avatarUrl: "mxc://example.org/a" },
            expanded: false,
            canExpand: true,
            canMove: true,
            onToggle: vi.fn(),
            onOpen: vi.fn(),
        };
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("looks like a folder of its server, which admins may move", () => {
        const vm = new ServerFolderItemViewModel(props);
        expect(vm.roomId).toBe("!advocacy:example.org");
        expect(vm.getSnapshot()).toMatchObject({
            id: "!advocacy:example.org",
            name: "Advocacy",
            isBold: false,
            folder: { expanded: false, canExpand: true, avatarUrl: "https://media/example.org/a" },
            showMoreOptionsMenu: false,
            canChangeSection: true,
        });
        expect(vm.getSnapshot().channelKind).toBeUndefined();
    });

    it("opens or closes in place when clicked, and opens its server from its button", () => {
        const vm = new ServerFolderItemViewModel(props);
        vm.onOpenRoom();
        expect(props.onToggle).toHaveBeenCalledOnce();
        vm.onOpenFolder();
        expect(props.onOpen).toHaveBeenCalledOnce();
    });

    it("opens its server when clicked if it can't open in place", () => {
        const vm = new ServerFolderItemViewModel({ ...props, canExpand: false, expanded: true });
        expect(vm.getSnapshot().folder).toMatchObject({ expanded: false, canExpand: false });
        vm.onOpenRoom();
        expect(props.onOpen).toHaveBeenCalledOnce();
        expect(props.onToggle).not.toHaveBeenCalled();
    });

    it("shows the news inside it, counting mentions as channel badges do and leaving muted channels out", () => {
        const news = room("!news:example.org");
        const quiet = room("!quiet:example.org");
        const vm = new ServerFolderItemViewModel(props);
        vm.setRooms([news, quiet]);

        states.get(quiet)!.set({ hasAnyNotificationOrActivity: true, muted: true });
        vi.advanceTimersByTime(300);
        expect(vm.getSnapshot().isBold).toBe(false);

        states.get(news)!.set({ hasAnyNotificationOrActivity: true });
        vi.advanceTimersByTime(300);
        expect(vm.getSnapshot()).toMatchObject({ isBold: true, mentionCount: undefined });

        // A mention counts even in a muted channel.
        states.get(quiet)!.set({ isMention: true });
        vi.advanceTimersByTime(300);
        expect(vm.getSnapshot()).toMatchObject({ isBold: true, mentionCount: 2 });
        expect(vm.getSnapshot().notification.isMention).toBe(true);
    });

    it("follows only the rooms it holds now, and keeps its news when its state is updated", () => {
        const news = room("!news:example.org");
        const vm = new ServerFolderItemViewModel(props);
        vm.setRooms([news]);
        states.get(news)!.set({ hasAnyNotificationOrActivity: true });
        vi.advanceTimersByTime(300);

        vm.update({ ...props, expanded: true, folder: { ...props.folder, name: "Advocacy (new)" } });
        expect(vm.getSnapshot()).toMatchObject({ name: "Advocacy (new)", isBold: true, folder: { expanded: true } });

        vm.setRooms([]);
        expect(states.get(news)!.listenerCount(NotificationStateEvents.Update)).toBe(0);
        vi.advanceTimersByTime(300);
        expect(vm.getSnapshot().isBold).toBe(false);
    });

    it("stops following its rooms when disposed", () => {
        const news = room("!news:example.org");
        const vm = new ServerFolderItemViewModel(props);
        vm.setRooms([news]);
        vm.dispose();
        expect(states.get(news)!.listenerCount(NotificationStateEvents.Update)).toBe(0);
    });
});
