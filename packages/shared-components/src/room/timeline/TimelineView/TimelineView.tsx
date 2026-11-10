/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, type JSX } from "react";
import classNames from "classnames";
import { measureElement, useVirtualizer, type VirtualItem, type Virtualizer } from "@tanstack/react-virtual";
import { InlineSpinner } from "@vector-im/compound-web";

import { useViewModel } from "../../../core/viewmodel/useViewModel";
import type { AnchorAlign, ImmediateScroll, TimelineItem, TimelineViewProps } from "./types";
import { BACKWARD_LOADING_KEY, FORWARD_LOADING_KEY, tileKeyOf } from "./types";
import { TimelineOverlayButtons } from "./TimelineOverlayButtons";
import styles from "./TimelineView.module.css";

/**
 * Renders the room timeline: a scrollable list of messages.
 *
 * The list is virtualised — only the rows currently on screen (plus a few just outside it)
 * exist in the DOM, so a room with thousands of messages stays fast. TanStack Virtual does
 * that work; we drive it from `RoomTimelineViewModel`, which supplies the rows to show and
 * is told in return what the user can see.
 *
 * The hard part of a chat timeline is holding the scroll position steady while the list
 * changes underneath the reader. Rows appear at the top when older history loads, get
 * removed when the loaded window is trimmed, and loading spinners come and go. Each of
 * those shifts everything below it, which without care makes the message someone is
 * reading jump away mid-sentence. How each case is handled:
 *
 *  - **Older history arrives at the top.** `anchorTo: "end"` makes TanStack remember which
 *    row the user is looking at and, once the new rows are inserted above it, adjust the
 *    scroll position by the height that was added so that row stays exactly where it was
 *    on screen. It does this before the browser paints, so the shift is never visible.
 *
 *    `isValidAnchorItem` stops it picking a loading spinner as that remembered row: the
 *    spinner is replaced by the messages it was waiting for, so afterwards there is no
 *    such row left to line up against and the timeline would lurch to the top instead.
 *
 *  - **New messages arrive at the bottom.** `followOnAppend` scrolls down to keep them in
 *    view, but only when we are already at the live end and not jumping somewhere else.
 *
 *  - **The viewport changes height** while the reader is at the bottom (the composer grows, a
 *    banner appears, the window resizes). The browser keeps `scrollTop`, not the distance from
 *    the bottom, so the newest message would be cut off. Our @tanstack/virtual-core patch makes
 *    `anchorTo: "end"` keep the end in view when the scroller resizes, as it already does when
 *    a row resizes.
 *
 *  - **Reaching either end**, which is the cue to load more, is worked out from which rows
 *    are currently rendered. TanStack has no "you reached the top/bottom" callback.
 *
 *  - **Jumping to a particular message** looks up how far down that message sits and
 *    scrolls straight to that position. We avoid TanStack's `scrollToIndex`, which keeps
 *    steering towards a row *number*: if history loads while it is doing that, every row
 *    shifts down and it follows the wrong one to the top. See `offsetForKey`.
 *
 * `directDomUpdates: true` lets TanStack position rows by writing to the DOM itself rather
 * than going through a React render, so measuring a row and moving it happen in the same
 * frame (splitting them across two caused a visible stutter). React still re-renders when
 * the set of visible rows changes.
 *
 * Known gap: `overscan` counts rows rather than pixels, so how far it actually reaches
 * beyond the viewport varies with how tall those rows happen to be.
 */

/** Seed height for not-yet-measured rows; kept near a typical chat row so the
 * estimate→measured correction stays small. TanStack caches real heights by key thereafter. */
const ESTIMATED_ITEM_HEIGHT = 48;
/** Rows rendered beyond the visible range each side — a COUNT, not px; ~16 ≈ a screenful. */
const OVERSCAN = 16;
/** px from the list bottom still counted as "at the bottom". */
const AT_BOTTOM_THRESHOLD_PX = 4;
/**
 * How long we are willing to keep the timeline hidden on first load, in milliseconds.
 *
 * A spinner covers the list while it scrolls to the message it should start at, because that
 * scroll is neither instant nor nice to watch: rows are still being measured, so the user
 * would see blank white space where messages have not been placed yet, and would watch rows
 * resize as their content finishes arriving — URL previews appearing, polls decrypting. We
 * drop the cover as soon as the target row settles at the position it was aiming for.
 *
 * That content can keep changing height for a while, which shifts the target underneath the
 * scroll, so settling sometimes takes longer than expected — and occasionally never quite
 * completes, for instance when the requested alignment would need more content below it than
 * the room has, and the browser clamps the scroll short of it. This is the point at which we
 * stop waiting and show the timeline anyway: a slightly unsettled timeline beats an endless
 * spinner.
 */
