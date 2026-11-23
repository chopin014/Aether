/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    EventType,
    KnownMembership,
    type MatrixClient,
    MatrixEvent,
    type Room,
    RoomEvent,
    RoomStateEvent,
    TypedEventEmitter,
} from "matrix-js-sdk/src/matrix";

import { UnjoinedChannelsStore, UnjoinedChannelsStoreEvent } from "./UnjoinedChannelsStore";
import { listServerChildren, type ServerChannel, type ServerChildren } from "../../utils/servers/serverChannels";

vi.mock("../../utils/servers/serverChannels", () => ({ listServerChildren: vi.fn() }));

const SPACE = "!space:example.org";

const channel = (roomId: string): ServerChannel => ({
    roomId,
    name: roomId,
    kind: "text",
    memberCount: 1,
    suggested: false,
    via: ["example.org"],
});

describe("UnjoinedChannelsStore", () => {
    let client: MatrixClient;
    let rooms: Map<string, Room>;
    let store: UnjoinedChannelsStore;
    let changed: string[];

    const room = (roomId: string, membership: string, children: string[] = []): Room => {
        const created = {
            roomId,
            getMyMembership: () => membership,
            currentState: {
                getStateEvents: (type: string, stateKey: string) =>
                    type === EventType.SpaceChild && children.includes(stateKey) ? {} : null,
            },
        } as unknown as Room;
        rooms.set(roomId, created);
        return created;
    };

    const spaceChildEvent = (spaceId: string): MatrixEvent =>
        new MatrixEvent({ type: EventType.SpaceChild, state_key: "!new:example.org", room_id: spaceId, content: {} });

    beforeEach(() => {
        vi.useFakeTimers();
        rooms = new Map();
        client = Object.assign(new TypedEventEmitter(), {
            getRoom: (roomId: string) => rooms.get(roomId) ?? null,
        }) as unknown as MatrixClient;
        vi.mocked(listServerChildren).mockReset();
        vi.mocked(listServerChildren).mockResolvedValue({
            channels: [channel("!a:example.org"), channel("!b:example.org")],
            subservers: [channel("!sub:example.org")],
        });
        store = new UnjoinedChannelsStore();
        store.watch(client);
        changed = [];
        store.on(UnjoinedChannelsStoreEvent.Changed, (spaceId) => changed.push(spaceId));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("looks a server's channels up when first asked, then answers from what it found", async () => {
        expect(store.getChannels(SPACE)).toEqual([]);
        await vi.runAllTimersAsync();
        expect(changed).toEqual([SPACE]);
        expect(store.getChannels(SPACE).map((c) => c.roomId)).toEqual(["!a:example.org", "!b:example.org"]);
        expect(store.getSubservers(SPACE).map((c) => c.roomId)).toEqual(["!sub:example.org"]);
        expect(listServerChildren).toHaveBeenCalledTimes(1);
        expect(listServerChildren).toHaveBeenCalledWith(client, SPACE);
    });

    it("asks once while a lookup is running, and again once the list is old", async () => {
        store.getChannels(SPACE);
        store.getChannels(SPACE);
        await vi.runAllTimersAsync();
        expect(listServerChildren).toHaveBeenCalledTimes(1);

        vi.setSystemTime(Date.now() + 6 * 60_000);
        store.getChannels(SPACE);
        await vi.runAllTimersAsync();
        expect(listServerChildren).toHaveBeenCalledTimes(2);
    });

    it("leaves out channels the user was banned from, but keeps ones they joined for the room list to replace", async () => {
        store.getChannels(SPACE);
        await vi.runAllTimersAsync();
        room("!a:example.org", KnownMembership.Ban);
        room("!b:example.org", KnownMembership.Join);
        expect(store.getChannels(SPACE).map((c) => c.roomId)).toEqual(["!b:example.org"]);
    });

    it("looks a shown server up again when its channels change, once for changes arriving together", async () => {
        store.getChannels(SPACE);
        await vi.runAllTimersAsync();
        client.emit(RoomStateEvent.Events, spaceChildEvent(SPACE), {} as never, null);
        client.emit(RoomStateEvent.Events, spaceChildEvent(SPACE), {} as never, null);
        client.emit(RoomStateEvent.Events, spaceChildEvent("!never-shown:example.org"), {} as never, null);
        await vi.runAllTimersAsync();
        expect(listServerChildren).toHaveBeenCalledTimes(2);
        expect(listServerChildren).not.toHaveBeenCalledWith(client, "!never-shown:example.org");
    });

    it("updates when a listed channel is joined, and looks the server up when one of its channels is left", async () => {
        room(SPACE, KnownMembership.Join, ["!left:example.org"]);
        store.getChannels(SPACE);
        await vi.runAllTimersAsync();
        changed = [];

        client.emit(RoomEvent.MyMembership, room("!a:example.org", KnownMembership.Join), KnownMembership.Join);
        expect(changed).toEqual([SPACE]);
        expect(listServerChildren).toHaveBeenCalledTimes(1);

        const left = room("!left:example.org", KnownMembership.Leave);
        client.emit(RoomEvent.MyMembership, left, KnownMembership.Leave, KnownMembership.Join);
        await vi.runAllTimersAsync();
        expect(listServerChildren).toHaveBeenCalledTimes(2);

        // Leaving a room that isn't one of the server's channels changes nothing.
        const elsewhere = room("!elsewhere:example.org", KnownMembership.Leave);
        client.emit(RoomEvent.MyMembership, elsewhere, KnownMembership.Leave, KnownMembership.Join);
        await vi.runAllTimersAsync();
        expect(listServerChildren).toHaveBeenCalledTimes(2);
    });

    it("keeps what it knew when a lookup fails, and waits before trying again", async () => {
        store.getChannels(SPACE);
        await vi.runAllTimersAsync();
        vi.setSystemTime(Date.now() + 6 * 60_000);
        vi.mocked(listServerChildren).mockRejectedValueOnce(new Error("offline"));
        store.getChannels(SPACE);
        await vi.runAllTimersAsync();

        expect(store.getChannels(SPACE)).toHaveLength(2);
        await vi.runAllTimersAsync();
        expect(listServerChildren).toHaveBeenCalledTimes(2);
    });

    it("drops everything for a new client, including lookups still running for the old one", async () => {
        let finish!: (children: ServerChildren) => void;
        vi.mocked(listServerChildren).mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
        store.getChannels(SPACE);
        const next = Object.assign(new TypedEventEmitter(), { getRoom: () => null }) as unknown as MatrixClient;
        store.watch(next);
        finish({ channels: [channel("!old:example.org")], subservers: [] });
        await vi.runAllTimersAsync();
        expect(changed).toEqual([]);

        expect(store.getChannels(SPACE)).toEqual([]);
        await vi.runAllTimersAsync();
        expect(store.getChannels(SPACE).map((c) => c.roomId)).toEqual(["!a:example.org", "!b:example.org"]);
        // The old client's events no longer reach the store.
        client.emit(RoomStateEvent.Events, spaceChildEvent(SPACE), {} as never, null);
        await vi.runAllTimersAsync();
        expect(listServerChildren).toHaveBeenCalledTimes(2);
    });
});
