/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { ClientEvent, EventType, type IPushRules, MatrixEvent, Room, RoomEvent } from "matrix-js-sdk/src/matrix";
import { createTestClient } from "test-utils";

import { MUTE_ACCOUNT_DATA_TYPE, StoppedError, TimedMutes, TimedMutesEvent } from "./TimedMutes";
import * as RoomNotifs from "../../RoomNotifs";
import * as serverCopy from "./serverCopy";
import defaultDispatcher from "../../dispatcher/dispatcher";
import { Action } from "../../dispatcher/actions";

const { RoomNotifState } = RoomNotifs;

/**
 * A server and its sync, as far as mutes go. Like Matrix, turning a room's mute off only removes the mute rule found in
 * the push rules it starts from, and what the client writes comes back through the sync a moment later, unless
 * `holdSync` says otherwise. Fetched push rules are a copy of the server's levels.
 */
describe("TimedMutes", () => {
    let client: ReturnType<typeof createTestClient>;
    let mutes: TimedMutes;
    const rooms = new Map<string, Room>();
    /** The levels the server holds. */
    let server: Map<string, RoomNotifs.RoomNotifState>;
    /** The levels the client has synced. */
    let synced: Map<string, RoomNotifs.RoomNotifState>;
    /** The mute records the server holds. */
    let records: Map<string, Record<string, unknown>>;
    let holdSync: boolean;
    let fetchRules: MockInstance<typeof serverCopy.fetchPushRules>;
    let setLevel: MockInstance<typeof RoomNotifs.setRoomNotifsState>;

    function room(roomId: string, state: RoomNotifs.RoomNotifState = RoomNotifState.AllMessages): Room {
        const result = new Room(roomId, client, "@userId:matrix.org");
        rooms.set(roomId, result);
        server.set(roomId, state);
        synced.set(roomId, state);
        return result;
    }

    const levelsIn = (rules?: IPushRules): Map<string, RoomNotifs.RoomNotifState> | undefined =>
        (rules as unknown as { levels: Map<string, RoomNotifs.RoomNotifState> } | undefined)?.levels;

    /** Bring a mute record through the sync, as written by this client or another device. */
    function receive(target: Room, content: Record<string, unknown>): void {
        records.set(target.roomId, content);
        syncRecord(target, content);
    }

    function syncRecord(target: Room, content: Record<string, unknown>): void {
        const event = new MatrixEvent({ type: MUTE_ACCOUNT_DATA_TYPE, content });
        target.addAccountData([event]);
        client.emit(RoomEvent.AccountData, event, target);
    }

    /** The sync brings the server's push rules. */
    function syncLevels(): void {
        for (const [roomId, state] of server) synced.set(roomId, state);
        client.emit(ClientEvent.AccountData, new MatrixEvent({ type: EventType.PushRules, content: {} }));
    }

    const lastRecord = (roomId: string): unknown =>
        [...vi.mocked(client.setRoomAccountData).mock.calls].reverse().find((call) => call[0] === roomId)?.[2];

    beforeEach(() => {
        vi.useFakeTimers({ now: 1_000_000 });
        client = createTestClient();
        rooms.clear();
        server = new Map();
        synced = new Map();
        records = new Map();
        holdSync = false;
        vi.mocked(client.getRooms).mockImplementation(() => [...rooms.values()]);
        vi.spyOn(RoomNotifs, "getRoomNotifsState").mockImplementation(
            (_client, roomId, rules) => (levelsIn(rules) ?? synced).get(roomId) ?? null,
        );
        fetchRules = vi
            .spyOn(serverCopy, "fetchPushRules")
            .mockImplementation(async () => ({ levels: new Map(server) }) as unknown as IPushRules);
        vi.spyOn(serverCopy, "fetchRoomAccountData").mockImplementation(async (_client, roomId) => ({
            ...records.get(roomId),
        }));
        setLevel = vi
            .spyOn(RoomNotifs, "setRoomNotifsState")
            .mockImplementation(async (_client, roomId, state, rules) => {
                // Unmuting deletes the mute rule found in the rules it starts from; with none there, nothing changes.
                const ownRule = rules?.global?.override?.some((rule) => rule.rule_id === roomId);
                const known = ownRule ? RoomNotifState.Mute : (levelsIn(rules) ?? synced).get(roomId);
                const unmutingUnknown = state !== RoomNotifState.Mute && known !== RoomNotifState.Mute;
                if (!(unmutingUnknown && server.get(roomId) === RoomNotifState.Mute)) server.set(roomId, state);
                if (!holdSync) queueMicrotask(syncLevels);
            });
        vi.mocked(client.setRoomAccountData).mockImplementation(async (roomId, _type, content) => {
            records.set(roomId, content as Record<string, unknown>);
            if (!holdSync) queueMicrotask(() => syncRecord(rooms.get(roomId)!, content as Record<string, unknown>));
            return {};
        });
        mutes = new TimedMutes();
    });

    afterEach(() => {
        mutes.stop();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("mutes a room for a while, writing how to end it before muting it", async () => {
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
        expect(server.get(general.roomId)).toBe(RoomNotifState.Mute);
        expect(mutes.mutedUntil(general)).toBe(1_000_000 + 60 * 60_000);
        expect(mutes.mutedBy(general)).toBe("channel");
        expect(changed).toHaveBeenCalledWith(general.roomId);
    });

    it("mutes until turned back on without an end", async () => {
        const general = room("!general:example.org");
        await mutes.mute([general], null);
        expect(lastRecord(general.roomId)).toEqual({ v: 1, restore: RoomNotifState.AllMessages, by: "channel" });
        expect(mutes.mutedUntil(general)).toBeUndefined();
    });

    it("really turns a room back on when it is unmuted right after being muted", async () => {
        const general = room("!general:example.org", RoomNotifState.MentionsOnly);
        void mutes.mute([general], null);
        await mutes.unmute([general]);
        expect(server.get(general.roomId)).toBe(RoomNotifState.MentionsOnly);
        expect(lastRecord(general.roomId)).toEqual({});
    });

    it("finds the rooms a server mute silenced right after it", async () => {
        const general = room("!general:example.org");
        void mutes.mute([general], null, "server");
        await mutes.unmute([general], "server");
        expect(server.get(general.roomId)).toBe(RoomNotifState.AllMessages);
        expect(lastRecord(general.roomId)).toEqual({});
    });

    it("gives the room its level back when the mute ends, then clears the record, once", async () => {
        const general = room("!general:example.org", RoomNotifState.Mute);
        receive(general, { v: 1, restore: RoomNotifState.AllMessagesLoud, by: "channel", until: 1_000_000 + 1_000 });
        mutes.watch(client);

        await vi.advanceTimersByTimeAsync(1_000);
        expect(server.get(general.roomId)).toBe(RoomNotifState.AllMessagesLoud);
        expect(lastRecord(general.roomId)).toEqual({});

        setLevel.mockClear();
        vi.mocked(client.setRoomAccountData).mockClear();
        await vi.advanceTimersByTimeAsync(120_000);
        expect(setLevel).not.toHaveBeenCalled();
        expect(client.setRoomAccountData).not.toHaveBeenCalled();
    });

    it("keeps the record and tries again when the server refuses the room's level", async () => {
        const general = room("!general:example.org", RoomNotifState.Mute);
        receive(general, { v: 1, restore: RoomNotifState.AllMessages, by: "channel", until: 1_000_000 + 1_000 });
        setLevel.mockRejectedValueOnce(new Error("offline"));
        mutes.watch(client);

        await vi.advanceTimersByTimeAsync(1_000);
        expect(client.setRoomAccountData).not.toHaveBeenCalled();
        expect(mutes.isMuted(general)).toBe(true);

        await vi.advanceTimersByTimeAsync(60_000);
        expect(server.get(general.roomId)).toBe(RoomNotifState.AllMessages);
        expect(lastRecord(general.roomId)).toEqual({});
    });

    it("ends a mute while the sync is slow, without ending it again until the sync catches up", async () => {
        const general = room("!general:example.org", RoomNotifState.Mute);
        receive(general, { v: 1, restore: RoomNotifState.AllMessages, by: "channel", until: 1_000_000 + 1_000 });
        mutes.watch(client);
        holdSync = true;

        await vi.advanceTimersByTimeAsync(1_000);
        expect(server.get(general.roomId)).toBe(RoomNotifState.AllMessages);
        expect(lastRecord(general.roomId)).toEqual({});

        // The synced record still shows the ended mute; the server's copy says it is over, so nothing is written.
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        expect(setLevel).toHaveBeenCalledTimes(1);
        expect(client.setRoomAccountData).toHaveBeenCalledTimes(1);
        expect(vi.mocked(serverCopy.fetchRoomAccountData).mock.calls.length).toBeLessThan(10);
    });

    it("doesn't end a mute that was extended while ending it waited its turn", async () => {
        const general = room("!general:example.org", RoomNotifState.Mute);
        receive(general, { v: 1, restore: RoomNotifState.AllMessages, by: "channel", until: 1_000_000 + 1_000 });
        mutes.watch(client);
        // An extension is being written as the old mute's time comes.
        holdSync = true;
        const extending = mutes.mute([general], 60 * 60_000);
        await vi.advanceTimersByTimeAsync(1_000);
        receive(general, { v: 1, restore: RoomNotifState.AllMessages, by: "channel", until: 1_000_000 + 60 * 60_000 });
        holdSync = false;
        await extending;
        await vi.advanceTimersByTimeAsync(0);
        expect(server.get(general.roomId)).toBe(RoomNotifState.Mute);
        expect(mutes.mutedUntil(general)).toBe(1_000_000 + 60 * 60_000);
    });

    it("ends other rooms' mutes on time while one waits for another try", async () => {
        const failing = room("!failing:example.org", RoomNotifState.Mute);
        const next = room("!next:example.org", RoomNotifState.Mute);
        receive(failing, { v: 1, restore: RoomNotifState.AllMessages, by: "channel", until: 1_000_000 + 1_000 });
        receive(next, { v: 1, restore: RoomNotifState.AllMessages, by: "channel", until: 1_000_000 + 6_000 });
        setLevel.mockRejectedValueOnce(new Error("offline"));
        mutes.watch(client);
        await vi.advanceTimersByTimeAsync(6_000);
        expect(server.get(next.roomId)).toBe(RoomNotifState.AllMessages);
        expect(server.get(failing.roomId)).toBe(RoomNotifState.Mute);
    });

    it("leaves a room the person turned back on themselves as it is when the mute ends", async () => {
        const general = room("!general:example.org", RoomNotifState.MentionsOnly);
        receive(general, { v: 1, restore: RoomNotifState.AllMessages, by: "channel", until: 1_000_000 + 1_000 });
        mutes.watch(client);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(setLevel).not.toHaveBeenCalled();
        expect(lastRecord(general.roomId)).toEqual({});
    });

    it("keeps a newer mute another device set while ending an old one", async () => {
        const general = room("!general:example.org", RoomNotifState.Mute);
        receive(general, { v: 1, restore: RoomNotifState.AllMessages, by: "channel", until: 1_000_000 + 1_000 });
        mutes.watch(client);
        setLevel.mockImplementationOnce(async (_client, roomId, state) => {
            receive(general, { v: 1, restore: RoomNotifState.AllMessages, by: "channel", until: 9_000_000 });
            server.set(roomId, state);
            queueMicrotask(syncLevels);
        });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(lastRecord(general.roomId)).toBeUndefined();
    });

    it("keeps rooms muted on their own out of a category or server mute", async () => {
        const own = room("!own:example.org", RoomNotifState.Mute);
        receive(own, { v: 1, restore: RoomNotifState.AllMessages, by: "channel" });
        const other = room("!other:example.org");
        await mutes.mute([own, other], 15 * 60_000, "server");
        expect(lastRecord(own.roomId)).toBeUndefined();
        expect(lastRecord(other.roomId)).toMatchObject({ by: "server" });

        await mutes.unmute([own, other], "server");
        expect(server.get(own.roomId)).toBe(RoomNotifState.Mute);
        expect(server.get(other.roomId)).toBe(RoomNotifState.AllMessages);
    });

    it("lets the person take over a room a server mute silenced", async () => {
        const general = room("!general:example.org", RoomNotifState.Mute);
        receive(general, { v: 1, restore: RoomNotifState.MentionsOnly, by: "server" });
        await mutes.mute([general], null, "channel");
        expect(lastRecord(general.roomId)).toEqual({ v: 1, restore: RoomNotifState.MentionsOnly, by: "channel" });
        expect(setLevel).not.toHaveBeenCalled();
    });

    it("ends a timed mute when the person picks another level for the room", async () => {
        const general = room("!general:example.org", RoomNotifState.Mute);
        receive(general, { v: 1, restore: RoomNotifState.AllMessages, by: "channel", until: 9_000_000 });
        await mutes.setLevel(general, RoomNotifState.MentionsOnly);
        expect(server.get(general.roomId)).toBe(RoomNotifState.MentionsOnly);
        expect(lastRecord(general.roomId)).toEqual({});
    });

    it("moves only the rooms at the given level, each when its turn comes", async () => {
        const follows = room("!follows:example.org");
        const own = room("!own:example.org", RoomNotifState.AllMessagesLoud);
        await mutes.moveLevel([follows, own], RoomNotifState.AllMessages, RoomNotifState.MentionsOnly);
        expect(server.get(follows.roomId)).toBe(RoomNotifState.MentionsOnly);
        expect(server.get(own.roomId)).toBe(RoomNotifState.AllMessagesLoud);

        // Moving back right away sees the first move, so the room really goes back.
        void mutes.moveLevel([follows], RoomNotifState.AllMessages, RoomNotifState.MentionsOnly);
        await mutes.moveLevel([follows], RoomNotifState.MentionsOnly, RoomNotifState.AllMessages);
        expect(server.get(follows.roomId)).toBe(RoomNotifState.AllMessages);
    });

    it("sees a mute the sync hasn't brought back yet", async () => {
        const general = room("!general:example.org", RoomNotifState.MentionsOnly);
        holdSync = true;
        const muting = mutes.mute([general], null);
        await mutes.unmute([general]);
        await muting;
        expect(server.get(general.roomId)).toBe(RoomNotifState.MentionsOnly);
        expect(lastRecord(general.roomId)).toEqual({});
    });

    it("isn't misled by a sync that brought only part of a mute", async () => {
        const general = room("!general:example.org", RoomNotifState.MentionsOnly);
        holdSync = true;
        await mutes.mute([general], null);
        // Muting removed the room rule and added the mute rule; the sync brought only the removal.
        synced.set(general.roomId, RoomNotifState.AllMessages);
        await mutes.unmute([general]);
        expect(server.get(general.roomId)).toBe(RoomNotifState.MentionsOnly);
        expect(lastRecord(general.roomId)).toEqual({});
    });

    it("takes another device's write as newer once the server keeps showing it", async () => {
        const general = room("!general:example.org");
        holdSync = true;
        await mutes.mute([general], null);
        records.set(general.roomId, {});
        const unmuting = mutes.unmute([general]);
        await vi.advanceTimersByTimeAsync(4_000);
        await unmuting;
        expect(server.get(general.roomId)).toBe(RoomNotifState.AllMessages);
    });

    it("fetches the push rules once for rooms changed together, and again after a room's own write", async () => {
        const general = room("!general:example.org");
        const random = room("!random:example.org");
        await mutes.mute([general, random], null);
        expect(fetchRules).toHaveBeenCalledTimes(1);
        await mutes.unmute([general, random]);
        expect(fetchRules).toHaveBeenCalledTimes(2);
        expect(server.get(general.roomId)).toBe(RoomNotifState.AllMessages);
        expect(server.get(random.roomId)).toBe(RoomNotifState.AllMessages);
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
        await vi.advanceTimersByTimeAsync(0);
        // The record's request is still on its way, but nobody waits for it any more.
        defaultDispatcher.dispatch({ action: Action.OnLoggedOut }, true);
        await expect(first).rejects.toBeInstanceOf(StoppedError);
        await expect(second).rejects.toBeInstanceOf(StoppedError);
        finish();
        await vi.advanceTimersByTimeAsync(0);
        expect(setLevel).not.toHaveBeenCalled();
        expect(client.setRoomAccountData).toHaveBeenCalledTimes(1);
    });

    it("reads again while the server's copy doesn't show its write yet", async () => {
        const general = room("!general:example.org", RoomNotifState.MentionsOnly);
        holdSync = true;
        await mutes.mute([general], null);
        // A worker serves the push rules and the record from before the mute twice, then catches up.
        const stale = { levels: new Map([[general.roomId, RoomNotifState.MentionsOnly]]) } as never;
        fetchRules.mockResolvedValueOnce(stale).mockResolvedValueOnce(stale);
        vi.mocked(serverCopy.fetchRoomAccountData).mockResolvedValueOnce({}).mockResolvedValueOnce({});

        const unmuting = mutes.unmute([general]);
        await vi.advanceTimersByTimeAsync(1_000);
        await unmuting;
        expect(server.get(general.roomId)).toBe(RoomNotifState.MentionsOnly);
        expect(lastRecord(general.roomId)).toEqual({});
        expect(fetchRules).toHaveBeenCalledTimes(1 + 3);
    });

    it("takes a level set elsewhere in this client once the server keeps showing it", async () => {
        const general = room("!general:example.org");
        holdSync = true;
        await mutes.mute([general], null);
        // The room's settings turn it to mentions only, without going through the timed mutes.
        server.set(general.roomId, RoomNotifState.MentionsOnly);
        const muting = mutes.mute([general], null);
        await vi.advanceTimersByTimeAsync(4_000);
        await muting;
        expect(server.get(general.roomId)).toBe(RoomNotifState.Mute);
        expect(lastRecord(general.roomId)).toMatchObject({ restore: RoomNotifState.MentionsOnly });
    });

    it("reads the server's copy at once when its own write is old", async () => {
        const general = room("!general:example.org");
        await mutes.mute([general], null);
        await vi.advanceTimersByTimeAsync(60_000);
        server.set(general.roomId, RoomNotifState.MentionsOnly);
        await mutes.mute([general], null);
        expect(server.get(general.roomId)).toBe(RoomNotifState.Mute);
        expect(fetchRules).toHaveBeenCalledTimes(2);
    });

    it("isn't misled by a lagging copy that matches what the sync shows from before", async () => {
        const general = room("!general:example.org", RoomNotifState.MentionsOnly);
        holdSync = true;
        await mutes.mute([general], null);
        const unmuting = mutes.unmute([general]);
        await vi.advanceTimersByTimeAsync(0);
        await unmuting;
        // The sync still shows mentions only from before; a lagging worker serves the mute once more.
        const stale = { levels: new Map([[general.roomId, RoomNotifState.Mute]]) } as never;
        fetchRules.mockResolvedValueOnce(stale);
        vi.mocked(serverCopy.fetchRoomAccountData).mockResolvedValueOnce({
            v: 1,
            restore: RoomNotifState.MentionsOnly,
            by: "channel",
        });
        const muting = mutes.mute([general], null);
        await vi.advanceTimersByTimeAsync(1_000);
        await muting;
        expect(server.get(general.roomId)).toBe(RoomNotifState.Mute);
        expect(lastRecord(general.roomId)).toEqual({ v: 1, restore: RoomNotifState.MentionsOnly, by: "channel" });
    });

    it("ends a mute another device extended as the old end came", async () => {
        const general = room("!general:example.org");
        mutes.watch(client);
        holdSync = true;
        await mutes.mute([general], 60_000);
        // The other device's extension reaches the server and the sync before the old end is handled.
        receive(general, { v: 1, restore: RoomNotifState.AllMessages, by: "channel", until: 1_000_000 + 60 * 60_000 });
        await vi.advanceTimersByTimeAsync(60_000 + 4_000);
        expect(server.get(general.roomId)).toBe(RoomNotifState.Mute);
        expect(records.get(general.roomId)).toMatchObject({ until: 1_000_000 + 60 * 60_000 });
    });

    it("reads the server's copy again after a write that failed", async () => {
        const general = room("!general:example.org");
        setLevel.mockRejectedValueOnce(new Error("offline"));
        await expect(mutes.mute([general], null)).rejects.toThrow("offline");
        await mutes.mute([general], null);
        expect(fetchRules).toHaveBeenCalledTimes(2);
        expect(server.get(general.roomId)).toBe(RoomNotifState.Mute);
    });

    it("changes a few rooms at a time", async () => {
        const many = Array.from({ length: 20 }, (_, i) => room(`!room${i}:example.org`));
        let running = 0;
        let most = 0;
        vi.mocked(client.setRoomAccountData).mockImplementation(async (roomId, _type, content) => {
            most = Math.max(most, ++running);
            await new Promise((resolve) => setTimeout(resolve, 10));
            running--;
            records.set(roomId, content as Record<string, unknown>);
            return {};
        });
        const muting = mutes.mute(many, null);
        await vi.advanceTimersByTimeAsync(1_000);
        await muting;
        expect(most).toBe(8);
        expect(many.every((target) => server.get(target.roomId) === RoomNotifState.Mute)).toBe(true);
    });

    it("ignores records it can't read", () => {
        const general = room("!general:example.org", RoomNotifState.Mute);
        receive(general, { v: 1, restore: "loud", until: "soon" });
        expect(mutes.mutedBy(general)).toBeUndefined();
        expect(mutes.mutedUntil(general)).toBeUndefined();
    });
});
