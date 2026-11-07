/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { EventType, KnownMembership, MatrixEvent, Room, RoomEvent, RoomStateEvent } from "matrix-js-sdk/src/matrix";
import { createTestClient } from "test-utils";

import { SPACE_CATEGORY_EVENT_TYPE } from "./SpaceLayout";
import { SPACE_SIDEBAR_ACCOUNT_DATA_TYPE, SpaceLayoutStore, SpaceLayoutStoreEvent } from "./SpaceLayoutStore";

const CATEGORY = "c_7e50cc0b-4fb5-4ed0-89db-769fb11c837e";

describe("SpaceLayoutStore", () => {
    let client: ReturnType<typeof createTestClient>;
    let space: Room;
    let store: SpaceLayoutStore;
    let changed: Mock<(spaceId: string) => void>;

    function stateEvent(type: string, stateKey: string, content: Record<string, unknown>, id = "$remote"): MatrixEvent {
        return new MatrixEvent({
            type,
            state_key: stateKey,
            room_id: space.roomId,
            sender: "@admin:example.org",
            event_id: id,
            content,
        });
    }

    /** Apply a state event the way a sync does, and tell the client about it. */
    function receive(event: MatrixEvent): void {
        space.currentState.setStateEvents([event]);
        client.emit(RoomStateEvent.Events, event, space.currentState, null);
    }

    beforeEach(() => {
        client = createTestClient();
        space = new Room("!space:example.org", client, "@userId:matrix.org");
        store = new SpaceLayoutStore();
        store.watch(client);
        changed = vi.fn();
        store.on(SpaceLayoutStoreEvent.Changed, changed);
    });

    afterEach(() => vi.restoreAllMocks());

    it("shows an edit at once and keeps it until the server's copy arrives", async () => {
        vi.mocked(client.sendStateEvent).mockResolvedValue({ event_id: "$mine" });
        const content = { v: 1, name: "Governo", order: "A" };
        const sending = store.send(space, SPACE_CATEGORY_EVENT_TYPE, CATEGORY, content);
        expect(store.reader(space).get(SPACE_CATEGORY_EVENT_TYPE, CATEGORY)).toEqual(content);
        expect(store.reader(space).keys(SPACE_CATEGORY_EVENT_TYPE)).toEqual([CATEGORY]);
        expect(changed).toHaveBeenCalledWith(space.roomId);
        await sending;
        expect(client.sendStateEvent).toHaveBeenCalledWith(space.roomId, SPACE_CATEGORY_EVENT_TYPE, content, CATEGORY);
        expect(store.reader(space).get(SPACE_CATEGORY_EVENT_TYPE, CATEGORY)).toEqual(content);

        receive(stateEvent(SPACE_CATEGORY_EVENT_TYPE, CATEGORY, { v: 1, name: "Server copy", order: "A" }, "$mine"));
        expect(store.reader(space).get(SPACE_CATEGORY_EVENT_TYPE, CATEGORY)).toMatchObject({ name: "Server copy" });
    });

    it("drops an edit whose event the sync brought back before the request finished", async () => {
        vi.mocked(client.sendStateEvent).mockImplementation(async () => {
            space.currentState.setStateEvents([stateEvent(SPACE_CATEGORY_EVENT_TYPE, CATEGORY, { v: 1 }, "$mine")]);
            return { event_id: "$mine" };
        });
        await store.send(space, SPACE_CATEGORY_EVENT_TYPE, CATEGORY, { v: 1, name: "Echo" });
        expect(store.reader(space).get(SPACE_CATEGORY_EVENT_TYPE, CATEGORY)).toEqual({ v: 1 });
    });

    it("keeps an edit being sent when someone else's arrives first", async () => {
        let finish!: (value: { event_id: string }) => void;
        vi.mocked(client.sendStateEvent).mockReturnValue(new Promise((resolve) => (finish = resolve)));
        const sending = store.send(space, SPACE_CATEGORY_EVENT_TYPE, CATEGORY, { v: 1, name: "Mine" });
        receive(stateEvent(SPACE_CATEGORY_EVENT_TYPE, CATEGORY, { v: 1, name: "Theirs" }));
        expect(store.reader(space).get(SPACE_CATEGORY_EVENT_TYPE, CATEGORY)).toMatchObject({ name: "Mine" });
        finish({ event_id: "$mine" });
        await sending;
    });

    it("gives way to a newer edit that arrived after ours while the request was running", async () => {
        let finish!: (value: { event_id: string }) => void;
        vi.mocked(client.sendStateEvent).mockReturnValue(new Promise((resolve) => (finish = resolve)));
        const sending = store.send(space, SPACE_CATEGORY_EVENT_TYPE, CATEGORY, { v: 1, name: "Mine" });
        receive(stateEvent(SPACE_CATEGORY_EVENT_TYPE, CATEGORY, { v: 1, name: "Mine" }, "$mine"));
        receive(stateEvent(SPACE_CATEGORY_EVENT_TYPE, CATEGORY, { v: 1, name: "Theirs, later" }, "$theirs"));
        finish({ event_id: "$mine" });
        await sending;
        expect(store.reader(space).get(SPACE_CATEGORY_EVENT_TYPE, CATEGORY)).toMatchObject({ name: "Theirs, later" });
    });

    it("leaves the next client's edits alone when the previous client's request ends", async () => {
        let fail!: (error: Error) => void;
        vi.mocked(client.sendStateEvent).mockReturnValue(new Promise((_resolve, reject) => (fail = reject)));
        const old = store.send(space, SPACE_CATEGORY_EVENT_TYPE, CATEGORY, { v: 1, name: "Old client" });

        const next = createTestClient();
        vi.mocked(next.sendStateEvent).mockReturnValue(new Promise(() => {}));
        store.watch(next);
        const nextSpace = new Room(space.roomId, next, "@userId:matrix.org");
        void store.send(nextSpace, SPACE_CATEGORY_EVENT_TYPE, CATEGORY, { v: 1, name: "New client" });

        fail(new Error("logged out"));
        await expect(old).rejects.toThrow("logged out");
        expect(store.reader(nextSpace).get(SPACE_CATEGORY_EVENT_TYPE, CATEGORY)).toMatchObject({ name: "New client" });
    });

    it("undoes an edit the server refuses", async () => {
        vi.mocked(client.sendStateEvent).mockRejectedValue(new Error("M_FORBIDDEN"));
        await expect(store.send(space, SPACE_CATEGORY_EVENT_TYPE, CATEGORY, { v: 1, name: "No" })).rejects.toThrow(
            "M_FORBIDDEN",
        );
        expect(store.reader(space).get(SPACE_CATEGORY_EVENT_TYPE, CATEGORY)).toBeUndefined();
        expect(changed).toHaveBeenCalledTimes(2);
    });

    it("announces changes to the layout, the Space's channels and its permissions only", () => {
        receive(stateEvent(SPACE_CATEGORY_EVENT_TYPE, CATEGORY, { v: 1 }));
        receive(stateEvent(EventType.SpaceChild, "!channel:example.org", { via: ["example.org"] }));
        receive(stateEvent(EventType.RoomPowerLevels, "", {}));
        receive(stateEvent(EventType.RoomTopic, "", { topic: "Unrelated" }));
        expect(changed).toHaveBeenCalledTimes(3);
    });

    it("lets only joined members who may send all layout events edit", () => {
        const maySend = vi.spyOn(space.currentState, "maySendStateEvent").mockReturnValue(true);
        const membership = vi.spyOn(space, "getMyMembership").mockReturnValue(KnownMembership.Join);
        expect(store.canEditLayout(space)).toBe(true);
        maySend.mockImplementation((type) => type !== SPACE_CATEGORY_EVENT_TYPE);
        expect(store.canEditLayout(space)).toBe(false);
        maySend.mockReturnValue(true);
        membership.mockReturnValue(KnownMembership.Leave);
        expect(store.canEditLayout(space)).toBe(false);
    });

    describe("hiding muted channels", () => {
        function setAccountData(content: Record<string, unknown>): void {
            const event = new MatrixEvent({ type: SPACE_SIDEBAR_ACCOUNT_DATA_TYPE, content });
            space.addAccountData([event]);
            client.emit(RoomEvent.AccountData, event, space);
        }

        it("reads the person's preference for the server", () => {
            expect(store.isHidingMutedChannels(space)).toBe(false);
            setAccountData({ v: 1, hide_muted: true });
            expect(store.isHidingMutedChannels(space)).toBe(true);
            expect(changed).toHaveBeenCalledWith(space.roomId);
        });

        it("applies a change at once and saves it with the other preferences", async () => {
            setAccountData({ v: 1, hide_muted: false, other: "kept" });
            vi.mocked(client.setRoomAccountData).mockResolvedValue({});
            const saving = store.setHidingMutedChannels(space, true);
            expect(store.isHidingMutedChannels(space)).toBe(true);
            await saving;
            expect(client.setRoomAccountData).toHaveBeenCalledWith(space.roomId, SPACE_SIDEBAR_ACCOUNT_DATA_TYPE, {
                v: 1,
                hide_muted: true,
                other: "kept",
            });
            setAccountData({ v: 1, hide_muted: true });
            expect(store.isHidingMutedChannels(space)).toBe(true);
        });

        it("goes back when the change can't be saved", async () => {
            vi.mocked(client.setRoomAccountData).mockRejectedValue(new Error("offline"));
            await expect(store.setHidingMutedChannels(space, true)).rejects.toThrow("offline");
            expect(store.isHidingMutedChannels(space)).toBe(false);
        });
    });

    it("forgets edits and stops listening when another client takes over", () => {
        const other = createTestClient();
        vi.mocked(client.sendStateEvent).mockReturnValue(new Promise(() => {}));
        void store.send(space, SPACE_CATEGORY_EVENT_TYPE, CATEGORY, { v: 1, name: "Pending" });
        store.watch(other);
        expect(store.reader(space).get(SPACE_CATEGORY_EVENT_TYPE, CATEGORY)).toBeUndefined();
        changed.mockClear();
        receive(stateEvent(SPACE_CATEGORY_EVENT_TYPE, CATEGORY, { v: 1 }));
        expect(changed).not.toHaveBeenCalled();
    });
});
