/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { EventType, MatrixEvent, Room, type MatrixClient } from "matrix-js-sdk/src/matrix";
import { stubClient } from "test-utils";

import { DeleteServerViewModel } from "./DeleteServerViewModel";
import { CallStore } from "../../stores/CallStore";
import { SDKContextClass } from "../../contexts/SDKContextClass";
import dispatcher from "../../dispatcher/dispatcher";
import { Action } from "../../dispatcher/actions";

const USER = "@alice:test";
const BOB = "@bob:remote";
const ROOM = "!room:test";
const SPACE = "!space:test";

const VOICE = "!voice:test";
const NESTED = "!nested:test";

describe("DeleteServerViewModel", () => {
    let client: MatrixClient;
    let vm: DeleteServerViewModel;
    let events: Map<string, MatrixEvent[]>;
    let rooms: Map<string, Room>;
    let operations: string[];
    const finished = vi.fn();

    function set(id: string, type: string, content: object, key = ""): void {
        const state = events.get(id) ?? [];
        events.set(id, [
            ...state.filter((event) => event.getType() !== type || event.getStateKey() !== key),
            new MatrixEvent({ type, state_key: key, room_id: id, sender: USER, content }),
        ]);
    }

    function link(parent: string, child: string): void {
        set(parent, EventType.SpaceChild, { via: ["test"] }, child);
        set(child, EventType.SpaceParent, { via: ["test"] }, parent);
    }

    async function load(): Promise<void> {
        vm = new DeleteServerViewModel({ client, space: rooms.get(SPACE)!, onFinished: finished });
        await vi.waitFor(() => expect(vm.getSnapshot().busy).toBe(false));
    }

    async function confirm(): Promise<void> {
        vm.setConfirmation(vm.getSnapshot().name);
        await vm.confirm();
    }

    beforeEach(() => {
        client = stubClient();
        client.roomState = vi.fn();
        client.forget = vi.fn();
        client.getJoinedRooms = vi.fn();
        vi.spyOn(client, "getSafeUserId").mockReturnValue(USER);
        events = new Map();
        rooms = new Map();
        operations = [];
        finished.mockClear();
        for (const id of [SPACE, ROOM, VOICE, NESTED]) {
            const type = [SPACE, NESTED].includes(id)
                ? "m.space"
                : id === VOICE
                  ? "org.matrix.msc3417.call"
                  : undefined;
            set(id, EventType.RoomCreate, { creator: USER, room_version: "11", type });
            set(id, EventType.RoomName, {
                name:
                    id === SPACE ? "Test server" : id === ROOM ? "general" : id === VOICE ? "Lounge" : "Nested server",
            });
            set(id, EventType.RoomMember, { membership: "join" }, USER);
            set(id, EventType.RoomMember, { membership: "join" }, BOB);
            set(id, EventType.RoomPowerLevels, { users: { [USER]: 100, [BOB]: 0 }, state_default: 50, kick: 50 });
            const room = new Room(id, client, USER);
            room.currentState.setStateEvents(events.get(id)!);
            room.name = events
                .get(id)!
                .find((event) => event.getType() === EventType.RoomName)!
                .getContent().name;
            room.updateMyMembership("join");
            rooms.set(id, room);
        }
        link(SPACE, ROOM);
        link(SPACE, NESTED);
        link(NESTED, VOICE);
        vi.spyOn(client, "getRoom").mockImplementation((id) => (id ? (rooms.get(id) ?? null) : null));
        vi.mocked(client.roomState).mockImplementation(
            async (id) => events.get(id)!.map((event) => event.event) as Awaited<ReturnType<MatrixClient["roomState"]>>,
        );
        vi.spyOn(client, "sendStateEvent").mockImplementation(async (id, type, content, key) => {
            operations.push(`${type}:${id}`);
            set(id, type, content, key);
            return { event_id: "$state" };
        });
        vi.spyOn(client, "kick").mockImplementation(async (id, user) => {
            operations.push(`kick:${id}`);
            set(id, EventType.RoomMember, { membership: "leave" }, user);
            return {};
        });
        vi.spyOn(client, "leave").mockImplementation(async (id) => {
            operations.push(`leave:${id}`);
            rooms.get(id)!.updateMyMembership("leave");
            return {};
        });
        vi.mocked(client.forget).mockImplementation(async (id) => {
            operations.push(`forget:${id}`);
            rooms.delete(id);
            return {};
        });
        vi.mocked(client.getJoinedRooms).mockImplementation(async () => ({
            joined_rooms: [...rooms.values()]
                .filter((room) => room.getMyMembership() === "join")
                .map((room) => room.roomId),
        }));
        vi.spyOn(CallStore.instance, "getActiveCall").mockReturnValue(null);
        vi.spyOn(SDKContextClass.instance.legacyCallHandler, "hangupOrReject").mockImplementation(() => {});
        vi.spyOn(SDKContextClass.instance.roomViewStore, "getRoomId").mockReturnValue(SPACE);
        vi.spyOn(dispatcher, "dispatch").mockImplementation(() => {});
    });

    afterEach(() => {
        vm?.dispose();
        vi.restoreAllMocks();
    });

    it("lists text, voice and nested servers without making changes", async () => {
        await load();
        expect(vm.getSnapshot()).toMatchObject({
            ready: true,
            rooms: [
                { id: ROOM, kind: "text" },
                { id: VOICE, kind: "voice" },
                { id: NESTED, kind: "space" },
            ],
        });
        expect(operations).toEqual([]);
    });

    it("locks every room, removes every member and link, then leaves the root last", async () => {
        await load();
        await confirm();
        expect(finished).toHaveBeenCalledOnce();
        expect(rooms.size).toBe(0);
        const firstKick = operations.findIndex((op) => op.startsWith("kick:"));
        expect(operations.slice(0, firstKick).filter((op) => op.startsWith(EventType.RoomPowerLevels))).toHaveLength(4);
        const firstLeave = operations.findIndex((op) => op.startsWith("leave:"));
        expect(operations.slice(0, firstLeave).filter((op) => op.startsWith("kick:"))).toHaveLength(4);
        expect(vi.mocked(client.leave).mock.calls.map(([id]) => id)).toEqual([ROOM, VOICE, NESTED, SPACE]);
        expect(client.sendStateEvent).toHaveBeenCalledWith(SPACE, EventType.SpaceChild, {}, ROOM);
        expect(client.sendStateEvent).toHaveBeenCalledWith(NESTED, EventType.SpaceChild, {}, VOICE);
        expect(dispatcher.dispatch).toHaveBeenCalledWith({ action: Action.ViewHomePage });
    });

    it("requires the exact server name and allows cancellation", async () => {
        await load();
        vm.setConfirmation("wrong");
        await vm.confirm();
        expect(operations).toEqual([]);
        vm.cancel();
        expect(finished).toHaveBeenCalledOnce();
    });

    it("blocks the whole operation if any channel has an administrator who cannot be kicked", async () => {
        set(VOICE, EventType.RoomPowerLevels, { users: { [USER]: 100, [BOB]: 100 } });
        await load();
        expect(vm.getSnapshot()).toMatchObject({ ready: false, error: expect.stringContaining("Lounge") });
        expect(operations).toEqual([]);
    });

    it("checks permissions again when the name is confirmed", async () => {
        await load();
        set(VOICE, EventType.RoomPowerLevels, { users: { [USER]: 0, [BOB]: 100 } });
        await confirm();
        expect(operations).toEqual([]);
        expect(vm.getSnapshot().error).toContain("Lounge");
    });

    it("retains the admin in every room after a failed kick, then resumes", async () => {
        await load();
        vi.mocked(client.kick).mockRejectedValueOnce(new Error("offline"));
        await confirm();
        expect(client.leave).not.toHaveBeenCalled();
        expect(vm.getSnapshot().error).toBeTruthy();
        await vm.confirm();
        expect(finished).toHaveBeenCalledOnce();
        expect(client.leave).toHaveBeenCalledTimes(4);
    });

    it("resumes after forgetting a channel fails, without leaving it twice", async () => {
        await load();
        vi.mocked(client.forget).mockRejectedValueOnce(new Error("offline"));
        await confirm();
        expect(rooms.get(SPACE)?.getMyMembership()).toBe("join");
        await vm.confirm();
        expect(finished).toHaveBeenCalledOnce();
        expect(vi.mocked(client.leave).mock.calls.filter(([id]) => id === ROOM)).toHaveLength(1);
    });

    it("deletes an empty server", async () => {
        set(SPACE, EventType.SpaceChild, {}, ROOM);
        set(SPACE, EventType.SpaceChild, {}, NESTED);
        await load();
        expect(vm.getSnapshot().rooms).toEqual([]);
        await confirm();
        expect(client.leave).toHaveBeenCalledWith(SPACE);
        expect(client.leave).toHaveBeenCalledOnce();
    });

    it("deduplicates shared rooms and handles cyclic server links", async () => {
        link(NESTED, ROOM);
        link(NESTED, SPACE);
        await load();
        expect(vm.getSnapshot().rooms).toHaveLength(3);
        await confirm();
        expect(finished).toHaveBeenCalledOnce();
        expect(client.leave).toHaveBeenCalledTimes(4);
        expect(client.sendStateEvent).toHaveBeenCalledWith(NESTED, EventType.SpaceChild, {}, SPACE);
    });

    it("stops before removing anyone if a new channel appeared during locking", async () => {
        await load();
        const send = vi.mocked(client.sendStateEvent).getMockImplementation()!;
        vi.mocked(client.sendStateEvent).mockImplementationOnce(async (id, type, content, key) => {
            link(SPACE, "!late:test");
            return send(id, type, content, key);
        });
        await confirm();
        expect(client.kick).not.toHaveBeenCalled();
        expect(client.leave).not.toHaveBeenCalled();
        expect(vm.getSnapshot().error).toBeTruthy();
    });

    it("allows permission-check failures to be retried without deleting anything", async () => {
        vi.mocked(client.roomState).mockRejectedValueOnce(new Error("offline"));
        await load();
        expect(vm.getSnapshot().ready).toBe(false);
        await vm.confirm();
        expect(vm.getSnapshot().ready).toBe(true);
        expect(operations).toEqual([]);
    });
});