const REVEAL_TIMEOUT_MS = 1000;

/**
 * How far the view has got through its first load:
 *  - "init"    — nothing rendered yet; waiting for the first batch of messages.
 *  - "placing" — rows are laid out but still hidden while we scroll to the right spot.
 *  - "live"    — the timeline is visible and the user is in control of scrolling.
 */
type Phase = "init" | "placing" | "live";

/**
 * The scroll offset that puts row `index` at `align` in the viewport, from the virtualizer's measurements, or undefined
 * when the row is unknown. TanStack places `start` and `end`, keeping the list's padding in view at either end.
 * `center` is placed here, as TanStack would take the padding off the row's position first and place it below the
 * middle; `third` puts the row's end a third of the way down, as the old timeline places the unread line.
 */
function offsetForIndex(
    virtualizer: Virtualizer<HTMLDivElement, Element>,
    index: number,
    align: AnchorAlign,
): number | undefined {
    if (align === "start" || align === "end") return virtualizer.getOffsetForIndex(index, align)?.[0];
    const row = virtualizer.measurementsCache[index];
    if (!row) return undefined;
    const viewport = virtualizer.scrollRect?.height ?? 0;
    const max = Math.max(0, virtualizer.getTotalSize() - viewport);
    const offset = align === "center" ? row.start + (row.size - viewport) / 2 : row.end - viewport / 3;
    return Math.min(max, Math.max(0, offset));
}

/**
 * Place the first load before it is painted, when that can be done in one go: measure the mounted rows together,
 * scroll the target into position, and check that every row that then shows was among them. The measurements are
 * read in one batch, after React has written the rows, so this forces a single layout rather than one per row.
 * @returns Whether the list is in place and can be shown.
 */
function placeBeforePaint(
    virtualizer: Virtualizer<HTMLDivElement, Element>,
    scroller: HTMLDivElement | null,
    index: number,
    align: AnchorAlign,
    measured: WeakSet<Element>,
): boolean {
    // A viewport that has no size yet, such as in a hidden window, cannot be placed in. Without ResizeObserver,
    // rows are measured as they mount, and settling over frames positions them.
    if (!scroller || scroller.clientHeight === 0 || index < 0) return false;
    if (!scroller.ownerDocument.defaultView?.ResizeObserver) return false;
    const mounted = [...virtualizer.elementsCache.values()].filter((element) => element.isConnected);
    if (mounted.length === 0) return false;
    // Read every height first, then record them in one batch: the virtualizer moves the rows once, after the last
    // one, so measuring does not force a layout per row.
    const heights = mounted.map((element) => Math.round(element.getBoundingClientRect().height));
    const sizes: [number, number][] = [];
    mounted.forEach((element, i) => {
        const rowIndex = virtualizer.indexFromElement(element);
        if (rowIndex >= 0) sizes.push([rowIndex, heights[i]]);
        measured.add(element);
    });
    virtualizer.resizeItems(sizes);
    // Row positions are worked out again only when asked for. The total size asks, so the offset below and the
    // check after it use the heights just measured.
    virtualizer.getTotalSize();
    const target = offsetForIndex(virtualizer, index, align);
    if (target === undefined) return false;
    // Through the virtualizer, so a row resizing before the scroll is read back is compensated from this offset.
    virtualizer.scrollToOffsetNow(target);
    const top = scroller.scrollTop;
    // The browser clamps the scroll; a short list is in place at whatever it allows.
    if (Math.abs(target - top) > 1.5 && top + scroller.clientHeight < scroller.scrollHeight - 1.5) return false;
    const bottom = top + scroller.clientHeight;
    const mountedIndexes = new Set(mounted.map((element) => virtualizer.indexFromElement(element)));
    // Every row now on screen must be one that was measured above, or it would show at an estimated height.
    return virtualizer.measurementsCache.every(
        (row) => row.end <= top || row.start >= bottom || mountedIndexes.has(row.index),
    );
}

