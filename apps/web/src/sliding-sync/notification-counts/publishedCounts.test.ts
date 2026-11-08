/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it, vi } from "vitest";

import type { Room } from "matrix-js-sdk/src/matrix";
import {
    announceCountsChanged,
    getLowerBoundCounts,
    isLowerBoundCount,
    onCountsChanged,
    setLowerBoundCounts,
} from "./publishedCounts";

describe("publishedCounts", () => {
    const room = (): Room => ({}) as Room;

    it("says no count is a lower bound until one is set", () => {
        const subject = room();
        expect(getLowerBoundCounts(subject)).toBeUndefined();
        expect(isLowerBoundCount(subject)).toBe(false);
        expect(isLowerBoundCount(subject, "$thread")).toBe(false);
    });

    it("tells the main timeline's count from its threads'", () => {
        const subject = room();
        setLowerBoundCounts(subject, { main: false, threads: new Set(["$thread"]) });

        expect(isLowerBoundCount(subject)).toBe(false);
        expect(isLowerBoundCount(subject, undefined, true)).toBe(true);
        expect(isLowerBoundCount(subject, "$thread")).toBe(true);
        expect(isLowerBoundCount(subject, "$other")).toBe(false);

        setLowerBoundCounts(subject, { main: true, threads: new Set() });
        expect(isLowerBoundCount(subject)).toBe(true);
        expect(isLowerBoundCount(subject, "$thread")).toBe(false);
    });

    it("forgets a room none of whose counts are lower bounds", () => {
        const subject = room();
        setLowerBoundCounts(subject, { main: true, threads: new Set() });

        setLowerBoundCounts(subject, { main: false, threads: new Set() });
        expect(getLowerBoundCounts(subject)).toBeUndefined();

        setLowerBoundCounts(subject, { main: true, threads: new Set() });
        setLowerBoundCounts(subject, undefined);
        expect(getLowerBoundCounts(subject)).toBeUndefined();
    });

    it("tells each listener of a room whose counts changed, until it stops listening", () => {
        const subject = room();
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
