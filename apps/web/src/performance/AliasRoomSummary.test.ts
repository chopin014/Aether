/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient, JoinRule, type RoomSummary } from "matrix-js-sdk/src/matrix";

import { prefetchAliasPreview, prefetchAliasSummary, takeAliasLookup, takeAliasSummary } from "./AliasRoomSummary";

const alias = "#lobby:example.org";
const roomId = "!lobby:example.org";
const summary: RoomSummary = {
    room_id: roomId,
    join_rule: JoinRule.Public,
    num_joined_members: 3,
    world_readable: false,
    guest_can_join: false,
};

function setup() {
    const client = createClient({ baseUrl: "https://example.org", userId: "@alice:example.org" });
    const request = vi.spyOn(client, "getRoomSummary").mockResolvedValue(summary);
    const lookup = vi
        .spyOn(client, "getRoomIdForAlias")
        .mockResolvedValue({ room_id: roomId, servers: ["example.org"] });
    return { client, request, lookup };
}

describe("alias room summaries", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it("requests the summary by alias and hands it over once for the resolved room", async () => {
        const { client, request } = setup();
        prefetchAliasSummary(client, alias, ["example.org"]);
        expect(request).toHaveBeenCalledExactlyOnceWith(alias, ["example.org"]);
        await expect(takeAliasSummary(client, alias, roomId)).resolves.toBe(summary);
        expect(takeAliasSummary(client, alias, roomId)).toBeUndefined();
    });

    it("rejects a summary describing a different room than the alias resolved to", async () => {
        const { client } = setup();
        prefetchAliasSummary(client, alias);
        await expect(takeAliasSummary(client, alias, "!moved:example.org")).resolves.toBeUndefined();
    });

    it("treats request failures, expiry and other clients as missing", async () => {
        vi.useFakeTimers();
        const { client, request } = setup();
        request.mockRejectedValueOnce(new Error("unavailable"));
        prefetchAliasSummary(client, alias);
        await expect(takeAliasSummary(client, alias, roomId)).resolves.toBeUndefined();
        prefetchAliasSummary(client, alias);
        expect(takeAliasSummary(setup().client, alias, roomId)).toBeUndefined();
        vi.advanceTimersByTime(30_000);
        expect(takeAliasSummary(client, alias, roomId)).toBeUndefined();
    });

    it("keeps a bounded number of pending aliases", async () => {
        const { client } = setup();
        for (let i = 0; i < 9; i++) prefetchAliasSummary(client, `#room${i}:example.org`);
        expect(takeAliasSummary(client, "#room0:example.org", roomId)).toBeUndefined();
        await expect(takeAliasSummary(client, "#room8:example.org", roomId)).resolves.toBe(summary);
    });

    it("resolves an opened alias and its summary together and hands each over once", async () => {
        const { client, request, lookup } = setup();
        prefetchAliasPreview(client, alias);
        expect(lookup).toHaveBeenCalledExactlyOnceWith(alias);
        expect(request).toHaveBeenCalledExactlyOnceWith(alias, undefined);
        await expect(takeAliasLookup(client, alias)).resolves.toEqual({ room_id: roomId, servers: ["example.org"] });
        expect(takeAliasLookup(client, alias)).toBeUndefined();
        await expect(takeAliasSummary(client, alias, roomId)).resolves.toBe(summary);
    });

    it("reports a failed early lookup to the caller that takes it", async () => {
        vi.useFakeTimers();
        const { client, lookup } = setup();
        lookup.mockRejectedValueOnce(new Error("unknown alias"));
        prefetchAliasPreview(client, alias);
        await expect(takeAliasLookup(client, alias)).rejects.toThrow("unknown alias");
        prefetchAliasPreview(client, alias);
        vi.advanceTimersByTime(30_000);
        expect(takeAliasLookup(client, alias)).toBeUndefined();
        expect(takeAliasLookup(setup().client, alias)).toBeUndefined();
    });
});