export function TimelineView({ vm, renderItem, onItemsPainted, paddingBlock = 0 }: TimelineViewProps): JSX.Element {
    const snapshot = useViewModel(vm);

    // The effects and callbacks below run outside React's render — from scroll events and
    // animation frames — so they cannot use the `snapshot` variable captured when this
    // function last ran, as it may be out of date by then. These refs always hold the
    // latest values for them to read.
    const snapshotRef = useRef(snapshot);
    snapshotRef.current = snapshot;

    // Loading spinners are ordinary entries in this list (kind: "loading") rather than
    // something floating on top of it. That way each spinner occupies real space in the
    // scroll area, so showing or hiding one is just another change to the list that the
    // scroll anchoring described above already knows how to absorb.
    const items = snapshot.items;
    const itemsRef = useRef(items);
    itemsRef.current = items;

    const scrollerRef = useRef<HTMLDivElement | null>(null);
    // The virtualizer reads its starting offset once, when it first has rows. Starting it only once the viewport is
    // mounted lets that offset be estimated from the viewport, so the rows near the target render first, even
    // when the first snapshot already has messages. It costs one commit, before anything is painted.
    const [scrollerReady, setScrollerReady] = useState(false);
    useLayoutEffect(() => {
        if (scrollerRef.current) setScrollerReady(true);
    }, []);

    // On the first load we lay the rows out, scroll to the message we should start at, and
    // only then show the result. Otherwise the user would watch the list shuffle around as
    // rows are measured and the scroll position corrected. A spinner covers the gap. This
    // happens once per room, as the panel is recreated when the room changes.
    const [revealed, setRevealed] = useState(false);
    const revealedRef = useRef(false);
    const measuredElementsRef = useRef(new WeakSet<Element>());
    // The message the view last scrolled to for a pending anchor; see the later-jump effect.
    const lastPlacedAnchorKeyRef = useRef<string | null>(null);
    // The first load's target while it is placed before the first paint; see the effect that uses it.
    const placementRef = useRef<{ index: number; align: AnchorAlign; reveal: () => void; attempts: number } | null>(
        null,
    );
    const receivedResizeEntryRef = useRef(false);

    useEffect(() => {
        if (!revealed || !onItemsPainted) return;
        let frame = requestAnimationFrame(() => {
            frame = requestAnimationFrame(() => {
                const scroller = scrollerRef.current;
                if (!scroller) return;
                const top = scroller.scrollTop;
                const bottom = top + scroller.clientHeight;
                const painted = virtualizer.getVirtualItems().flatMap((row) => {
                    const item = itemsRef.current[row.index];
                    return row.end > top && row.start < bottom && item ? [item] : [];
                });
                onItemsPainted(painted);
            });
        });
        return () => cancelAnimationFrame(frame);
    });

    // Reading every new row's offsetHeight during its ref callback forces layout between
    // TanStack's positioning writes. Let ResizeObserver measure the rows together instead.
    const measureRow = useCallback(
        (
            element: Element,
            entry: ResizeObserverEntry | undefined,
            instance: Virtualizer<HTMLDivElement, Element>,
        ): number => {
            // Keep normal synchronous sizing after reveal: new history must preserve the
            // reader's anchor in the same frame, rather than moving it on the next resize.
            if (entry || revealedRef.current || !element.ownerDocument.defaultView?.ResizeObserver) {
                if (entry) receivedResizeEntryRef.current = true;
                measuredElementsRef.current.add(element);
                return measureElement(element, entry, instance);
            }
            const index = instance.indexFromElement(element);
            return instance.itemSizeCache.get(instance.options.getItemKey(index)) ?? ESTIMATED_ITEM_HEIGHT;
        },
        [],
    );

    // Gives each row a stable identity (its event id, or what outlasts it; see `tileKeyOf`). TanStack uses these to
    // recognise the same row from one update to the next, which is what makes the scroll anchoring
    // possible at all. It also compares the first row's key between renders to spot when
    // rows have been added or removed at the top, so this must always read the current list.
    const getItemKey = useCallback(
        (index: number): string => (items[index] ? tileKeyOf(items[index]) : String(index)),
        [items],
    );

    // Refuses loading spinners as the row the scroll position is anchored to; see the note
    // on `isValidAnchorItem` in the file comment above for why anchoring to one breaks.
    //
    // This tests the row's key rather than its position in the list. When rows are added or
    // removed, TanStack is still working from the positions as they were before the change
    // while `items` already reflects it, so looking a row up by position here would check
    // the wrong one. The spinner keys are shared with the view model, in types.ts.
    const isValidAnchorItem = useCallback(
        (item: VirtualItem): boolean => item.key !== BACKWARD_LOADING_KEY && item.key !== FORWARD_LOADING_KEY,
        [],
    );

    // ─── State used by the scroll reporting below ──────────────────────────────
    const phaseRef = useRef<Phase>("init");
    // We only want to tell the view model about things that have actually changed, so these
    // hold the last values we sent and repeats are skipped.
    const lastVisibleRangeRef = useRef<{ start: number; end: number } | null>(null);
    const lastAtBottomRef = useRef<boolean | null>(null);
    /**
     * The scroll position of the end when the reader was last there, while they are held at the bottom; null once
     * they are not. Rows arriving below move the end but not the reader, while the reader scrolling up moves them
     * away from it, however little at a time. See `reportVisibleState`.
     */
    const heldAtRef = useRef<number | null>(null);
    /** Set while a scroll back to the end is waiting for the next frame; see `reportVisibleState`. */
    const repinFrameRef = useRef<number | undefined>(undefined);
    /** Stop holding the reader at the bottom, and drop any scroll back to it, as they are being taken elsewhere. */
    const releaseBottom = useCallback((): void => {
        if (repinFrameRef.current !== undefined) cancelAnimationFrame(repinFrameRef.current);
        repinFrameRef.current = undefined;
        heldAtRef.current = null;
    }, []);
    // For the "reached the top/bottom" reports we remember a short description of the
    // situation we last reported, in the form "<placement>:<number of rows>:<row index>", and
    // clear it whenever we move away from that end. This stops us reporting over and over while
    // sitting still at the end, while still reporting again once more history has loaded
    // and the user scrolls further into it.
    const startEdgeTokenRef = useRef("");
    const endEdgeTokenRef = useRef("");
    /**
     * Counts the placements the view model has acknowledged, so that each one reports the ends it shows afresh. The
     * view model starts over with each load and is told nothing while it places the list, so an end that is still on
     * screen, with the same rows, has to be reported again: otherwise a list too short to scroll never asks for more.
     */
    const placementCountRef = useRef(0);
    /** The reading visit the reports above were made for; see `TimelineVisitState.generation`. */
    const reportedVisitRef = useRef<number | undefined>(undefined);

    // Tells the view model what the user can currently see: which rows are on screen,
    // whether we are at the bottom, and whether either end of the loaded messages has been
    // reached (the cue for it to load more). TanStack calls this whenever it updates —
    // on scroll, after measuring a row, or when the set of visible rows changes.
    //
    // This only reads state, it never scrolls. It stays quiet until the first load has
    // finished and while we are scrolling to a message the view model asked for, because
    // until then the scroll position reflects our own automatic placement rather than
    // anything the user did. It is quiet too while the rows shown are an earlier reading visit's.
    const reportVisibleState = useCallback(
        (v: Virtualizer<HTMLDivElement, Element>): void => {
            if (phaseRef.current !== "live" || snapshotRef.current.pendingAnchor !== null) return;
            const visit = snapshotRef.current.visit;
            if (visit && !visit.rowsReady) return;
            // A new visit starts its reports over: the view model has forgotten what this view told it in the last one.
            if (visit?.generation !== reportedVisitRef.current) {
                reportedVisitRef.current = visit?.generation;
                lastVisibleRangeRef.current = null;
                lastAtBottomRef.current = null;
                startEdgeTokenRef.current = "";
                endEdgeTokenRef.current = "";
                releaseBottom();
            }
            const itemCount = itemsRef.current.length;
            const visibleRange = v.range;

            // Which rows are on screen, given as positions in the items array.
            if (
                visibleRange &&
                (lastVisibleRangeRef.current?.start !== visibleRange.startIndex ||
                    lastVisibleRangeRef.current?.end !== visibleRange.endIndex)
            ) {
                lastVisibleRangeRef.current = { start: visibleRange.startIndex, end: visibleRange.endIndex };
                vm.onVisibleRangeChanged(visibleRange.startIndex, visibleRange.endIndex);
            }

            // Are we scrolled to the bottom? Worked out from figures TanStack already holds
            // (how far we have scrolled, the viewport height, the total height) rather than
            // measuring the DOM, which would force the browser to redo layout on every call.
            const scrollOffset = v.scrollOffset ?? 0;
            const viewportHeight = v.scrollRect?.height ?? 0;
            const totalSize = v.getTotalSize();
            const atEnd = viewportHeight > 0 && scrollOffset + viewportHeight >= totalSize - AT_BOTTOM_THRESHOLD_PX;
            // A reader at the bottom stays there, as with the old timeline's ScrollPanel, until they scroll up. Rows
            // arriving below push the end away for a moment before `followOnAppend` follows them; that is not the
            // reader leaving, and treating it so would, for one, keep them on an old timeline after a gap in sync.
            if (atEnd) heldAtRef.current = Math.max(0, totalSize - viewportHeight);
            const heldAt = heldAtRef.current;
            const following = snapshotRef.current.atLiveEnd && snapshotRef.current.pendingAnchor === null;
            const atBottom =
                atEnd ||
                (following &&
                    lastAtBottomRef.current === true &&
                    heldAt !== null &&
                    scrollOffset >= heldAt - AT_BOTTOM_THRESHOLD_PX);
            if (!atBottom) heldAtRef.current = null;
            // Still at the bottom, but the end has moved away without TanStack following it, such as when a row near
            // it grew as a message was sent: go back to it, as ScrollPanel does for a reader stuck at the bottom.
            // TanStack only follows rows added while the list is at its end, so without this it would stop for good.
            if (atBottom && !atEnd && following && repinFrameRef.current === undefined) {
                repinFrameRef.current = requestAnimationFrame(() => {
                    repinFrameRef.current = undefined;
                    // Much can happen before the frame: a jump to a message, the newest messages being unloaded, or
                    // the reader scrolling up before TanStack has told us. Go back only if they are still held here.
                    const held = heldAtRef.current;
                    const latest = vm.getSnapshot();
                    const scroller = scrollerRef.current;
                    if (held === null || lastAtBottomRef.current !== true || !scroller) return;
                    if (!latest.atLiveEnd || latest.pendingAnchor !== null) return;
                    if (scroller.scrollTop < held - AT_BOTTOM_THRESHOLD_PX) return;
                    const height = v.scrollRect?.height ?? 0;
                    v.scrollToOffset(Math.max(0, v.getTotalSize() - height));
                });
            }
            if (atBottom !== lastAtBottomRef.current) {
                lastAtBottomRef.current = atBottom;
                vm.onAtBottomStateChange(atBottom);
            }

            // Have we reached either end of the loaded messages? True once the very first or
            // very last row is among those being rendered, which tells the view model it may
            // need to load more history in that direction.
            const renderedItems = v.getVirtualItems();
            const firstRenderedIndex = renderedItems.length ? renderedItems[0].index : -1;
            const lastRenderedIndex = renderedItems.length ? renderedItems[renderedItems.length - 1].index : -1;
            if (firstRenderedIndex === 0) {
                const token = `${placementCountRef.current}:${itemCount}:${visibleRange ? visibleRange.startIndex : 0}`;
                if (startEdgeTokenRef.current !== token) {
                    startEdgeTokenRef.current = token;
                    vm.onStartReached();
                }
            } else if (startEdgeTokenRef.current !== "") {
                startEdgeTokenRef.current = "";
                vm.onStartLeft();
            }
            if (itemCount > 0 && lastRenderedIndex === itemCount - 1) {
                const token = `${placementCountRef.current}:${itemCount}:${visibleRange ? visibleRange.endIndex : 0}`;
                if (endEdgeTokenRef.current !== token) {
                    endEdgeTokenRef.current = token;
                    vm.onEndReached();
                }
            } else {
                endEdgeTokenRef.current = "";
            }
        },
        [vm, releaseBottom],
    );

    const virtualizer = useVirtualizer({
        count: items.length,
        // Keep the initial offset unset until messages arrive, then render near the destination
        // instead of measuring the top of the list before scrolling to its initial anchor.
        enabled: items.length > 0 && scrollerReady,
        initialOffset: () => {
            // A nonempty first snapshot can render before the viewport mounts. In that case,
            // leave placement to the existing measured scroll instead of guessing its height.
            if (!scrollerRef.current) return 0;
            const list = itemsRef.current;
            const anchor = snapshotRef.current.pendingAnchor;
            const targetIndex = anchor ? list.findIndex((item) => item.key === anchor.targetKey) : -1;
            const index = targetIndex >= 0 ? targetIndex : list.length - 1;
            const height = scrollerRef.current?.clientHeight ?? 0;
            const align = anchor?.align ?? "end";
            const start = paddingBlock + index * ESTIMATED_ITEM_HEIGHT;
            const offset =
                align === "start"
                    ? start
                    : align === "center"
                      ? start + (ESTIMATED_ITEM_HEIGHT - height) / 2
                      : align === "third"
                        ? start + ESTIMATED_ITEM_HEIGHT - height / 3
                        : start + ESTIMATED_ITEM_HEIGHT - height;
            return Math.max(0, Math.min(offset, list.length * ESTIMATED_ITEM_HEIGHT + 2 * paddingBlock - height));
        },
        getScrollElement: () => scrollerRef.current,
        // Only consulted for rows that have not been measured yet. TanStack measures each
        // row as it renders and remembers the result by key, reusing it as rows are added,
        // trimmed or reloaded, so we do not need a size cache of our own.
        estimateSize: () => ESTIMATED_ITEM_HEIGHT,
        // The space before the first row and after the last. Aligning a row to an end keeps it in view too, so
        // going to the newest message shows the space below it, as at the bottom of the list.
        paddingStart: paddingBlock,
        paddingEnd: paddingBlock,
        scrollPaddingStart: paddingBlock,
        scrollPaddingEnd: paddingBlock,
        measureElement: measureRow,
        getItemKey,
        overscan: OVERSCAN,
        // Keep whatever the user is looking at visually still when rows are added or
        // removed, correcting the scroll position before the browser paints. This is the
        // main thing stopping the timeline jumping; see the file comment for how it works.
        anchorTo: "end",
        // ...but never hold onto a loading spinner as that reference row (see above). This
        // option comes from our @tanstack/virtual-core patch and is pending upstream.
        isValidAnchorItem,
        // How near the bottom still counts as being at the bottom, for staying put
        // when a message grows or the viewport resizes. The library's own default of 1px is missed by
        // fractional scroll positions; this is the same tolerance we report with.
        scrollEndThreshold: AT_BOTTOM_THRESHOLD_PX,
        // Scroll down to follow newly arrived messages, but only when we are at the live end
        // of the timeline and are not part-way through jumping somewhere else.
        followOnAppend: snapshot.atLiveEnd && snapshot.pendingAnchor === null,
        // Let TanStack place rows by writing to the DOM directly instead of re-rendering.
        // Because of this, never set transform or height on a row in JSX below — it would
        // fight with what TanStack writes.
        directDomUpdates: true,
        // Called on every TanStack update; we use it to report what is on screen upwards.
        onChange: reportVisibleState,
    });

    // An accurate initial estimate may need no scroll event after placement. Report the
    // visible range and the ends shown once revealed and each time the view model has acknowledged an
    // anchor, even when they are as before: after a reload those positions hold other rows, and
    // the view model reads what each placement shows. So too for each placement the view model counts, such as a
    // load that placed nothing, or a reading visit's first rows.
    const placementRevision = snapshot.visit?.placementRevision;
    const visitRowsReady = snapshot.visit?.rowsReady;
    useEffect(() => {
        if (!revealed) return;
        if (snapshot.pendingAnchor === null) {
            lastVisibleRangeRef.current = null;
            placementCountRef.current++;
        }
        reportVisibleState(virtualizer);
    }, [revealed, snapshot.pendingAnchor, placementRevision, visitRowsReady, reportVisibleState, virtualizer]);

    // Works out how far down the list we would have to scroll, in pixels, to bring the row
    // with `targetKey` into view — `align` saying whether it should end up at the top,
    // the middle or the bottom of the viewport. Returns null if that message is not among
    // the ones currently loaded, in which case the caller cannot scroll to it yet.
    //
    // Callers hand the result to `scrollToOffset`, which simply scrolls to a fixed pixel
    // position. We deliberately do not use `scrollToIndex`: that keeps steering towards a
    // row *number* as rows are measured, so if older history loads while it is still
    // adjusting, every row shifts down and it follows the wrong one up to the top.
    const offsetForKey = useCallback(
        (targetKey: string | null, align: AnchorAlign): number | null => {
            const idx = targetKey ? itemsRef.current.findIndex((i) => i.key === targetKey) : -1;
            if (idx < 0) return null;
            return offsetForIndex(virtualizer, idx, align) ?? null;
        },
        [virtualizer],
    );
    // ─── First load: scroll to the starting message while hidden, then reveal ──
    // Runs once, as soon as the first batch of messages arrives.
    // Holds the pending animation frame from the settle loop below, so it can be cancelled
    // if the panel goes away while that loop is still running — switching room part-way
    // through the first load, for example. Without this the callback would carry on and
    // update state on a component that no longer exists, and call a disposed view model.
    const coldRafRef = useRef<number | undefined>(undefined);
    useEffect(() => {
        return () => {
            if (coldRafRef.current !== undefined) cancelAnimationFrame(coldRafRef.current);
            if (repinFrameRef.current !== undefined) cancelAnimationFrame(repinFrameRef.current);
        };
    }, []);
    useLayoutEffect(() => {
        if (phaseRef.current !== "init" || items.length === 0) return;
        // Move out of "init" immediately, so that if more messages arrive while we are
        // still placing this effect runs again but returns here rather than starting over.
        phaseRef.current = "placing";
        // Start at the message the view model asked for. If it did not ask for one, or that
        // message is not in the batch we were given, start at the newest message instead.
        const anchor = snapshotRef.current.pendingAnchor;
        const list = itemsRef.current;
        let idx = anchor ? list.findIndex((i) => i.key === anchor.targetKey) : -1;
        if (idx < 0) idx = list.length - 1;
        const align: AnchorAlign = anchor?.align ?? "end";
        // Let TanStack carry out this scroll: it keeps correcting the target as rows are
        // measured and their real heights become known. We must not set the scroll position
        // ourselves as well — two things moving the viewport at once end up fighting.
        // Now watch each frame until that row actually reaches the position it was heading
        // for, and reveal the timeline once it has. requestAnimationFrame passes the frame's
        // timestamp, so we can measure how long we have been waiting in real time and give up
        const reveal = (): void => {
            phaseRef.current = "live";
            // The later-jump effect can run in the same commit, with this render's anchor: it is already placed.
            lastPlacedAnchorKeyRef.current = anchor?.targetKey ?? null;
            if (!revealedRef.current) {
                revealedRef.current = true;
                setRevealed(true);
            }
            // Only the anchor this placement was for has settled. One set meanwhile, such as a message navigated
            // to while the first one was placed, is placed once the list is shown.
            vm.onAnchorReached(anchor?.targetKey ?? null);
        };
        // Usually the list can be placed before the browser first paints it; see the effect below. The frames
        // that follow settle it otherwise, such as while rows are still changing height.
        placementRef.current = { index: idx, align, reveal, attempts: 0 };
        let startedAt: number | undefined;
        let startedPlacement = false;
        const tick = (now: number): void => {
            if (phaseRef.current === "live") return;
            startedAt ??= now;
            // An estimated scroll offset can land before ResizeObserver runs. Keep the
            // cover until the mounted range has real measurements, including any rows
            // mounted as scrolling corrects the estimates. Retain the timeout fallback
            // when no observer entries arrive at all.
            const measured = virtualizer.getVirtualItems().every((item) => {
                const element = virtualizer.elementsCache.get(item.key);
                return element !== undefined && measuredElementsRef.current.has(element);
            });
            const timedOut = now - startedAt >= REVEAL_TIMEOUT_MS;
            const canPlace = measured || (timedOut && !receivedResizeEntryRef.current);
            // Measure the first range before scrolling can unmount it. Otherwise those
            // discarded estimates would move the reader when they scroll back to it later.
            if (!startedPlacement && canPlace) {
                startedPlacement = true;
                if (idx >= 0) {
                    if (align === "third" || align === "center") {
                        // TanStack has no third, and centres below the middle with padding (see offsetForIndex): these
                        // are aimed at again each frame below until they land.
                        const target = offsetForIndex(virtualizer, idx, align);
                        if (target !== undefined) virtualizer.scrollToOffset(target);
                    } else {
                        virtualizer.scrollToIndex(idx, { align, behavior: "auto" });
                    }
                }
                coldRafRef.current = requestAnimationFrame(tick);
                return;
            }
            const target = offsetForIndex(virtualizer, idx, align);
            // The browser can clamp a short list to zero without emitting a scroll event,
            // leaving the virtualizer's cached offset stale after its resize compensation.
            const offset = scrollerRef.current?.scrollTop ?? virtualizer.scrollOffset ?? 0;
            const landed = startedPlacement && target !== undefined && Math.abs(target - offset) <= 1.5;
            if (startedPlacement && !landed && (align === "third" || align === "center") && target !== undefined) {
                virtualizer.scrollToOffset(target);
            }
            if ((measured && (landed || timedOut)) || (timedOut && !receivedResizeEntryRef.current)) {
                reveal();
                return;
            }
            coldRafRef.current = requestAnimationFrame(tick);
        };
        coldRafRef.current = requestAnimationFrame(tick);
    }, [items.length, virtualizer, vm]);

    // ─── First load before the first paint ─────────────────────────────────
    // The rows that end up on screen are usually already mounted: the first render starts near the target (see
    // initialOffset) with a screenful of rows either side. They mount in the commit after the virtualizer finds its
    // viewport, still before the paint, so each commit while placing tries to measure them and scroll into place.
    // A few tries are enough; after that the settle loop above carries on alone.
    useLayoutEffect(() => {
        const placement = placementRef.current;
        if (!placement || phaseRef.current !== "placing") return;
        if (
            placeBeforePaint(
                virtualizer,
                scrollerRef.current,
                placement.index,
                placement.align,
                measuredElementsRef.current,
            )
        ) {
            placementRef.current = null;
            if (coldRafRef.current !== undefined) cancelAnimationFrame(coldRafRef.current);
            placement.reveal();
            return;
        }
        if (++placement.attempts >= 5) placementRef.current = null;
    });

    // ─── Later jumps: scroll to a message the view model has asked for ─────────
    // Once the first load is done, the view model can ask us to jump somewhere by setting
    // `pendingAnchor`. This is used by "jump to the latest message" and "jump to the first
    // unread message" when the target was not already loaded, so it had to be fetched and
    // the timeline rebuilt around it first.
    //
    // This effect runs after every render, so it acts as soon as those messages appear, and
    // it scrolls before the browser paints so the jump is never seen as a scrolling motion.
    // `lastPlacedAnchorKeyRef` records which message we last jumped to, so that later
    // renders do not repeat the same jump and fight the user's own scrolling.
    useLayoutEffect(() => {
        if (phaseRef.current !== "live") return;
        const anchor = snapshotRef.current.pendingAnchor;
        if (!anchor) {
            lastPlacedAnchorKeyRef.current = null;
            return;
        }
        if (lastPlacedAnchorKeyRef.current !== anchor.targetKey) {
            releaseBottom();
            const target = offsetForKey(anchor.targetKey, anchor.align);
            if (target !== null) {
                virtualizer.scrollToOffset(target);
                lastPlacedAnchorKeyRef.current = anchor.targetKey;
                vm.onAnchorReached(anchor.targetKey);
            }
        }
    });

    // Handed to the overlay buttons, and through them to the view model, so it can scroll
    // us straight away when the message it wants is already loaded — no fetch needed, and
    // no round trip through `pendingAnchor` above.
    const scrollNow = useCallback<ImmediateScroll>(
        (anchor) => {
            const target = offsetForKey(anchor.targetKey, anchor.align);
            if (target === null) return;
            releaseBottom();
            virtualizer.scrollToOffset(target);
        },
        [offsetForKey, releaseBottom, virtualizer],
    );

    const virtualItems = virtualizer.getVirtualItems();

    return (
        <div className={styles.root}>
            <div
                ref={scrollerRef}
                data-testid="timeline-scroller"
                // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex
                tabIndex={0}
                className={classNames(styles.scroller, {
                    [styles.hidden]: !revealed,
                    [styles.bottomAligned]: snapshot.alignToBottom,
                })}
            >
                {/* An <ol> of <li> rows, so screen readers announce this as a list of messages
                    and can say how many there are. The role="list" is stated explicitly even
                    though an <ol> already is one: Safari with VoiceOver stops treating a list
                    as a list once list-style is set to none, which our CSS does. The old
                    ScrollPanel does the same thing for the same reason. */}
                {/* eslint-disable jsx-a11y/no-redundant-roles -- see comment above */}
                <ol
                    ref={virtualizer.containerRef}
                    className={classNames("mx_TimelineView_list", styles.list)}
                    role="list"
                >
                    {/* eslint-enable jsx-a11y/no-redundant-roles */}
                    {virtualItems.map((vi) => {
                        const item: TimelineItem | undefined = items[vi.index];
                        if (!item) return null;
                        return (
                            <li
                                key={vi.key}
                                className={classNames("mx_TimelineView_tile", styles.tile)}
                                data-index={vi.index}
                                data-key={item.key}
                                ref={virtualizer.measureElement}
                            >
                                {renderItem(item)}
                            </li>
                        );
                    })}
                </ol>
            </div>
            {!revealed && (
                <div className={styles.cover}>
                    <InlineSpinner size={32} />
                </div>
            )}
            {revealed && <TimelineOverlayButtons snapshot={snapshot} vm={vm} scrollNow={scrollNow} />}
        </div>
    );
}
