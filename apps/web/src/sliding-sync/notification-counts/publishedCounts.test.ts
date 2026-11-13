/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it, vi } from "vitest";
import { NotificationCountType, type Room } from "matrix-js-sdk/src/matrix";

import {
    announceCountsChanged,
    combineInexactCounts,
    getInexactCount,
    getInexactCounts,
    InexactCount,
    onCountsChanged,
    setInexactCounts,
} from "./publishedCounts";

describe("publishedCounts", () => {
    /** A room with these totals: the main timeline's, and each thread's by root ID. */
    const room = (main: number, threads: Record<string, number> = {}): Room =>
        ({
            getRoomUnreadNotificationCount: (type: NotificationCountType) =>
                type === NotificationCountType.Total ? main : 0,
            getThreadUnreadNotificationCount: (threadId: string, type: NotificationCountType) =>
                type === NotificationCountType.Total ? (threads[threadId] ?? 0) : 0,
        }) as unknown as Room;

    it("says every count is exact until one is set otherwise", () => {
        const subject = room(3, { $thread: 1 });
        expect(getInexactCounts(subject)).toBeUndefined();
        expect(getInexactCount(subject)).toBeUndefined();
        expect(getInexactCount(subject, "$thread")).toBeUndefined();
    });

    it("tells the main timeline's count from its threads'", () => {
        const subject = room(3, { $thread: 1, $other: 2 });
        setInexactCounts(subject, { threads: new Map([["$thread", InexactCount.LowerBound]]) });

        expect(getInexactCount(subject)).toBeUndefined();
        expect(getInexactCount(subject, undefined, true)).toBe(InexactCount.LowerBound);
        expect(getInexactCount(subject, "$thread")).toBe(InexactCount.LowerBound);
        expect(getInexactCount(subject, "$other")).toBeUndefined();

        setInexactCounts(subject, { main: InexactCount.Approximate, threads: new Map() });
        expect(getInexactCount(subject)).toBe(InexactCount.Approximate);
        expect(getInexactCount(subject, "$thread")).toBeUndefined();
    });

    it("takes only counts above zero into account", () => {
        const subject = room(0, { $thread: 0, $busy: 2 });
        setInexactCounts(subject, {
            main: InexactCount.Approximate,
            threads: new Map([
                ["$thread", InexactCount.Approximate],
                ["$busy", InexactCount.LowerBound],
            ]),
        });

        expect(getInexactCount(subject)).toBeUndefined();
        expect(getInexactCount(subject, "$thread")).toBeUndefined();
        expect(getInexactCount(subject, undefined, true)).toBe(InexactCount.LowerBound);
    });

    it("takes a sum with an approximate count in it as approximate, as that one could be too high", () => {
        expect(combineInexactCounts([])).toBeUndefined();
        expect(combineInexactCounts([undefined, InexactCount.LowerBound])).toBe(InexactCount.LowerBound);
        expect(combineInexactCounts([InexactCount.LowerBound, InexactCount.Approximate])).toBe(
            InexactCount.Approximate,
        );
        expect(combineInexactCounts([InexactCount.Approximate, InexactCount.LowerBound])).toBe(
            InexactCount.Approximate,
        );
    });

    it("forgets a room none of whose counts are inexact", () => {
        const subject = room(1);
        setInexactCounts(subject, { main: InexactCount.LowerBound, threads: new Map() });

        setInexactCounts(subject, { threads: new Map() });
        expect(getInexactCounts(subject)).toBeUndefined();

        setInexactCounts(subject, { main: InexactCount.LowerBound, threads: new Map() });
        setInexactCounts(subject, undefined);
        expect(getInexactCounts(subject)).toBeUndefined();
    });

    it("tells each listener of a room whose counts changed, until it stops listening", () => {
        const subject = room(0);
        const first = vi.fn();
        const second = vi.fn();
        const stopFirst = onCountsChanged(first);
        const stopSecond = onCountsChanged(second);

        announceCountsChanged(subject);
        expect(first).toHaveBeenCalledWith(subject);
        expect(second).toHaveBeenCalledWith(subject);

        stopFirst();
        announceCountsChanged(subject);
        expect(first).toHaveBeenCalledTimes(1);
        expect(second).toHaveBeenCalledTimes(2);
        stopSecond();
    });
});
