/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { EventType, MatrixEvent, Room, RoomEvent, type MatrixClient } from "matrix-js-sdk/src/matrix";
import { stubClient } from "test-utils";

import { DeleteChannelViewModel } from "./DeleteChannelViewModel";
import { canDeleteChannel } from "../../utils/room/canDeleteChannel";
import { CallStore } from "../../stores/CallStore";
import { SDKContextClass } from "../../contexts/SDKContextClass";
import dispatcher from "../../dispatcher/dispatcher";
import { Action } from "../../dispatcher/actions";

const USER = "@alice:test";
const BOB = "@bob:remote";
const ROOM = "!room:test";
const SPACE = "!space:test";

describe("DeleteChannelViewModel", () => {
    let client: MatrixClient;
    let vm: DeleteChannelViewModel;
    let room: Room;
    let space: Room;
    let events: Map<string, MatrixEvent[]>;
    let operations: string[];
    const finished = vi.fn();

    function set(id: string, type: string, content: object, key = ""): void {
        const state = events.get(id) ?? [];
        events.set(id, [
            ...state.filter((event) => event.getType() !== type || event.getStateKey() !== key),
            new MatrixEvent({ type, state_key: key, room_id: id, sender: USER, content }),
        ]);
    }

    function snapshot(id: string): Room {
        const result = new Room(id, client, USER);
        result.currentState.setStateEvents(events.get(id)!);
        return result;
    }

    beforeEach(() => {
        client = stubClient();
        client.roomState = vi.fn();
        client.forget = vi.fn();
        client.getJoinedRooms = vi.fn();
        vi.spyOn(client, "getSafeUserId").mockReturnValue(USER);
        operations = [];
        events = new Map();
        for (const id of [ROOM, SPACE]) {
            set(id, EventType.RoomCreate, {
                creator: USER,
                room_version: "11",
                ...(id === SPACE ? { type: "m.space" } : {}),
            });
            set(id, EventType.RoomMember, { membership: "join" }, USER);
            set(id, EventType.RoomPowerLevels, { users: { [USER]: 100, [BOB]: 0 }, state_default: 50, kick: 50 });
        }
        set(ROOM, EventType.RoomMember, { membership: "join" }, BOB);
        set(ROOM, EventType.SpaceParent, { via: ["test"] }, SPACE);
        set(SPACE, EventType.SpaceChild, { via: ["test"] }, ROOM);
        room = snapshot(ROOM);
        room.updateMyMembership("join");
        vi.spyOn(client, "getRoom").mockReturnValue(room);
        space = snapshot(SPACE);
        vi.spyOn(client, "roomState").mockImplementation(
            async (id) => events.get(id)!.map((event) => event.event) as Awaited<ReturnType<MatrixClient["roomState"]>>,
        );
        vi.spyOn(client, "sendStateEvent").mockImplementation(async (id, type, content, key) => {
            operations.push(type);
            set(id, type, content, key);
            return { event_id: "$state" };
        });
        vi.spyOn(client, "kick").mockImplementation(async (id, user) => {
            operations.push(`kick:${user}`);
            set(id, EventType.RoomMember, { membership: "leave" }, user);
            return {};
        });
        vi.spyOn(client, "leave").mockImplementation(async () => {
            operations.push("leave");
            room.updateMyMembership("leave");
            return {};
        });
        vi.spyOn(client, "forget").mockImplementation(async () => {
            operations.push("forget");
            return {};
        });
        vi.spyOn(client, "getJoinedRooms").mockResolvedValue({ joined_rooms: [ROOM, SPACE] });
        vi.spyOn(CallStore.instance, "getActiveCall").mockReturnValue(null);
        vi.spyOn(SDKContextClass.instance.legacyCallHandler, "hangupOrReject").mockImplementation(() => {});
        vi.spyOn(dispatcher, "dispatch").mockImplementation(() => {});
        finished.mockClear();
        vm = new DeleteChannelViewModel({ room, space, client, onFinished: finished });
    });

    afterEach(() => {
        vm?.dispose();
        vi.restoreAllMocks();
    });

    it("should close joins and invites, remove members, unlink, then leave and forget", async () => {
        expect(canDeleteChannel(room, space, USER)).toBe(true);
        await vm.confirm();
        expect(operations).toEqual([
            EventType.RoomPowerLevels,
            EventType.RoomJoinRules,
            `kick:${BOB}`,
            EventType.SpaceParent,
            EventType.SpaceChild,
            "leave",
            "forget",
        ]);
        expect(client.sendStateEvent).toHaveBeenCalledWith(ROOM, EventType.RoomJoinRules, { join_rule: "invite" }, "");
        expect(finished).toHaveBeenCalledOnce();
    });

    it.each(["invite", "knock"])("should revoke %s memberships before leaving", async (membership) => {
        set(ROOM, EventType.RoomMember, { membership }, "@invited:test");
        await vm.confirm();
        expect(client.kick).toHaveBeenCalledWith(ROOM, "@invited:test", expect.any(String));
        expect(client.leave).toHaveBeenCalledOnce();
    });

    it("should clear third-party invitation tokens", async () => {
        set(ROOM, EventType.RoomThirdPartyInvite, { public_key: "key" }, "token");
        await vm.confirm();
        expect(client.sendStateEvent).toHaveBeenCalledWith(ROOM, EventType.RoomThirdPartyInvite, {}, "token");
    });

    it.each([100, 101])("should reject a member with power %s before any mutation", async (level) => {
        set(ROOM, EventType.RoomPowerLevels, { users: { [USER]: 100, [BOB]: level } });
        expect(canDeleteChannel(snapshot(ROOM), space, USER)).toBe(false);
        await vm.confirm();
        expect(operations).toEqual([]);
        expect(vm.getSnapshot().error).toBeTruthy();
        expect(finished).not.toHaveBeenCalled();
    });

    it("should require server directory permissions as well as room permissions", async () => {
        set(SPACE, EventType.RoomPowerLevels, { users: { [USER]: 0 }, state_default: 50 });
        await vm.confirm();
        expect(operations).toEqual([]);
    });

    it("should stop and keep the administrator joined when a kick fails, then allow retry", async () => {
        vi.mocked(client.kick).mockRejectedValueOnce(new Error("offline"));
        await vm.confirm();
        expect(client.leave).not.toHaveBeenCalled();
        expect(client.forget).not.toHaveBeenCalled();
        expect(vm.getSnapshot()).toMatchObject({ busy: false, left: false, error: expect.any(String) });
        await vm.confirm();
        expect(client.leave).toHaveBeenCalledOnce();
        expect(finished).toHaveBeenCalledOnce();
    });

    it("should retain the administrator when unlinking fails", async () => {
        const send = vi.mocked(client.sendStateEvent).getMockImplementation()!;
        vi.mocked(client.sendStateEvent).mockImplementation(async (...args) => {
            if (args[1] === EventType.SpaceChild) throw new Error("forbidden");
            return send(...args);
        });
        await vm.confirm();
        expect(client.leave).not.toHaveBeenCalled();
    });

    it("should not leave when someone is still joined after the removals", async () => {
        vi.mocked(client.kick).mockResolvedValue({});
        await vm.confirm();
        expect(client.leave).not.toHaveBeenCalled();
        expect(client.sendStateEvent).not.toHaveBeenCalledWith(SPACE, EventType.SpaceChild, {}, ROOM);
    });

    it("should retry only forgetting after leave succeeded", async () => {
        vi.mocked(client.forget).mockRejectedValueOnce(new Error("offline"));
        await vm.confirm();
        expect(vm.getSnapshot().left).toBe(true);
        await vm.confirm();
        expect(client.leave).toHaveBeenCalledOnce();
        expect(client.kick).toHaveBeenCalledOnce();
        expect(client.forget).toHaveBeenCalledTimes(2);
        expect(finished).toHaveBeenCalledOnce();
    });

    it("should recover when the server processed leave but its response was lost", async () => {
        vi.mocked(client.leave).mockRejectedValueOnce(new Error("connection lost"));
        await vm.confirm();
        vi.mocked(client.getJoinedRooms).mockResolvedValue({ joined_rooms: [SPACE] });
        room.updateMyMembership("leave");
        await vm.confirm();
        expect(client.leave).toHaveBeenCalledOnce();
        expect(client.forget).toHaveBeenCalledOnce();
    });

    it("should recover when unlinking succeeded but its response was lost", async () => {
        const send = vi.mocked(client.sendStateEvent).getMockImplementation()!;
        vi.mocked(client.sendStateEvent).mockImplementation(async (id, type, content, key) => {
            const response = await send(id, type, content, key);
            if (id === SPACE && type === EventType.SpaceChild) throw new Error("response lost");
            return response;
        });
        await vm.confirm();
        expect(client.leave).not.toHaveBeenCalled();
        expect(canDeleteChannel(snapshot(ROOM), snapshot(SPACE), USER)).toBe(false);
        vi.mocked(client.sendStateEvent).mockImplementation(send);
        await vm.confirm();
        expect(client.leave).toHaveBeenCalledOnce();
        expect(finished).toHaveBeenCalledOnce();
    });

    it("should support v12 creators without sending infinite power levels", async () => {
        set(ROOM, EventType.RoomCreate, { room_version: "12" });
        expect(snapshot(ROOM).getMember(USER)?.powerLevel).toBe(Infinity);
        await vm.confirm();
        expect(client.leave).toHaveBeenCalledOnce();
        const levels = vi.mocked(client.sendStateEvent).mock.calls[0][2];
        expect(JSON.stringify(levels)).not.toContain("null");
        expect(levels).toMatchObject({ invite: Number.MAX_SAFE_INTEGER });
    });

    it("should not offer deletion when another v12 creator cannot be kicked", () => {
        set(ROOM, EventType.RoomCreate, { room_version: "12", additional_creators: [BOB] });
        expect(canDeleteChannel(snapshot(ROOM), space, USER)).toBe(false);
    });

    it("should include members who joined while the channel was being locked", async () => {
        const send = vi.mocked(client.sendStateEvent).getMockImplementation()!;
        vi.mocked(client.sendStateEvent).mockImplementationOnce(async (id, type, content, key) => {
            set(ROOM, EventType.RoomMember, { membership: "join" }, "@late:remote");
            return send(id, type, content, key);
        });
        await vm.confirm();
        expect(client.kick).toHaveBeenCalledWith(ROOM, "@late:remote", expect.any(String));
        expect(client.leave).toHaveBeenCalledOnce();
    });

    it("should stop before removing members if closing the channel fails", async () => {
        vi.mocked(client.sendStateEvent).mockRejectedValueOnce(new Error("forbidden"));
        await vm.confirm();
        expect(client.kick).not.toHaveBeenCalled();
        expect(client.leave).not.toHaveBeenCalled();
        expect(vm.getSnapshot().error).toBeTruthy();
    });

    it("should disconnect the active voice call before leaving", async () => {
        const disconnect = vi.fn(async () => {
            operations.push("disconnect");
        });
        vi.mocked(CallStore.instance.getActiveCall).mockReturnValue({ disconnect } as never);
        await vm.confirm();
        expect(operations.indexOf("disconnect")).toBeLessThan(operations.indexOf("leave"));
    });

    it("should navigate away from the deleted channel before forgetting it", async () => {
        vi.spyOn(SDKContextClass.instance.roomViewStore, "getRoomId").mockReturnValue(ROOM);
        vi.mocked(client.forget).mockImplementation(async () => {
            expect(dispatcher.dispatch).toHaveBeenCalledWith({
                action: Action.ViewRoom,
                room_id: SPACE,
                metricsTrigger: undefined,
            });
            return {};
        });
        await vm.confirm();
        expect(finished).toHaveBeenCalledOnce();
    });

    it("should wait for the leave sync before forgetting so the room is not added again", async () => {
        vi.mocked(client.leave).mockResolvedValue({});
        room.updateMyMembership("join");
        const confirmation = vm.confirm();
        await vi.waitFor(() => expect(vm.getSnapshot().left).toBe(true));
        expect(client.forget).not.toHaveBeenCalled();
        room.updateMyMembership("leave");
        client.emit(RoomEvent.MyMembership, room, "leave", "join");
        await confirmation;
        expect(client.forget).toHaveBeenCalledOnce();
        expect(finished).toHaveBeenCalledOnce();
    });

    it("should allow retry when the leave sync times out without leaving twice", async () => {
        vi.useFakeTimers();
        try {
            vi.mocked(client.leave).mockResolvedValue({});
            room.updateMyMembership("join");
            const confirmation = vm.confirm();
            await vi.waitFor(() => expect(vm.getSnapshot().left).toBe(true));
            await vi.advanceTimersByTimeAsync(30_000);
            await confirmation;
            expect(client.forget).not.toHaveBeenCalled();
            expect(vm.getSnapshot()).toMatchObject({ left: true, busy: false, error: expect.any(String) });

            room.updateMyMembership("leave");
            await vm.confirm();
            expect(client.leave).toHaveBeenCalledOnce();
            expect(finished).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });

    it("should prevent duplicate submissions and dismissal while busy", async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        vi.mocked(client.roomState).mockImplementationOnce(async () => {
            await gate;
            return events.get(ROOM)!.map((event) => event.event) as Awaited<ReturnType<MatrixClient["roomState"]>>;
        });
        const first = vm.confirm();
        await vm.confirm();
        vm.cancel();
        expect(finished).not.toHaveBeenCalled();
        release();
        await first;
        expect(client.leave).toHaveBeenCalledOnce();
    });

    it("should dismiss without changing the room when cancelled", () => {
        vm.cancel();
        expect(operations).toEqual([]);
        expect(finished).toHaveBeenCalledOnce();
    });
});
