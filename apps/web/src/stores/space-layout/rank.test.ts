/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";

import { compareRanks, isValidRank, MAX_RANK_LENGTH, rankBetween, virtualChannelRank } from "./rank";

describe("rank", () => {
    it("accepts keys of letters and digits that do not end in the lowest digit", () => {
        expect(isValidRank("a")).toBe(true);
        expect(isValidRank("M0V")).toBe(true);
        expect(isValidRank("a0")).toBe(false);
        expect(isValidRank("")).toBe(false);
        expect(isValidRank("a-b")).toBe(false);
        expect(isValidRank(42)).toBe(false);
        expect(isValidRank("a".repeat(MAX_RANK_LENGTH + 1))).toBe(false);
    });

    it("compares by character codes, not by locale", () => {
        expect(compareRanks("Z", "a")).toBe(-1);
        expect(compareRanks("a", "Z")).toBe(1);
        expect(compareRanks("b", "b")).toBe(0);
    });

    it.each([
        [undefined, undefined],
        [undefined, "V"],
        ["V", undefined],
        ["V", "k"],
        ["V", "W"],
        ["a", "a1"],
        ["0V", "1"],
        ["z", undefined],
        [undefined, "01"],
        ["M01", "M02"],
    ])("makes a valid key strictly between %s and %s", (before, after) => {
        const rank = rankBetween(before, after);
        expect(isValidRank(rank)).toBe(true);
        if (before !== undefined) expect(compareRanks(before, rank)).toBe(-1);
        if (after !== undefined) expect(compareRanks(rank, after)).toBe(-1);
    });

    it("keeps finding room when items are inserted at the same spot many times", () => {
        let low = "V";
        const high = "W";
        for (let i = 0; i < 200; i++) {
            const next = rankBetween(low, high);
            expect(compareRanks(low, next)).toBe(-1);
            expect(compareRanks(next, high)).toBe(-1);
            low = next;
        }
        expect(low.length).toBeLessThan(250);
    });

    it("refuses keys that are equal or out of order", () => {
        expect(() => rankBetween("b", "b")).toThrow();
        expect(() => rankBetween("c", "b")).toThrow();
    });

    it("orders unplaced channels by their Space order, then by room id", () => {
        const ordered = [
            virtualChannelRank("a", "!z:example.org"),
            virtualChannelRank("ab", "!a:example.org"),
            virtualChannelRank("b", "!a:example.org"),
            virtualChannelRank(undefined, "!a:example.org", 5),
            virtualChannelRank(undefined, "!a:example.org"),
            virtualChannelRank(undefined, "!b:example.org"),
        ];
        for (const rank of ordered) expect(isValidRank(rank)).toBe(true);
        expect([...ordered].sort(compareRanks)).toEqual(ordered);
    });

    it("orders unplaced channels without a Space order by when they were created", () => {
        const ordered = [
            virtualChannelRank("z", "!z:example.org", 1),
            virtualChannelRank(undefined, "!z:example.org", 9),
            virtualChannelRank(undefined, "!a:example.org", 10),
            virtualChannelRank(undefined, "!b:example.org", 1_700_000_000_000),
            virtualChannelRank(undefined, "!a:example.org"),
        ];
        for (const rank of ordered) expect(isValidRank(rank)).toBe(true);
        expect([...ordered].sort(compareRanks)).toEqual(ordered);
        // A creation time that isn't a whole, positive number is treated as unknown.
        expect(virtualChannelRank(undefined, "!a:example.org", -1)).toBe(
            virtualChannelRank(undefined, "!a:example.org"),
        );
    });

    it("leaves room before and after an unplaced channel's key", () => {
        const first = virtualChannelRank(undefined, "!a:example.org");
        const second = virtualChannelRank(undefined, "!b:example.org");
        const between = rankBetween(first, second);
        expect(compareRanks(first, between)).toBe(-1);
        expect(compareRanks(between, second)).toBe(-1);
    });
});
