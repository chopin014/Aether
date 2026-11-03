/*
Copyright 2024 New Vector Ltd.
Copyright 2022 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// @vitest-environment happy-dom

import { EventType, type IContent, type MatrixClient, MatrixEvent, Room, User } from "matrix-js-sdk/src/matrix";
import { KnownMembership } from "matrix-js-sdk/src/types";
import { vi, describe, it, expect, beforeEach } from "vitest";
import { stubClient, TestSDKContext } from "test-utils";

import SdkConfig from "../SdkConfig";
import SettingsStore from "../settings/SettingsStore";
import { MemberListStore } from "./MemberListStore";

describe("MemberListStore", () => {
    const alice = "@alice:bar";
    const bob = "@bob:bar";
    const charlie = "@charlie:bar";
    const roomId = "!foo:bar";
    let store: MemberListStore;
    let client: MatrixClient;
    let room: Room;

    beforeEach(() => {
        const context = new TestSDKContext();
        client = stubClient();
        client.baseUrl = "https://invalid.base.url.here";
        context._client = client;
        store = new MemberListStore(context);
        // alice is joined to the room.
        room = new Room(roomId, client, client.getUserId()!);
        room.currentState.setStateEvents([
            new MatrixEvent({
                type: EventType.RoomCreate,
                state_key: "",
                content: {
                    creator: alice,
                },
                sender: alice,
                room_id: roomId,
                event_id: "$1",
            }),
            new MatrixEvent({
                type: EventType.RoomMember,
                state_key: alice,
                content: {
                    membership: KnownMembership.Join,
                },
                sender: alice,
                room_id: roomId,
                event_id: "$2",
            }),
        ]);
        room.recalculate();
        vi.mocked(client.getRoom).mockImplementation((r: string | undefined): Room | null => {
            if (r === roomId) {
                return room;
            }
            return null;
        });
        SdkConfig.put({
            enable_presence_by_hs_url: {
                [client.baseUrl]: false,
            },
        });
    });

    it("loads members in a room", async () => {
        addMember(room, bob, KnownMembership.Invite);
        addMember(room, charlie, KnownMembership.Leave);

        const { invited, joined } = await store.loadMemberList(roomId);
        expect(invited).toEqual([room.getMember(bob)]);
        expect(joined).toEqual([room.getMember(alice)]);
    });

    it("fails gracefully for invalid rooms", async () => {
        const { invited, joined } = await store.loadMemberList("!idontexist:bar");
        expect(invited).toEqual([]);
        expect(joined).toEqual([]);
    });

    it("sorts by power level", async () => {
        addMember(room, bob, KnownMembership.Join);
        addMember(room, charlie, KnownMembership.Join);
        setPowerLevels(room, {
            users: {
                [alice]: 100,
                [charlie]: 50,
            },
            users_default: 10,
        });

        const { invited, joined } = await store.loadMemberList(roomId);
        expect(invited).toEqual([]);
        expect(joined).toEqual([room.getMember(alice), room.getMember(charlie), room.getMember(bob)]);
    });

    it("sorts by name if power level is equal", async () => {
        const doris = "@doris:bar";
        addMember(room, bob, KnownMembership.Join);
        addMember(room, charlie, KnownMembership.Join);
        setPowerLevels(room, {
            users_default: 10,
        });

        let { invited, joined } = await store.loadMemberList(roomId);
        expect(invited).toEqual([]);
        expect(joined).toEqual([room.getMember(alice), room.getMember(bob), room.getMember(charlie)]);

        // Ensure it sorts by display name if they are set
        addMember(room, doris, KnownMembership.Join, "AAAAA");
        ({ invited, joined } = await store.loadMemberList(roomId));
        expect(invited).toEqual([]);
        expect(joined).toEqual([
            room.getMember(doris),
            room.getMember(alice),
            room.getMember(bob),
            room.getMember(charlie),
        ]);
    });

    it("reads presence configuration once per sort, including a changed setting on refresh", async () => {
        addMember(room, bob, KnownMembership.Join);
        addMember(room, charlie, KnownMembership.Join);
        for (const member of room.getMembers()) member.user = new User(member.userId);
        const presence = vi.spyOn(store, "isPresenceEnabled").mockReturnValueOnce(false).mockReturnValueOnce(true);
        await store.loadMemberList(roomId);
        expect(presence).toHaveBeenCalledTimes(1);
        await store.loadMemberList(roomId);
        expect(presence).toHaveBeenCalledTimes(2);
    });

    it("filters based on a search query", async () => {
        const mice = "@mice:bar";
        const zorro = "@zorro:bar";
        addMember(room, bob, KnownMembership.Join);
        addMember(room, mice, KnownMembership.Join);

        let { invited, joined } = await store.loadMemberList(roomId, "ice");
        expect(invited).toEqual([]);
        expect(joined).toEqual([room.getMember(alice), room.getMember(mice)]);

        // Ensure it filters by display name if they are set
        addMember(room, zorro, KnownMembership.Join, "ice ice baby");
        ({ invited, joined } = await store.loadMemberList(roomId, "ice"));
        expect(invited).toEqual([]);
        expect(joined).toEqual([room.getMember(alice), room.getMember(zorro), room.getMember(mice)]);
    });

    describe("lazy loading", () => {
        beforeEach(() => {
            vi.mocked(client.hasLazyLoadMembersEnabled).mockReturnValue(true);
            room.loadMembersIfNeeded = vi.fn();
            vi.mocked(room.loadMembersIfNeeded).mockResolvedValue(true);
        });

        it("calls Room.loadMembersIfNeeded once when enabled", async () => {
            let { joined } = await store.loadMemberList(roomId);
            expect(joined).toEqual([room.getMember(alice)]);
            expect(room.loadMembersIfNeeded).toHaveBeenCalledTimes(1);
            ({ joined } = await store.loadMemberList(roomId));
            expect(joined).toEqual([room.getMember(alice)]);
            expect(room.loadMembersIfNeeded).toHaveBeenCalledTimes(1);
        });

        it("retries storage-backed member hydration after a failed attempt", async () => {
            vi.mocked(room.loadMembersIfNeeded).mockRejectedValueOnce(new Error("Offline"));
            await expect(store.ensureMembersLoaded(roomId)).rejects.toThrow("Offline");
            await store.ensureMembersLoaded(roomId);
            expect(room.loadMembersIfNeeded).toHaveBeenCalledTimes(2);
        });
    });

    describe("sliding sync", () => {
        beforeEach(() => {
            vi.spyOn(SettingsStore, "getValue").mockImplementation((settingName, roomId, value) => {
                return settingName === "feature_simplified_sliding_sync"; // this is enabled, everything else is disabled.
            });
            client.members = vi.fn();
        });

        it("shares an in-flight roster request across refreshes and applies each search separately", async () => {
            const response = Promise.withResolvers<Awaited<ReturnType<MatrixClient["members"]>>>();
            vi.mocked(client.members).mockReturnValue(response.promise);
            const sdkLoad = vi.spyOn(room, "loadMembersIfNeeded");
            const hydration = store.ensureMembersLoaded(roomId);
            const all = store.loadMemberList(roomId);
            const filtered = store.loadMemberList(roomId, "bob");
            await vi.waitFor(() => expect(client.members).toHaveBeenCalledTimes(1));
            response.resolve({
                chunk: [
                    {
                        type: EventType.RoomMember,
                        state_key: bob,
                        sender: bob,
                        room_id: roomId,
                        event_id: "$bob",
                        origin_server_ts: 0,
                        content: { membership: KnownMembership.Join, displayname: "Bob" },
                    },
                ],
            });
            await hydration;
            expect(sdkLoad).not.toHaveBeenCalled();
            expect((await all).joined).toContain(room.getMember(bob));
            expect((await filtered).joined).toEqual([room.getMember(bob)]);
            await store.loadMemberList(roomId);
            expect(client.members).toHaveBeenCalledTimes(1);
        });

        it("shares a failed roster request and retries on the next refresh", async () => {
            const response = Promise.withResolvers<Awaited<ReturnType<MatrixClient["members"]>>>();
            vi.mocked(client.members).mockReturnValueOnce(response.promise).mockResolvedValue({ chunk: [] });
            const markFailed = vi.spyOn(room.currentState, "markOutOfBandMembersFailed");
            const results = Promise.allSettled([store.ensureMembersLoaded(roomId), store.ensureMembersLoaded(roomId)]);
            await vi.waitFor(() => expect(client.members).toHaveBeenCalledTimes(1));
            response.reject(new Error("Offline"));
            expect((await results).map((result) => result.status)).toEqual(["rejected", "rejected"]);
            expect(markFailed).toHaveBeenCalledTimes(1);
            await store.loadMemberList(roomId);
            expect(client.members).toHaveBeenCalledTimes(2);
        });

        it("shows known members on failure and retries on refresh", async () => {
            vi.mocked(client.members).mockRejectedValueOnce(new Error("Offline")).mockResolvedValue({ chunk: [] });
            expect((await store.loadMemberList(roomId)).joined).toEqual([room.getMember(alice)]);
            await store.loadMemberList(roomId);
            expect(client.members).toHaveBeenCalledTimes(2);
        });

        it("hydrates a replacement Room with the same ID instead of reusing another session's cache", async () => {
            vi.mocked(client.members).mockResolvedValue({ chunk: [] });
            await store.ensureMembersLoaded(roomId);
            room = new Room(roomId, client, client.getUserId()!);
            await store.ensureMembersLoaded(roomId);
            expect(client.members).toHaveBeenCalledTimes(2);
        });

        it("does not share an in-flight hydration with a replacement Room", async () => {
            const firstResponse = Promise.withResolvers<Awaited<ReturnType<MatrixClient["members"]>>>();
            vi.mocked(client.members).mockReturnValueOnce(firstResponse.promise).mockResolvedValue({ chunk: [] });
            const first = store.ensureMembersLoaded(roomId);
            await vi.waitFor(() => expect(client.members).toHaveBeenCalledTimes(1));
            room = new Room(roomId, client, client.getUserId()!);
            await store.ensureMembersLoaded(roomId);
            expect(client.members).toHaveBeenCalledTimes(2);
            firstResponse.resolve({ chunk: [] });
            await first;
        });

        it("calls /members when lazy loading", async () => {
            vi.mocked(client.members).mockResolvedValue({
                chunk: [
                    {
                        type: EventType.RoomMember,
                        state_key: bob,
                        content: {
                            membership: KnownMembership.Join,
                            displayname: "Bob",
                        },
                        sender: bob,
                        room_id: room.roomId,
                        event_id: "$" + Math.random(),
                        origin_server_ts: 2,
                    },
                ],
            });
            const { joined } = await store.loadMemberList(roomId);
            expect(joined).toEqual([room.getMember(alice), room.getMember(bob)]);
            expect(client.members).toHaveBeenCalled();
        });

        it("does not use lazy loading on encrypted rooms", async () => {
            vi.spyOn(client.getCrypto()!, "isEncryptionEnabledInRoom").mockResolvedValue(true);

            const { joined } = await store.loadMemberList(roomId);
            expect(joined).toEqual([room.getMember(alice)]);
            expect(client.members).not.toHaveBeenCalled();
        });
    });
});

function addEventToRoom(room: Room, ev: MatrixEvent) {
    room.getLiveTimeline().addEvent(ev, {
        toStartOfTimeline: false,
        addToState: true,
    });
}

function setPowerLevels(room: Room, pl: IContent) {
    addEventToRoom(
        room,
        new MatrixEvent({
            type: EventType.RoomPowerLevels,
            state_key: "",
            content: pl,
            sender: room.getCreator()!,
            room_id: room.roomId,
            event_id: "$" + Math.random(),
        }),
    );
}

function addMember(room: Room, userId: string, membership: string, displayName?: string) {
    addEventToRoom(
        room,
        new MatrixEvent({
            type: EventType.RoomMember,
            state_key: userId,
            content: {
                membership: membership,
                displayname: displayName,
            },
            sender: userId,
            room_id: room.roomId,
            event_id: "$" + Math.random(),
        }),
    );
}
