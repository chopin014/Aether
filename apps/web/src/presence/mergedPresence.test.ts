/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";

import { mergePresence } from "./mergedPresence";

const NOW = 1_700_000_000_000;
const MIN = 60_000;
const signal = (presence: "online" | "unavailable" | "busy" | "offline", ageMs = MIN, expired = false) => ({
    presence,
    lastSeen: NOW - ageMs,
    expired,
});

describe("mergePresence", () => {
    it("returns nothing when there is no evidence", () => {
        expect(mergePresence({ now: NOW })).toBeNull();
    });

    it("lets real server presence win over everything", () => {
        expect(
            mergePresence({ server: "offline", aether: signal("online"), lastActive: NOW - 1000, now: NOW }),
        ).toEqual({ state: "offline", source: "server" });
    });

    it("prefers an Aether signal over seen activity", () => {
        expect(mergePresence({ aether: signal("unavailable"), lastActive: NOW - 1000, now: NOW })).toEqual({
            state: "unavailable",
            source: "aether",
        });
        // Invisible stays offline even if the user is seen typing.
        expect(mergePresence({ aether: signal("offline"), lastActive: NOW, now: NOW })).toEqual({
            state: "offline",
            source: "aether",
        });
    });

    it("shows an expired Aether signal as offline with when it was last seen", () => {
        const result = mergePresence({ aether: signal("offline", 15 * MIN, true), now: NOW });
        expect(result).toEqual({ state: "offline", source: "aether", label: "Offline · last seen 15m ago" });
    });

    it("prefers activity seen after an expired signal, but not before it", () => {
        const expired = signal("offline", 20 * MIN, true);
        expect(mergePresence({ aether: expired, lastActive: NOW - 2 * MIN, now: NOW })?.source).toBe("activity");
        expect(mergePresence({ aether: expired, lastActive: NOW - 40 * MIN, now: NOW })?.source).toBe("aether");
    });

    it.each([
        [0, "online", "Active now"],
        [4 * MIN, "online", "Active 4m ago"],
        [12 * MIN, "unavailable", "Active 12m ago"],
        [3 * 60 * MIN, "offline", "Last active 3h ago"],
    ])("classifies activity %i ms old as %s and labels it as activity", (age, state, label) => {
        expect(mergePresence({ lastActive: NOW - age, now: NOW })).toEqual({ state, source: "activity", label });
    });
});
