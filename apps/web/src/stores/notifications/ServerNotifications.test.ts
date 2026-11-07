/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventType, KnownMembership, MatrixEvent, Room, RoomEvent, RoomStateEvent } from "matrix-js-sdk/src/matrix";
import { createTestClient } from "test-utils";

import {
    getCategoryMute,
    getServerMute,
    getServerNotificationLevel,
    markServerAsRead,
    muteCategory,
    muteServer,
    SERVER_NOTIFICATIONS_ACCOUNT_DATA_TYPE,
    ServerNotificationDefaults,
    serverChannels,
    setServerNotificationLevel,
    unmuteCategory,
    unmuteServer,
} from "./ServerNotifications";
import { TimedMutes } from "./TimedMutes";
import * as RoomNotifs from "../../RoomNotifs";
import * as notifications from "../../utils/notifications";
import { EchoChamber } from "../local-echo/EchoChamber";

const { RoomNotifState } = RoomNotifs;

describe("ServerNotifications", () => {
    let client: ReturnType<typeof createTestClient>;
    let space: Room;
    let rooms: Map<string, Room>;
    let states: Map<string, RoomNotifs.RoomNotifState>;

    function channel(roomId: string, membership: string = KnownMembership.Join): Room {
        const room = new Room(roomId, client, "@userId:matrix.org");
        vi.spyOn(room, "getMyMembership").mockReturnValue(membership);
        rooms.set(roomId, room);
        space.currentState.setStateEvents([
            new MatrixEvent({
                type: EventType.SpaceChild,
                state_key: roomId,
                room_id: space.roomId,
                sender: "@admin:example.org",
                content: { via: ["example.org"] },
            }),
        ]);
        return room;
    }

    function setLevel(level: string): void {
        space.addAccountData([
            new MatrixEvent({ type: SERVER_NOTIFICATIONS_ACCOUNT_DATA_TYPE, content: { v: 1, level } }),
        ]);
    }

    beforeEach(() => {
        client = createTestClient();
        rooms = new Map();
        states = new Map();
        space = new Room("!server:example.org", client, "@userId:matrix.org");
        vi.spyOn(space, "isSpaceRoom").mockReturnValue(true);
        vi.mocked(client.getRoom).mockImplementation((roomId) =>
            roomId === space.roomId ? space : (rooms.get(roomId!) ?? null),
        );
        vi.mocked(client.getRooms).mockImplementation(() => [space, ...rooms.values()]);
        vi.spyOn(RoomNotifs, "getRoomNotifsState").mockImplementation((_client, roomId) => states.get(roomId) ?? null);
        vi.spyOn(EchoChamber, "forRoom").mockImplementation(
            (target: Room) =>
                ({
                    set notificationVolume(state: RoomNotifs.RoomNotifState) {
                        states.set(target.roomId, state);
                    },
                }) as never,
        );
        vi.mocked(client.setRoomAccountData).mockResolvedValue({});
    });

    afterEach(() => {
        ServerNotificationDefaults.instance.stop();
        vi.restoreAllMocks();
    });

    it("lists the joined channels of the server, without nested servers", () => {
        const general = channel("!general:example.org");
        channel("!left:example.org", KnownMembership.Leave);
        const nested = channel("!nested:example.org");
        vi.spyOn(nested, "isSpaceRoom").mockReturnValue(true);
        expect(serverChannels(space)).toEqual([general]);
    });

    function setSettings(content: Record<string, unknown>): void {
        space.addAccountData([new MatrixEvent({ type: SERVER_NOTIFICATIONS_ACCOUNT_DATA_TYPE, content })]);
    }

    it("is muted only when the person muted the server, not when its channels were muted one by one", () => {
        channel("!a:example.org");
        states.set("!a:example.org", RoomNotifState.Mute);
        expect(getServerMute(space)).toBeUndefined();
        setSettings({ v: 1, muted: {} });
        expect(getServerMute(space)).toEqual({});
        setSettings({ v: 1, muted: { until: Date.now() + 60_000 } });
        expect(getServerMute(space)?.until).toBeGreaterThan(Date.now());
        // A mute whose time has passed is over.
        setSettings({ v: 1, muted: { until: Date.now() - 1 } });
        expect(getServerMute(space)).toBeUndefined();
    });

    it("mutes and unmutes the server's channels as a server mute, remembering the choice", async () => {
        const general = channel("!general:example.org");
        setSettings({ v: 1, level: "mentions" });
        const mute = vi.spyOn(TimedMutes.instance, "mute").mockResolvedValue();
        const unmute = vi.spyOn(TimedMutes.instance, "unmute").mockResolvedValue();
        await muteServer(space, null);
        expect(client.setRoomAccountData).toHaveBeenLastCalledWith(
            space.roomId,
            SERVER_NOTIFICATIONS_ACCOUNT_DATA_TYPE,
            {
                v: 1,
                level: "mentions",
                muted: {},
            },
        );
        expect(mute).toHaveBeenCalledWith([general], null, "server");

        setSettings({ v: 1, level: "mentions", muted: {} });
        await unmuteServer(space);
        expect(client.setRoomAccountData).toHaveBeenLastCalledWith(
            space.roomId,
            SERVER_NOTIFICATIONS_ACCOUNT_DATA_TYPE,
            {
                v: 1,
                level: "mentions",
            },
        );
        expect(unmute).toHaveBeenCalledWith([general], "server");
    });

    it("mutes and unmutes a category's channels as a category mute", async () => {
        const general = channel("!general:example.org");
        const mute = vi.spyOn(TimedMutes.instance, "mute").mockResolvedValue();
        const unmute = vi.spyOn(TimedMutes.instance, "unmute").mockResolvedValue();
        await muteCategory(space, "builtin.text", [general], 15 * 60_000);
        expect(mute).toHaveBeenCalledWith([general], 15 * 60_000, "category");
        const saved = vi.mocked(client.setRoomAccountData).mock.lastCall![2] as Record<string, any>;
        expect(saved.muted_categories["builtin.text"].until).toBeGreaterThan(Date.now());

        setSettings(saved);
        expect(getCategoryMute(space, "builtin.text")).toBeDefined();
        expect(getCategoryMute(space, "builtin.voice")).toBeUndefined();
        await unmuteCategory(space, "builtin.text", [general]);
        expect(unmute).toHaveBeenCalledWith([general], "category");
        expect(client.setRoomAccountData).toHaveBeenLastCalledWith(
            space.roomId,
            SERVER_NOTIFICATIONS_ACCOUNT_DATA_TYPE,
            {
                v: 1,
                muted_categories: {},
            },
        );
    });

    it("keeps both of two changes made at the same moment", async () => {
        vi.spyOn(TimedMutes.instance, "mute").mockResolvedValue();
        await Promise.all([
            muteCategory(space, "builtin.text", [], null),
            muteCategory(space, "builtin.voice", [], null),
            setServerNotificationLevel(space, "mentions"),
        ]);
        expect(vi.mocked(client.setRoomAccountData).mock.lastCall![2]).toEqual({
            v: 1,
            muted_categories: { "builtin.text": {}, "builtin.voice": {} },
            level: "mentions",
        });
        // What this client wrote counts until the sync brings it back.
        expect(getCategoryMute(space, "builtin.voice")).toEqual({});
    });

    it("stays muted when its channels can't be turned back on, so it can be tried again", async () => {
        channel("!general:example.org");
        setSettings({ v: 1, muted: {} });
        vi.spyOn(TimedMutes.instance, "unmute").mockRejectedValue(new Error("offline"));
        await expect(unmuteServer(space)).rejects.toThrow("offline");
        expect(client.setRoomAccountData).not.toHaveBeenCalled();
        expect(getServerMute(space)).toEqual({});
    });

    it("stays muted past its end while its channels are still muted by it", () => {
        const general = channel("!general:example.org");
        setSettings({ v: 1, muted: { until: Date.now() - 1 } });
        const by = vi.spyOn(TimedMutes.instance, "mutedBy").mockReturnValue("server");
        expect(getServerMute(space)).toEqual({});
        by.mockReturnValue(undefined);
        expect(getServerMute(space)).toBeUndefined();
        expect(general).toBeDefined();
    });

    it("marks every channel as read", async () => {
        const clear = vi.spyOn(notifications, "clearRoomNotification").mockResolvedValue(undefined);
        channel("!a:example.org");
        channel("!b:example.org");
        await markServerAsRead(space);
        expect(clear).toHaveBeenCalledTimes(2);
    });

    it("moves the channels that follow the server to a new level, leaving the others", async () => {
        channel("!follows:example.org");
        channel("!own:example.org");
        channel("!muted:example.org");
        states.set("!own:example.org", RoomNotifState.AllMessagesLoud);
        states.set("!muted:example.org", RoomNotifState.Mute);
        expect(getServerNotificationLevel(space)).toBe("all");

        await setServerNotificationLevel(space, "mentions");
        expect(states.get("!follows:example.org")).toBe(RoomNotifState.MentionsOnly);
        expect(states.get("!own:example.org")).toBe(RoomNotifState.AllMessagesLoud);
        expect(states.get("!muted:example.org")).toBe(RoomNotifState.Mute);
        expect(client.setRoomAccountData).toHaveBeenCalledWith(space.roomId, SERVER_NOTIFICATIONS_ACCOUNT_DATA_TYPE, {
            v: 1,
            level: "mentions",
        });

        setLevel("mentions");
        expect(getServerNotificationLevel(space)).toBe("mentions");
        await setServerNotificationLevel(space, "all");
        expect(states.get("!follows:example.org")).toBe(RoomNotifState.AllMessages);
    });

    it("gives a channel joined later the server's level", () => {
        setLevel("mentions");
        const later = channel("!later:example.org");
        ServerNotificationDefaults.instance.watch(client);
        client.emit(RoomEvent.MyMembership, later, KnownMembership.Join, KnownMembership.Invite);
        expect(states.get(later.roomId)).toBe(RoomNotifState.MentionsOnly);

        // A channel with a level of its own, or one that isn't newly joined, keeps it.
        const loud = channel("!loud:example.org");
        states.set(loud.roomId, RoomNotifState.AllMessagesLoud);
        client.emit(RoomEvent.MyMembership, loud, KnownMembership.Join, KnownMembership.Invite);
        expect(states.get(loud.roomId)).toBe(RoomNotifState.AllMessagesLoud);
        // A channel the person joined before the server listed it gets the level once the server does.
        const early = new Room("!early:example.org", client, "@userId:matrix.org");
        vi.spyOn(early, "getMyMembership").mockReturnValue(KnownMembership.Join);
        rooms.set(early.roomId, early);
        client.emit(RoomEvent.MyMembership, early, KnownMembership.Join, KnownMembership.Invite);
        expect(states.get(early.roomId)).toBeUndefined();
        const child = new MatrixEvent({
            type: EventType.SpaceChild,
            state_key: early.roomId,
            room_id: space.roomId,
            sender: "@admin:example.org",
            content: { via: ["example.org"] },
        });
        space.currentState.setStateEvents([child]);
        client.emit(RoomStateEvent.Events, child, space.currentState, null);
        expect(states.get(early.roomId)).toBe(RoomNotifState.MentionsOnly);

        const already = channel("!already:example.org");
        client.emit(RoomEvent.MyMembership, already, KnownMembership.Join, KnownMembership.Join);
        expect(states.get(already.roomId)).toBeUndefined();
    });
});
