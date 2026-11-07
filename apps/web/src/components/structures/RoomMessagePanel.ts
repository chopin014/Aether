/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import type React from "react";

import type { IScrollState } from "./ScrollPanel";

/**
 * What the room view asks of the panel showing a room's messages, whichever timeline draws it. The old
 * `TimelinePanel` and the new MVVM timeline both provide it, so keyboard shortcuts, sending, editing and the unread
 * line behave the same in either.
 */
export interface RoomMessagePanel {
    /** Whether the newest message of the live timeline is loaded and in view. */
    isAtEndOfLiveTimeline(): boolean | undefined;
    /** Whether the SDK may replace the room's live timeline without losing the reader's place. */
    canResetTimeline(): boolean;
    /** Whether the unread line is out of view, so the room view may offer to jump to it. */
    canJumpToReadMarker(): boolean;
    /** Show the newest message, loading it first if needed. */
    jumpToLiveTimeline(): void;
    /** Show the unread line, loading history around it if needed. */
    jumpToReadMarker(): void;
    /** Mark the room as read up to the newest message, dropping the unread line. */
    forgetReadMarker(): Promise<void> | void;
    /** Bring a loaded message into view if it is not visible. */
    scrollToEventIfNeeded(eventId?: string): void;
    /** Scroll for Page Up, Page Down and the jump-to-first and jump-to-latest shortcuts. */
    handleScrollKey(ev: React.KeyboardEvent | KeyboardEvent): void;
    /** Send a read receipt for what is visible, such as when the window regains focus. */
    sendReadReceipts(): Promise<void> | void;
    /** Move the fully-read marker to match what has been read. */
    updateReadMarker(): Promise<void> | void;
    /**
     * Where the reader is, for the room view to restore when they come back. Panels that remember their own
     * position, like the MVVM timeline, leave this out.
     */
    getScrollState?(): IScrollState | null;
}
