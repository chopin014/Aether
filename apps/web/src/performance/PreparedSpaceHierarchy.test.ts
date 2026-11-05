/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient, JoinRule, Room, RoomType } from "matrix-js-sdk/src/matrix";

import {
    getPreparedHierarchySummary,
    invalidatePreparedSpaceHierarchy,
    prepareSpaceHierarchy,
} from "./PreparedSpaceHierarchy";

const spaceId = "!space:example.org";

function setup() {
    const client = createClient({ baseUrl: "https://example.org", userId: "@alice:example.org" });
    const load = vi.spyOn(client, "getRoomHierarchy").mockResolvedValue({ rooms: [], next_batch: "next" });
    return { client, load };
}

describe("prepared Space hierarchy", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it("shares one bounded request without storing or joining a placeholder room", async () => {
        const { client, load } = setup();
        const pending = Promise.withResolvers<{ rooms: []; next_batch: string }>();
        load.mockReturnValue(pending.promise);
        const first = prepareSpaceHierarchy(client, spaceId);
        expect(prepareSpaceHierarchy(client, spaceId)).toBe(first);
        expect(load).toHaveBeenCalledExactlyOnceWith(spaceId, 20, undefined, false, undefined);
        expect(client.getRoom(spaceId)).toBeNull();
        expect(first.hierarchy.root.getMyMembership()).not.toBe("join");
        pending.resolve({ rooms: [], next_batch: "next" });
        await first.ready;
        const joined = new Room(spaceId, client, client.getSafeUserId());
        client.store.storeRoom(joined);
        expect(prepareSpaceHierarchy(client, spaceId)).toBe(first);
        expect(load).toHaveBeenCalledOnce();
        await first.hierarchy.load();
        expect(load).toHaveBeenLastCalledWith(spaceId, 20, undefined, false, "next");
    });

    it("keeps clients and Spaces independent", async () => {
        const first = setup();
        const second = setup();
        const a = prepareSpaceHierarchy(first.client, spaceId);
        const b = prepareSpaceHierarchy(second.client, spaceId);
        const c = prepareSpaceHierarchy(first.client, "!other:example.org");
        await Promise.all([a.ready, b.ready, c.ready]);
        expect(a).not.toBe(b);
        expect(a).not.toBe(c);
        expect(first.load).toHaveBeenCalledTimes(2);
        expect(second.load).toHaveBeenCalledOnce();
    });

    it("expires stale metadata and bounds the retained page count", async () => {
        vi.useFakeTimers();
        const { client, load } = setup();
        const first = prepareSpaceHierarchy(client, spaceId);
        await first.ready;
        vi.advanceTimersByTime(30_000);
        expect(prepareSpaceHierarchy(client, spaceId)).not.toBe(first);
        for (let i = 0; i < 8; i++) await prepareSpaceHierarchy(client, `!space${i}:example.org`).ready;
        const count = load.mock.calls.length;
        await prepareSpaceHierarchy(client, spaceId).ready;
        expect(load).toHaveBeenCalledTimes(count + 1);
    });

    it("retries failed preparation without letting an old failure discard its replacement", async () => {
        const { client, load } = setup();
        const failed = Promise.withResolvers<{ rooms: [] }>();
        load.mockReturnValueOnce(failed.promise);
        const first = prepareSpaceHierarchy(client, spaceId);
        invalidatePreparedSpaceHierarchy(client, spaceId);
        const second = prepareSpaceHierarchy(client, spaceId);
        failed.reject(new Error("unavailable"));
        await expect(first.ready).rejects.toThrow("unavailable");
        await second.ready;
        expect(prepareSpaceHierarchy(client, spaceId)).toBe(second);
        load.mockRejectedValueOnce(new Error("retry"));
        invalidatePreparedSpaceHierarchy(client, spaceId);
        await expect(prepareSpaceHierarchy(client, spaceId).ready).rejects.toThrow("retry");
        load.mockResolvedValue({ rooms: [] });
        await prepareSpaceHierarchy(client, spaceId).ready;
    });

    it("offers listed public metadata as a summary hint only after the page loads", async () => {
        vi.useFakeTimers();
        const { client, load } = setup();
        const childId = "!child:example.org";
        const pending = Promise.withResolvers<Awaited<ReturnType<typeof client.getRoomHierarchy>>>();
        load.mockReturnValue(pending.promise);
        const prepared = prepareSpaceHierarchy(client, spaceId);
        expect(getPreparedHierarchySummary(client, childId)).toBeUndefined();
        pending.resolve({
            rooms: [
                {
                    room_id: spaceId,
                    room_type: RoomType.Space,
                    name: "Community",
                    children_state: [
                        {
                            type: "m.space.child",
                            state_key: childId,
                            content: { via: ["example.org"] },
                            sender: "@alice:example.org",
                            origin_server_ts: 1,
                        },
                    ],
                    world_readable: false,
                    guest_can_join: false,
                    num_joined_members: 10,
                    join_rule: JoinRule.Public,
                },
                {
                    room_id: childId,
                    name: "Lobby",
                    topic: "Say hello",
                    children_state: [],
                    world_readable: false,
                    guest_can_join: false,
                    num_joined_members: 4,
                    join_rule: JoinRule.Public,
                },
            ],
        });
        await prepared.ready;
        const hint = getPreparedHierarchySummary(client, childId);
        expect(hint).toEqual({
            room_id: childId,
            name: "Lobby",
            topic: "Say hello",
            avatar_url: undefined,
            canonical_alias: undefined,
            num_joined_members: 4,
            world_readable: false,
            guest_can_join: false,
            room_type: undefined,
            join_rule: JoinRule.Public,
        });
        // Hints never claim membership or encryption: the summary must confirm both.
        expect(hint).not.toHaveProperty("membership");
        expect(getPreparedHierarchySummary(client, spaceId)?.room_type).toBe(RoomType.Space);
        expect(getPreparedHierarchySummary(setup().client, childId)).toBeUndefined();
        // Past its reuse lifetime the page still seeds previews, but not after the hint lifetime.
        vi.advanceTimersByTime(60_000);
        expect(getPreparedHierarchySummary(client, childId)?.name).toBe("Lobby");
        vi.advanceTimersByTime(5 * 60_000);
        expect(getPreparedHierarchySummary(client, childId)).toBeUndefined();
    });
});
