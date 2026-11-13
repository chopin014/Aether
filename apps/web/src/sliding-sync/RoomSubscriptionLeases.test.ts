/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_LEASE_OPTIONS, RoomSubscriptionLeases } from "./RoomSubscriptionLeases";

describe("RoomSubscriptionLeases", () => {
    let onChange: ReturnType<typeof vi.fn<(urgent: boolean) => void>>;
    let leases: RoomSubscriptionLeases;

    beforeEach(() => {
        vi.useFakeTimers();
        onChange = vi.fn<(urgent: boolean) => void>();
        leases = new RoomSubscriptionLeases(onChange);
    });

    afterEach(() => {
        leases.dispose();
        vi.useRealTimers();
    });

    it("keeps an opened room subscribed until its grace period after release", () => {
        const lease = leases.acquire("!a", "view");
        expect(onChange).toHaveBeenLastCalledWith(true);
        expect(leases.roomIds()).toEqual(["!a"]);
        expect([...leases.purposes("!a")]).toEqual(["view"]);

        lease.release();
        expect(leases.purposes("!a").size).toBe(0);
        expect(leases.roomIds()).toEqual(["!a"]);
        vi.advanceTimersByTime(DEFAULT_LEASE_OPTIONS.graceMs.view - 1);
        expect(leases.roomIds()).toEqual(["!a"]);
        onChange.mockClear();
        vi.advanceTimersByTime(1);
        expect(leases.roomIds()).toEqual([]);
        expect(onChange).toHaveBeenCalledWith(false);
    });

    it("asks for an opened room or a call straight away, and sends a Space with the next batch", () => {
        leases.acquire("!room", "view");
        expect(onChange).toHaveBeenLastCalledWith(true);
        leases.acquire("!call", "call");
        expect(onChange).toHaveBeenLastCalledWith(true);
        leases.acquire("!space", "space");
        expect(onChange).toHaveBeenLastCalledWith(false);
    });

    it("counts holds, and releasing a hold twice has no further effect", () => {
        const first = leases.acquire("!a", "call");
        const second = leases.acquire("!a", "call");
        first.release();
        first.release();
        expect([...leases.purposes("!a")]).toEqual(["call"]);
        second.release();
        expect(leases.purposes("!a").size).toBe(0);
    });

    it("cancels the grace period when a room is held again", () => {
        leases.acquire("!a", "view").release();
        vi.advanceTimersByTime(DEFAULT_LEASE_OPTIONS.graceMs.view - 10);
        const again = leases.acquire("!a", "view");
        vi.advanceTimersByTime(DEFAULT_LEASE_OPTIONS.graceMs.view);
        expect(leases.roomIds()).toEqual(["!a"]);
        again.release();
        vi.advanceTimersByTime(DEFAULT_LEASE_OPTIONS.graceMs.view);
        expect(leases.roomIds()).toEqual([]);
    });

    it("keeps a prefetched room for a while, extended by further intent, without urgency", () => {
        leases.prefetch("!a");
        expect(onChange).toHaveBeenCalledWith(false);
        expect(onChange).not.toHaveBeenCalledWith(true);
        vi.advanceTimersByTime(DEFAULT_LEASE_OPTIONS.prefetchMs - 1000);
        onChange.mockClear();
        leases.prefetch("!a");
        // Already kept: nothing to send.
        expect(onChange).not.toHaveBeenCalled();
        vi.advanceTimersByTime(DEFAULT_LEASE_OPTIONS.prefetchMs - 1);
        expect(leases.roomIds()).toEqual(["!a"]);
        vi.advanceTimersByTime(1);
        expect(leases.roomIds()).toEqual([]);
    });

    it("does not report a prefetch of a room that is already open", () => {
        leases.acquire("!a", "view");
        onChange.mockClear();
        leases.prefetch("!a");
        expect(onChange).not.toHaveBeenCalled();
        expect(leases.roomIds()).toEqual(["!a"]);
    });

    it("bounds prefetched rooms to the newest intents", () => {
        for (let i = 0; i < 6; i++) {
            leases.prefetch(`!p${i}`);
            vi.advanceTimersByTime(10);
        }
        expect(leases.roomIds()).toEqual(["!p5", "!p4", "!p3", "!p2"]);
    });

    it("never drops held rooms for the limit, and drops rooms kept for their grace period first", () => {
        const options = { ...DEFAULT_LEASE_OPTIONS, maxRooms: 3, maxPrefetchRooms: 3 };
        leases.dispose();
        leases = new RoomSubscriptionLeases(onChange, options);
        leases.acquire("!old", "view").release();
        vi.advanceTimersByTime(10);
        leases.acquire("!space", "space");
        leases.acquire("!call", "call");
        leases.acquire("!view", "view");
        leases.prefetch("!next");
        expect(leases.roomIds().sort()).toEqual(["!call", "!space", "!view"]);
    });

    it("lets a cancelled prefetch go straight away, keeping other holds", () => {
        leases.prefetch("!gone");
        leases.prefetch("!both");
        const view = leases.acquire("!both", "view");
        leases.cancelPrefetch("!gone");
        leases.cancelPrefetch("!both");
        expect(leases.roomIds()).toEqual(["!both"]);
        expect([...leases.purposes("!both")]).toEqual(["view"]);
        view.release();
    });

    it("reports a lower purpose when a more important hold is released", () => {
        const view = leases.acquire("!a", "view");
        leases.acquire("!a", "space");
        onChange.mockClear();
        view.release();
        expect([...leases.purposes("!a")]).toEqual(["space"]);
        expect(onChange).toHaveBeenCalledWith(false);
    });

    it("reports nothing after being disposed", () => {
        const lease = leases.acquire("!a", "view");
        leases.prefetch("!b");
        leases.dispose();
        onChange.mockClear();
        lease.release();
        leases.prefetch("!c");
        vi.advanceTimersByTime(DEFAULT_LEASE_OPTIONS.prefetchMs);
        expect(onChange).not.toHaveBeenCalled();
        expect(leases.roomIds()).toEqual([]);
    });
});
