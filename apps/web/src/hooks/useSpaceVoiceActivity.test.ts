/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

// oxlint-disable-next-line no-restricted-imports
import { EventEmitter } from "events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "test-utils-rtl";
import { type MatrixClient, type Room, type RoomMember } from "matrix-js-sdk/src/matrix";

import { useSpaceVoiceActivity } from "./useSpaceVoiceActivity";
import { CallStore, CallStoreEvent } from "../stores/CallStore";
import { type Call, CallEvent } from "../models/Call";
import { type SDKContextClass } from "../contexts/SDKContextClass";

function member(userId: string, name: string): RoomMember {
    return { userId, name, getMxcAvatarUrl: () => undefined } as unknown as RoomMember;
}

function room(roomId: string, name: string, voice: boolean): Room {
    return { roomId, name, isCallRoom: () => voice, isElementVideoRoom: () => false } as unknown as Room;
}

describe("useSpaceVoiceActivity", () => {
    const space = room("!space:example.org", "Terra do boi gordo", false);
    const rooms = [
        room("!geral:example.org", "geral", false),
        room("!lounge:example.org", "Lounge", true),
        room("!quiet:example.org", "Quiet", true),
        room("!arena:example.org", "Arena", true),
    ];
    const client = {
        getRoom: (roomId: string) => rooms.find((candidate) => candidate.roomId === roomId) ?? null,
    } as unknown as MatrixClient;
    let roomIds: string[];
    const spaceStore = Object.assign(new EventEmitter(), {
        getSpaceFilteredRoomIds: () => new Set(roomIds),
    });
    const sdkContext = { client, spaceStore } as unknown as SDKContextClass;
    let calls: Map<string, EventEmitter & { participants: Map<RoomMember, unknown> }>;

    beforeEach(() => {
        roomIds = rooms.map((candidate) => candidate.roomId);
        calls = new Map([
            ["!lounge:example.org", Object.assign(new EventEmitter(), { participants: new Map() })],
            ["!quiet:example.org", Object.assign(new EventEmitter(), { participants: new Map() })],
            [
                "!arena:example.org",
                Object.assign(new EventEmitter(), {
                    participants: new Map([[member("@bob:example.org", "Bob"), {}]]),
                }),
            ],
        ]);
        calls.get("!lounge:example.org")!.participants.set(member("@carol:example.org", "carol"), {});
        calls.get("!lounge:example.org")!.participants.set(member("@alice:example.org", "Alice"), {});
        vi.spyOn(CallStore.instance, "getCall").mockImplementation(
            (roomId) => (calls.get(roomId) as unknown as Call) ?? null,
        );
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("lists only the voice channels with people in them, by name", () => {
        const { result } = renderHook(() => useSpaceVoiceActivity(sdkContext, space));
        expect(result.current).toEqual([
            { roomId: "!arena:example.org", name: "Arena", people: [expect.objectContaining({ name: "Bob" })] },
            {
                roomId: "!lounge:example.org",
                name: "Lounge",
                people: [expect.objectContaining({ name: "Alice" }), expect.objectContaining({ name: "carol" })],
            },
        ]);
    });

    it("follows people joining and leaving, and calls starting", () => {
        const { result, unmount } = renderHook(() => useSpaceVoiceActivity(sdkContext, space));
        const quiet = calls.get("!quiet:example.org")!;
        act(() => {
            quiet.participants.set(member("@dave:example.org", "Dave"), {});
            quiet.emit(CallEvent.Participants);
        });
        expect(result.current.map((channel) => channel.name)).toEqual(["Arena", "Lounge", "Quiet"]);

        act(() => {
            calls.delete("!arena:example.org");
            CallStore.instance.emit(CallStoreEvent.Call);
        });
        expect(result.current.map((channel) => channel.name)).toEqual(["Lounge", "Quiet"]);

        unmount();
        expect(quiet.listenerCount(CallEvent.Participants)).toBe(0);
    });

    it("catches up once the Space's rooms are known", () => {
        roomIds = [];
        const { result, unmount } = renderHook(() => useSpaceVoiceActivity(sdkContext, space));
        expect(result.current).toEqual([]);
        act(() => {
            roomIds = rooms.map((candidate) => candidate.roomId);
            spaceStore.emit(space.roomId);
        });
        expect(result.current.map((channel) => channel.name)).toEqual(["Arena", "Lounge"]);
        unmount();
        expect(spaceStore.listenerCount(space.roomId)).toBe(0);
    });

    it("does nothing without a Space", () => {
        const { result } = renderHook(() => useSpaceVoiceActivity(sdkContext, undefined));
        expect(result.current).toEqual([]);
        expect(CallStore.instance.getCall).not.toHaveBeenCalled();
    });
});
