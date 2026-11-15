/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import type { ImmediateScroll, TimelineViewModel } from "@element-hq/web-shared-components";

import type { RoomTimelineViewModel } from "./RoomTimelineViewModel";

/**
 * The timeline's view model as one lending of it may use it: what the view reports, and what the reader asks of it,
 * reaches `vm` only while that lending allows it, so a report or a click left over from an earlier one does nothing.
 * The snapshot and its subscription are the view model's own; the binding neither owns nor disposes of it.
 * @param vm - The view model.
 * @param isCurrent - Whether the lending still allows the view to act at all, as `TimelineViewExecution.isCurrent`.
 * @param isPlaced - Whether the rows shown have been placed for the view model's current visit, so that what the view
 *   reports of them is about that visit's rows.
 */
export function createTimelineVisitBinding(
    vm: RoomTimelineViewModel,
    isCurrent: () => boolean,
    isPlaced: () => boolean,
): TimelineViewModel {
    const reporting = (): boolean => isCurrent() && isPlaced();
    // A scroll the view model asks for at once, kept by it while it decides, is made only while the lending allows.
    const guarded =
        (scrollNow: ImmediateScroll): ImmediateScroll =>
        (anchor) => {
            if (isCurrent()) scrollNow(anchor);
        };
    return {
        getSnapshot: vm.getSnapshot,
        subscribe: vm.subscribe,
        onStartReached: () => {
            if (reporting()) vm.onStartReached();
        },
        onStartLeft: () => {
            if (reporting()) vm.onStartLeft();
        },
        onEndReached: () => {
            if (reporting()) vm.onEndReached();
        },
        onVisibleRangeChanged: (startIndex, endIndex) => {
            if (reporting()) vm.onVisibleRangeChanged(startIndex, endIndex);
        },
        onAtBottomStateChange: (atBottom) => {
            if (reporting()) vm.onAtBottomStateChange(atBottom);
        },
        // What completes a placement, so it cannot wait for one.
        onAnchorReached: (targetKey) => {
            if (isCurrent()) vm.onAnchorReached(targetKey);
        },
        onJumpToReadMarker: (scrollNow) => {
            if (isCurrent()) vm.onJumpToReadMarker(guarded(scrollNow));
        },
        onMarkAllAsRead: () => {
            if (isCurrent()) vm.onMarkAllAsRead();
        },
        onJumpToLive: (scrollNow) => {
            if (isCurrent()) vm.onJumpToLive(guarded(scrollNow));
        },
    };
}
