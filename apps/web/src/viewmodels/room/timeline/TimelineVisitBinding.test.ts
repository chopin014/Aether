/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import type { ImmediateScroll, TimelineViewModel } from "@element-hq/web-shared-components";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RoomTimelineViewModel } from "./RoomTimelineViewModel";
import { createTimelineVisitBinding } from "./TimelineVisitBinding";

describe("createTimelineVisitBinding", () => {
    const actions = [
        "onStartReached",
        "onStartLeft",
        "onEndReached",
        "onVisibleRangeChanged",
        "onAtBottomStateChange",
        "onAnchorReached",
        "onJumpToReadMarker",
        "onMarkAllAsRead",
        "onJumpToLive",
    ] as const;
    let vm: Record<(typeof actions)[number] | "getSnapshot" | "subscribe", ReturnType<typeof vi.fn>>;
    let current: boolean;
    let placed: boolean;
    let binding: TimelineViewModel;

    beforeEach(() => {
        vm = {
            getSnapshot: vi.fn(),
            subscribe: vi.fn(),
            ...Object.fromEntries(actions.map((action) => [action, vi.fn()])),
        } as typeof vm;
        current = true;
        placed = true;
        binding = createTimelineVisitBinding(
            vm as unknown as RoomTimelineViewModel,
            () => current,
            () => placed,
        );
    });

    // Each action, how the view calls it, and whether it reports on the rows shown, which needs them placed.
    it.each<[(typeof actions)[number], (binding: TimelineViewModel) => void, boolean]>([
        ["onStartReached", (b) => b.onStartReached(), true],
        ["onStartLeft", (b) => b.onStartLeft(), true],
        ["onEndReached", (b) => b.onEndReached(), true],
        ["onVisibleRangeChanged", (b) => b.onVisibleRangeChanged(2, 9), true],
        ["onAtBottomStateChange", (b) => b.onAtBottomStateChange(true), true],
        ["onAnchorReached", (b) => b.onAnchorReached("$target"), false],
        ["onJumpToReadMarker", (b) => b.onJumpToReadMarker(vi.fn()), false],
        ["onMarkAllAsRead", (b) => b.onMarkAllAsRead(), false],
        ["onJumpToLive", (b) => b.onJumpToLive(vi.fn()), false],
    ])("passes %s on only while its lending allows it", (action, call, reportsRows) => {
        call(binding);
        expect(vm[action]).toHaveBeenCalledOnce();

        placed = false;
        call(binding);
        expect(vm[action]).toHaveBeenCalledTimes(reportsRows ? 1 : 2);

        placed = true;
        current = false;
        call(binding);
        expect(vm[action]).toHaveBeenCalledTimes(reportsRows ? 1 : 2);
    });

    it("passes on what the view reports", () => {
        binding.onVisibleRangeChanged(2, 9);
        binding.onAtBottomStateChange(false);
        binding.onAnchorReached("$target");
        binding.onAnchorReached(null);

        expect(vm.onVisibleRangeChanged).toHaveBeenCalledWith(2, 9);
        expect(vm.onAtBottomStateChange).toHaveBeenCalledWith(false);
        expect(vm.onAnchorReached.mock.calls).toEqual([["$target"], [null]]);
    });

    it.each(["onJumpToLive", "onJumpToReadMarker"] as const)(
        "scrolls for %s at once only while its lending still allows it",
        (action) => {
            const scrollNow = vi.fn();
            binding[action](scrollNow);
            const kept: ImmediateScroll = vm[action].mock.calls[0][0];

            kept({ targetKey: "$a", align: "end" });
            expect(scrollNow).toHaveBeenCalledExactlyOnceWith({ targetKey: "$a", align: "end" });

            // Kept by the view model, and called once the lending has stopped allowing the view to act.
            current = false;
            kept({ targetKey: "$b", align: "end" });
            expect(scrollNow).toHaveBeenCalledOnce();
        },
    );

    it("shares the view model's snapshot and subscription", () => {
        expect(binding.getSnapshot).toBe(vm.getSnapshot);
        expect(binding.subscribe).toBe(vm.subscribe);
    });
});
