/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import { KnownMembership, type MatrixClient, type Room, RoomType } from "matrix-js-sdk/src/matrix";

import { joinChannels, listJoinableChannels, type ServerChannel } from "./serverChannels";

const SPACE = "!space:x";

const child = (roomId: string, order?: string, suggested = false, ts = 1) => ({
    type: "m.space.child",
    state_key: roomId,
    sender: "@admin:x",
    origin_server_ts: ts,
    content: { via: ["x"], order, suggested },
});

const entry = (roomId: string, extra: Record<string, unknown> = {}) => ({
    room_id: roomId,
    name: roomId.slice(1, roomId.indexOf(":")),
    num_joined_members: 3,
    world_readable: false,
    guest_can_join: false,
    children_state: [],
    ...extra,
});

function makeClient(pages: { rooms: unknown[]; next_batch?: string }[], joined: string[] = []): MatrixClient {
    const getRoomHierarchy = vi.fn();
    for (const page of pages) getRoomHierarchy.mockResolvedValueOnce(page);
    return {
        getRoomHierarchy,
        getRoom: (roomId: string) =>
            joined.includes(roomId) ? ({ getMyMembership: () => KnownMembership.Join } as Room) : null,
        joinRoom: vi.fn(),
    } as unknown as MatrixClient;
}

describe("listJoinableChannels", () => {
    it("lists joinable channels in the server's order, across pages", async () => {
        const client = makeClient(
            [
                {
                    rooms: [
                        entry(SPACE, {
                            room_type: RoomType.Space,
                            children_state: [
                                child("!voice:x", "b"),
                                child("!general:x", "a", true),
                                child("!sub:x", "c"),
                                child("!secret:x", "d"),
                                child("!members:x", "e"),
                                child("!others:x", "f"),
                                child("!joined:x", "g"),
                                child("!late:x", "h"),
                                child("!missing:x", "i"),
                            ],
                        }),
                        entry("!voice:x", { room_type: RoomType.UnstableCall, join_rule: "restricted" }),
                        entry("!general:x", { join_rule: "public", topic: "Say hi" }),
                        entry("!sub:x", { room_type: RoomType.Space }),
                        entry("!secret:x", { join_rule: "invite" }),
                        entry("!members:x", { join_rule: "restricted", allowed_room_ids: [SPACE] }),
                        entry("!others:x", { join_rule: "restricted", allowed_room_ids: ["!elsewhere:x"] }),
                        entry("!joined:x"),
                    ],
                    next_batch: "next",
                },
                { rooms: [entry("!late:x", { room_type: RoomType.ElementVideo })] },
            ],
            ["!joined:x"],
        );

        const channels = await listJoinableChannels(client, SPACE);

        expect(client.getRoomHierarchy).toHaveBeenNthCalledWith(2, SPACE, 50, 1, false, "next");
        expect(channels.map((channel) => [channel.roomId, channel.kind])).toEqual([
            ["!general:x", "text"],
            ["!voice:x", "voice"],
            ["!members:x", "text"],
            ["!late:x", "voice"],
        ]);
        expect(channels[0]).toEqual({
            roomId: "!general:x",
            name: "general",
            kind: "text",
            topic: "Say hi",
            memberCount: 3,
            suggested: true,
            via: ["x"],
        });
    });

    it("returns nothing when the hierarchy leaves out the server", async () => {
        const client = makeClient([{ rooms: [] }]);
        await expect(listJoinableChannels(client, SPACE)).resolves.toEqual([]);
    });
});

describe("joinChannels", () => {
    const channel = (roomId: string): ServerChannel => ({
        roomId,
        name: roomId,
        kind: "text",
        memberCount: 1,
        suggested: false,
        via: ["x"],
    });

    it("joins every channel, keeps the server's order and reports failures", async () => {
        const client = makeClient([]);
        vi.mocked(client.joinRoom).mockImplementation(async (roomId) => {
            if (roomId === "!b") throw new Error("forbidden");
            if (roomId === "!a") await new Promise((resolve) => setTimeout(resolve, 5));
            return {} as Room;
        });
        const channels = ["!a", "!b", "!c", "!d", "!e"].map(channel);

        const result = await joinChannels(client, channels, 2);

        expect(result.joined).toEqual(["!a", "!c", "!d", "!e"]);
        expect(result.failed).toEqual([channels[1]]);
        expect(client.joinRoom).toHaveBeenCalledWith("!a", { viaServers: ["x"] });
    });

    it("does nothing for no channels", async () => {
        const client = makeClient([]);
        await expect(joinChannels(client, [])).resolves.toEqual({ joined: [], failed: [] });
    });
});
