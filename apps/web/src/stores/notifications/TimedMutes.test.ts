/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientEvent, EventType, MatrixEvent, Room, RoomEvent } from "matrix-js-sdk/src/matrix";
import { createTestClient } from "test-utils";

import { MUTE_ACCOUNT_DATA_TYPE, TimedMutes, TimedMutesEvent } from "./TimedMutes";
import * as RoomNotifs from "../../RoomNotifs";
import defaultDispatcher from "../../dispatcher/dispatcher";
import { Action } from "../../dispatcher/actions";

const { RoomNotifState } = RoomNotifs;

describe("TimedMutes", () => {
    let client: ReturnType<typeof createTestClient>;
    let mutes: TimedMutes;
    /** Each room's level as the server's push rules say, once synced. */
    let synced: Map<string, RoomNotifs.RoomNotifState>;
    let setLevel: ReturnType<typeof vi.spyOn>;

    function room(roomId: string, state: RoomNotifs.RoomNotifState = RoomNotifState.AllMessages): Room {
        const result = new Room(roomId, client, "@userId:matrix.org");
        synced.set(roomId, state);
        return result;
    }

    /** Apply a mute record the way a sync does. */
    function receive(target: Room, content: Record<string, unknown>): void {
        const event = new MatrixEvent({ type: MUTE_ACCOUNT_DATA_TYPE, content });
        target.addAccountData([event]);
        client.emit(RoomEvent.AccountData, event, target);
    }

    /** The push rules arrive with the levels the server accepted. */
    function syncLevels(levels: Record<string, RoomNotifs.RoomNotifState>): void {
        for (const [roomId, state] of Object.entries(levels)) synced.set(roomId, state);
        client.emit(ClientEvent.AccountData, new MatrixEvent({ type: EventType.PushRules, content: {} }));
    }

    const lastRecord = (roomId: string): unknown =>
        [...vi.mocked(client.setRoomAccountData).mock.calls].reverse().find((call) => call[0] === roomId)?.[2];

    beforeEach(() => {
        vi.useFakeTimers({ now: 1_000_000 });
        client = createTestClient();
        synced = new Map();
        vi.spyOn(RoomNotifs, "getRoomNotifsState").mockImplementation((_client, roomId) => synced.get(roomId) ?? null);
        setLevel = vi.spyOn(RoomNotifs, "setRoomNotifsState").mockResolvedValue();
        vi.mocked(client.setRoomAccountData).mockResolvedValue({});
        mutes = new TimedMutes();
    });

    afterEach(() => {
        mutes.stop();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("mutes a room for a while, writing how to end it first, and shows it before the sync", async () => {
        const general = room("!general:example.org", RoomNotifState.MentionsOnly);
        const changed = vi.fn();
        mutes.on(TimedMutesEvent.Changed, changed);
        await mutes.mute([general], 60 * 60_000);

        expect(vi.mocked(client.setRoomAccountData).mock.invocationCallOrder[0]).toBeLessThan(
            setLevel.mock.invocationCallOrder[0],
        );
        expect(lastRecord(general.roomId)).toEqual({
            v: 1,
            restore: RoomNotifState.MentionsOnly,
            by: "channel",
            until: 1_000_000 + 60 * 60_000,
        });
        expect(setLevel).toHaveBeenCalledWith(client, general.roomId, RoomNotifState.Mute);
        expect(mutes.isMuted(general)).toBe(true);
        expect(mutes.mutedUntil(general)).toBe(1_000_000 + 60 * 60_000);
        expect(mutes.mutedBy(general)).toBe("channel");
        expect(changed).toHaveBeenCalledWith(general.roomId);

        // Once the sync brings both back, they are read from there.
        syncLevels({ [general.roomId]: RoomNotifState.Mute });
        receive(general, { v: 1, restore: RoomNotifState.MentionsOnly, by: "channel", until: 1_000_000 + 60 * 60_000 });
        expect(mutes.mutedUntil(general)).toBe(1_000_000 + 60 * 60_000);
    });

    it("mutes until turned back on without an end", async () => {
        const general = room("!general:example.org");
        await mutes.mute([general], null);
        expect(lastRecord(general.roomId)).toEqual({ v: 1, restore: RoomNotifState.AllMessages, by: "channel" });
        expect(mutes.mutedUntil(general)).toBeUndefined();
    });

    it("turns a room back on to its level even before its mute synced", async () => {
        const general = room("!general:example.org", RoomNotifState.MentionsOnly);
        void mutes.mute([general], null);
        await mutes.unmute([general]);
        expect(setLevel).toHaveBeenLastCalledWith(client, general.roomId, RoomNotifState.MentionsOnly);
        expect(lastRecord(general.roomId)).toEqual({});
        expect(mutes.isMuted(general)).toBe(false);
    });

    it("finds a server mute's rooms before their records synced", async () => {
        const general = room("!general:example.org");
        void mutes.mute([general], null, "server");
        await mutes.unmute([general], "server");
        expect(setLevel).toHaveBeenLastCalledWith(client, general.roomId, RoomNotifState.AllMessages);
        expect(lastRecord(general.roomId)).toEqual({});
    });

    it("gives the room its level back when the mute ends, then clears the record", async () => {
        const general = room("!general:example.org", RoomNotifState.Mute);
        receive(general, { v: 1, restore: RoomNotifState.AllMessagesLoud, by: "channel", until: 1_000_000 + 1_000 });
        vi.mocked(client.getRooms).mockReturnValue([general]);
        mutes.watch(client);

        await vi.advanceTimersByTimeAsync(1_000);
        expect(setLevel).toHaveBeenCalledWith(client, general.roomId, RoomNotifState.AllMessagesLoud);
        expect(lastRecord(general.roomId)).toEqual({});

        // It is not ended a second time while the cleared record makes its way back.
        vi.mocked(client.setRoomAccountData).mockClear();
        setLevel.mockClear();
        await vi.advanceTimersByTimeAsync(120_000);
        expect(setLevel).not.toHaveBeenCalled();
        expect(client.setRoomAccountData).not.toHaveBeenCalled();
    });

    it("keeps the record and tries again when the server refuses the room's level", async () => {
        const general = room("!general:example.org", RoomNotifState.Mute);
        receive(general, { v: 1, restore: RoomNotifState.AllMessages, by: "channel", until: 1_000_000 + 1_000 });
        vi.mocked(client.getRooms).mockReturnValue([general]);
        setLevel.mockRejectedValueOnce(new Error("offline"));
        mutes.watch(client);

        await vi.advanceTimersByTimeAsync(1_000);
        expect(client.setRoomAccountData).not.toHaveBeenCalled();
        expect(mutes.isMuted(general)).toBe(true);

        await vi.advanceTimersByTimeAsync(60_000);
        expect(setLevel).toHaveBeenCalledTimes(2);
        expect(lastRecord(general.roomId)).toEqual({});
    });

    it("leaves a room the person turned back on themselves as it is when the mute ends", async () => {
        const general = room("!general:example.org", RoomNotifState.MentionsOnly);
        receive(general, { v: 1, restore: RoomNotifState.AllMessages, by: "channel", until: 1_000_000 + 1_000 });
        vi.mocked(client.getRooms).mockReturnValue([general]);
        mutes.watch(client);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(setLevel).not.toHaveBeenCalled();
        expect(lastRecord(general.roomId)).toEqual({});
    });

    it("keeps a newer mute another device set while ending an old one", async () => {
        const general = room("!general:example.org", RoomNotifState.Mute);
        receive(general, { v: 1, restore: RoomNotifState.AllMessages, by: "channel", until: 1_000_000 + 1_000 });
        vi.mocked(client.getRooms).mockReturnValue([general]);
        let finish!: () => void;
        setLevel.mockReturnValueOnce(new Promise<void>((resolve) => (finish = resolve)));
        mutes.watch(client);
        await vi.advanceTimersByTimeAsync(1_000);
        receive(general, { v: 1, restore: RoomNotifState.AllMessages, by: "channel", until: 9_000_000 });
        finish();
        await vi.advanceTimersByTimeAsync(0);
        expect(client.setRoomAccountData).not.toHaveBeenCalled();
    });

    it("keeps rooms muted on their own out of a category or server mute", async () => {
        const own = room("!own:example.org", RoomNotifState.Mute);
        receive(own, { v: 1, restore: RoomNotifState.AllMessages, by: "channel" });
        const other = room("!other:example.org");
        await mutes.mute([own, other], 15 * 60_000, "server");
        expect(lastRecord(own.roomId)).toBeUndefined();
        expect(lastRecord(other.roomId)).toMatchObject({ by: "server" });

        setLevel.mockClear();
        await mutes.unmute([own, other], "server");
        expect(setLevel).toHaveBeenCalledTimes(1);
        expect(setLevel).toHaveBeenCalledWith(client, other.roomId, RoomNotifState.AllMessages);
    });

    it("lets the person take over a room a server mute silenced", async () => {
        const general = room("!general:example.org", RoomNotifState.Mute);
        receive(general, { v: 1, restore: RoomNotifState.MentionsOnly, by: "server" });
        await mutes.mute([general], null, "channel");
        expect(lastRecord(general.roomId)).toEqual({ v: 1, restore: RoomNotifState.MentionsOnly, by: "channel" });
        expect(setLevel).not.toHaveBeenCalled();
    });

    it("drops queued work when the person logs out", async () => {
        const general = room("!general:example.org");
        mutes.watch(client);
        let finish!: () => void;
        vi.mocked(client.setRoomAccountData).mockReturnValueOnce(
            new Promise((resolve) => (finish = () => resolve({}))),
        );
        const first = mutes.mute([general], null);
        const second = mutes.unmute([general]);
        // The first change is under way when the person logs out; the second hasn't started.
        await vi.advanceTimersByTimeAsync(0);
        defaultDispatcher.dispatch({ action: Action.OnLoggedOut }, true);
        finish();
        await Promise.all([first, second]);
        expect(setLevel).not.toHaveBeenCalled();
        expect(client.setRoomAccountData).toHaveBeenCalledTimes(1);
    });

    it("ignores records it can't read", () => {
        const general = room("!general:example.org", RoomNotifState.Mute);
        receive(general, { v: 1, restore: "loud", until: "soon" });
        expect(mutes.mutedBy(general)).toBeUndefined();
        expect(mutes.mutedUntil(general)).toBeUndefined();
    });
});
