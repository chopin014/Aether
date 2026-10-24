/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";

import { selectPresenceRecipients, sharesJoinedRoom } from "./AetherPresenceRecipients";
import { MAX_RECIPIENTS, MAX_ROOM_MEMBERS } from "./aetherPresence";
import { makeFakeClient } from "../test/test-utils/aetherPresence";

const many = (n: number, prefix = "u"): string[] => Array.from({ length: n }, (_, i) => `@${prefix}${i}:example.org`);

describe("selectPresenceRecipients", () => {
    it("includes DM partners and members of small rooms, without duplicates, self or ignored users", () => {
        const client = makeFakeClient({
            direct: { "@dm:example.org": ["!dm"] },
            ignored: ["@ignored:example.org"],
            rooms: [
                { id: "!dm", members: ["@me:example.org", "@dm:example.org"] },
                {
                    id: "!a",
                    members: ["@me:example.org", "@dm:example.org", "@bob:example.org", "@ignored:example.org"],
                },
                { id: "!b", members: ["@bob:example.org", "@carol:example.org"] },
            ],
        });
        expect(selectPresenceRecipients(client).sort()).toEqual([
            "@bob:example.org",
            "@carol:example.org",
            "@dm:example.org",
        ]);
    });

    it("skips rooms above the member cap but keeps rooms exactly at it", () => {
        const client = makeFakeClient({
            rooms: [
                { id: "!big", members: many(MAX_ROOM_MEMBERS + 1, "big") },
                { id: "!edge", members: many(MAX_ROOM_MEMBERS, "edge") },
            ],
        });
        const result = selectPresenceRecipients(client);
        expect(result).toHaveLength(MAX_ROOM_MEMBERS);
        expect(result.every((id) => id.startsWith("@edge"))).toBe(true);
    });

    it("keeps a DM partner even when the only shared room is big", () => {
        const client = makeFakeClient({
            direct: { "@dm:example.org": ["!dm"] },
            rooms: [
                { id: "!dm", members: ["@me:example.org", "@dm:example.org"] },
                { id: "!big", members: [...many(80), "@dm:example.org"] },
            ],
        });
        expect(selectPresenceRecipients(client)).toEqual(["@dm:example.org"]);
    });

    it("ignores rooms the account has left and DM entries for rooms it is not in", () => {
        const client = makeFakeClient({
            direct: { "@gone:example.org": ["!old"] },
            rooms: [{ id: "!old", members: ["@gone:example.org"], myMembership: "leave" }],
        });
        expect(selectPresenceRecipients(client)).toEqual([]);
    });

    it("caps the total and keeps DM partners first", () => {
        const rooms = Array.from({ length: 10 }, (_, i) => ({ id: `!r${i}`, members: many(40, `r${i}_`) }));
        const client = makeFakeClient({
            direct: { "@dm:example.org": ["!dm"] },
            rooms: [{ id: "!dm", members: ["@dm:example.org"] }, ...rooms],
        });
        const result = selectPresenceRecipients(client);
        expect(result).toHaveLength(MAX_RECIPIENTS);
        expect(result[0]).toBe("@dm:example.org");
    });
});

describe("sharesJoinedRoom", () => {
    it("is true only for users joined in a room we have joined", () => {
        const client = makeFakeClient({
            rooms: [
                { id: "!a", members: ["@bob:example.org"] },
                { id: "!left", members: ["@eve:example.org"], myMembership: "leave" },
            ],
        });
        expect(sharesJoinedRoom(client, "@bob:example.org")).toBe(true);
        expect(sharesJoinedRoom(client, "@eve:example.org")).toBe(false);
        expect(sharesJoinedRoom(client, "@stranger:example.org")).toBe(false);
    });
});
