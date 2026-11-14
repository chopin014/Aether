/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import React from "react";
import { act, render, screen, waitFor, type RenderResult } from "@test-utils";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { page } from "vitest/browser";

import { TimelineView } from "./TimelineView";
import {
    BACKWARD_LOADING_KEY,
    type ImmediateScroll,
    type TimelineItem,
    type TimelineViewExecution,
    type TimelineViewModel,
    type TimelineViewSnapshot,
} from "./types";

const baseSnapshot: TimelineViewSnapshot = {
    items: [],
    atLiveEnd: true,
    pendingAnchor: null,
    highlightedEventId: null,
    isAtBottom: true,
    canJumpToReadMarker: false,
    numUnreadMessages: 0,
    hasHighlights: false,
};

function eventItems(count: number, offset = 0): TimelineItem[] {
    return Array.from({ length: count }, (_, i) => ({
        key: `evt-${offset + i}`,
        kind: "event" as const,
        event: null,
        continuation: false,
        lastInSection: true,
    }));
}

type Actions = {
    onStartReached: ReturnType<typeof vi.fn>;
    onStartLeft: ReturnType<typeof vi.fn>;
    onEndReached: ReturnType<typeof vi.fn>;
    onAnchorReached: ReturnType<typeof vi.fn>;
    onVisibleRangeChanged: ReturnType<typeof vi.fn>;
    onAtBottomStateChange: ReturnType<typeof vi.fn>;
    onJumpToReadMarker: ReturnType<typeof vi.fn>;
    onMarkAllAsRead: ReturnType<typeof vi.fn>;
    onJumpToLive: ReturnType<typeof vi.fn>;
};

interface FakeVm {
    vm: TimelineViewModel;
    actions: Actions;
    /** Push a new snapshot and notify subscribers (wrapped in act). */
    update: (patch: Partial<TimelineViewSnapshot>) => void;
}

function makeFakeVm(initial: Partial<TimelineViewSnapshot> = {}): FakeVm {
    let snapshot: TimelineViewSnapshot = { ...baseSnapshot, ...initial };
    const listeners = new Set<() => void>();
    const actions: Actions = {
        onStartReached: vi.fn(),
        onStartLeft: vi.fn(),
        onEndReached: vi.fn(),
        onAnchorReached: vi.fn(),
        onVisibleRangeChanged: vi.fn(),
        onAtBottomStateChange: vi.fn(),
        onJumpToReadMarker: vi.fn(),
        onMarkAllAsRead: vi.fn(),
        onJumpToLive: vi.fn(),
    };
    // vi.fn() carries a constructable signature that trips assignability to the
    // ViewModel's action method types, so cast the assembled object.
    const vm = {
        getSnapshot: () => snapshot,
        subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        ...actions,
    } as unknown as TimelineViewModel;
    const update = (patch: Partial<TimelineViewSnapshot>): void => {
        act(() => {
            snapshot = { ...snapshot, ...patch };
            listeners.forEach((l) => l());
        });
    };
    return { vm, actions, update };
}

// Each row is a fixed 40px so the virtualizer measures a deterministic layout.
const ROW_HEIGHT = 40;
const renderItem = (item: TimelineItem): React.ReactNode => (
    <div data-testid={`row-${item.key}`} style={{ height: ROW_HEIGHT }}>
        {item.key}
    </div>
);

// Fixed-height viewport: the TimelineView is height:100%, so its parent must size it.
const VIEWPORT_HEIGHT = 300;
function renderTimeline(vm: TimelineViewModel): RenderResult {
    return render(
        <div style={{ height: VIEWPORT_HEIGHT, width: 320 }}>
            <TimelineView vm={vm} renderItem={renderItem} />
        </div>,
    );
}

describe("<TimelineView />", () => {
    it("keeps a row as its key changes while its tile key stays, as for a message the server confirms", async () => {
        const items = eventItems(5);
        const mine = { ...items[4], key: "~local", tileKey: "txn-1" } as TimelineItem;
        const { vm, actions, update } = makeFakeVm({ items: [...items.slice(0, 4), mine] });
        renderTimeline(vm);
        await waitFor(() => expect(actions.onAnchorReached).toHaveBeenCalled(), { timeout: 5000 });
        const row = screen.getByTestId("row-~local").closest("li");

        update({ items: [...items.slice(0, 4), { ...mine, key: "evt-4" }] });

        await waitFor(() => expect(screen.getByTestId("row-evt-4")).toBeInTheDocument());
        expect(screen.getByTestId("row-evt-4").closest("li")).toBe(row);
    });

    it("reports painted viewport rows after reveal without including overscan rows", async () => {
        const { vm } = makeFakeVm({ items: eventItems(30) });
        const painted = vi.fn();
        render(
            <div style={{ height: VIEWPORT_HEIGHT, width: 320 }}>
                <TimelineView vm={vm} renderItem={renderItem} onItemsPainted={painted} />
            </div>,
        );
        expect(painted).not.toHaveBeenCalled();
        await waitFor(() => expect(painted).toHaveBeenCalled());
        const items: TimelineItem[] = painted.mock.calls.at(-1)![0];
        expect(items.length).toBeGreaterThan(0);
        expect(items.length).toBeLessThan(30);
        const scroller = screen.getByTestId("timeline-scroller");
        expect(scroller).toHaveStyle({ visibility: "visible" });
        const viewport = scroller.getBoundingClientRect();
        for (const item of items) {
            const row = screen.getByTestId(`row-${item.key}`).getBoundingClientRect();
            expect(row.bottom).toBeGreaterThan(viewport.top);
            expect(row.top).toBeLessThan(viewport.bottom);
        }
    });

    it("does not report painted rows after unmounting before placement", async () => {
        const { vm } = makeFakeVm();
        const painted = vi.fn();
        const { unmount } = render(
            <div style={{ height: VIEWPORT_HEIGHT, width: 320 }}>
                <TimelineView vm={vm} renderItem={renderItem} onItemsPainted={painted} />
            </div>,
        );
        unmount();
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        expect(painted).not.toHaveBeenCalled();
    });

    it("reveals a short bottom-aligned list without waiting for the placement timeout", async () => {
        const { vm, actions, update } = makeFakeVm();
        render(
            <div style={{ height: VIEWPORT_HEIGHT, width: 320 }}>
                <TimelineView
                    vm={vm}
                    renderItem={(item) => (
                        <div data-testid={`row-${item.key}`} style={{ height: 30 }}>
                            {item.key}
                        </div>
                    )}
                />
            </div>,
        );
        update({ items: eventItems(8), alignToBottom: true, pendingAnchor: { targetKey: "evt-7", align: "end" } });
        // Shrinking below the estimate until the list fits in the viewport can leave the
        // virtualizer's cached offset above zero even though the browser clamps scrollTop.
        await waitFor(() => expect(actions.onAnchorReached).toHaveBeenCalled(), { timeout: 500 });
        // It reports the anchor it placed.
        expect(actions.onAnchorReached).toHaveBeenCalledWith("evt-7");
        const scroller = screen.getByTestId("timeline-scroller");
        expect(scroller.scrollTop).toBe(0);
        expect(screen.getByTestId("row-evt-7").getBoundingClientRect().bottom).toBeCloseTo(
            scroller.getBoundingClientRect().bottom,
            0,
        );
    });

    it("renders each item via the renderItem callback", async () => {
        const { vm } = makeFakeVm({ items: eventItems(5) });
        renderTimeline(vm);

        expect(await screen.findByTestId("row-evt-0")).toBeInTheDocument();
        expect(screen.getByTestId("row-evt-4")).toBeInTheDocument();
    });

    it.each(["end", "center", "start"] as const)(
        "starts near a delayed %s anchor and settles using measured variable row heights",
        async (align) => {
            const { vm, actions, update } = makeFakeVm();
            const rendered: number[] = [];
            actions.onAnchorReached.mockImplementation(() => update({ pendingAnchor: null }));
            render(
                <div style={{ height: VIEWPORT_HEIGHT, width: 320 }}>
                    <TimelineView
                        vm={vm}
                        renderItem={(item) => {
                            const index = Number(item.key.slice("evt-".length));
                            rendered.push(index);
                            return (
                                <div data-testid={`row-${item.key}`} style={{ height: ROW_HEIGHT + (index % 5) * 7 }}>
                                    {item.key}
                                </div>
                            );
                        }}
                    />
                </div>,
            );
            expect(rendered).toEqual([]);
            const index = align === "end" ? 49 : 35;
            update({
                items: eventItems(50),
                pendingAnchor: { targetKey: `evt-${index}`, align },
                atLiveEnd: align === "end",
            });
            // The first mounted range is near the requested message, with normal overscan.
            expect(rendered[0]).toBeGreaterThan(0);
            await waitFor(() => expect(actions.onAnchorReached).toHaveBeenCalledTimes(1), { timeout: 5000 });
            const scroller = screen.getByTestId("timeline-scroller");
            const row = screen.getByTestId(`row-evt-${index}`);
            await waitFor(() => {
                const viewport = scroller.getBoundingClientRect();
                const target = row.getBoundingClientRect();
                const actual =
                    align === "start"
                        ? target.top
                        : align === "center"
                          ? (target.top + target.bottom) / 2
                          : target.bottom;
                const expected =
                    align === "start"
                        ? viewport.top
                        : align === "center"
                          ? (viewport.top + viewport.bottom) / 2
                          : viewport.bottom;
                expect(actual).toBeCloseTo(expected, 0);
            });
            expect(scroller).toHaveStyle({ visibility: "visible" });
        },
    );

    it("places the first load and shows it before the first paint, when its rows are already mounted", () => {
        const { vm, actions } = makeFakeVm({ items: eventItems(30) });
        renderTimeline(vm);
        // No animation frame has run: the list was measured and scrolled in the commit that rendered it.
        const scroller = screen.getByTestId("timeline-scroller");
        expect(scroller).toHaveStyle({ visibility: "visible" });
        expect(actions.onAnchorReached).toHaveBeenCalledExactlyOnceWith(null);
        expect(screen.getByTestId("row-evt-29").getBoundingClientRect().bottom).toBeCloseTo(
            scroller.getBoundingClientRect().bottom,
            0,
        );
    });

    it.each([
        ["end", -18],
        ["center", 0],
        ["start", 18],
    ] as const)("places a %s anchor with the list padded, the padding kept in view at the ends", (align, expected) => {
        const index = align === "end" ? 49 : 35;
        const { vm, actions } = makeFakeVm({
            items: eventItems(50),
            pendingAnchor: { targetKey: `evt-${index}`, align },
            atLiveEnd: align === "end",
        });
        let offset: number | undefined;
        actions.onAnchorReached.mockImplementation(() => {
            const edge = (box: DOMRect): number =>
                align === "start" ? box.top : align === "center" ? (box.top + box.bottom) / 2 : box.bottom;
            const viewport = screen.getByTestId("timeline-scroller").getBoundingClientRect();
            offset = edge(screen.getByTestId(`row-evt-${index}`).getBoundingClientRect()) - edge(viewport);
        });
        render(
            <div style={{ height: VIEWPORT_HEIGHT, width: 320 }}>
                <TimelineView vm={vm} renderItem={renderItem} paddingBlock={18} />
            </div>,
        );
        expect(actions.onAnchorReached).toHaveBeenCalledExactlyOnceWith(`evt-${index}`);
        expect(Math.abs(offset! - expected)).toBeLessThan(1);
    });

    it.each(["end", "center", "start"] as const)(
        "places a %s anchor before the first paint, at the heights its rows measure",
        (align) => {
            const index = align === "end" ? 49 : 35;
            const { vm, actions } = makeFakeVm({
                items: eventItems(50),
                pendingAnchor: { targetKey: `evt-${index}`, align },
                atLiveEnd: align === "end",
            });
            // Where the target sits when the timeline is revealed, inside the commit and so before any paint.
            let offset: number | undefined;
            actions.onAnchorReached.mockImplementation(() => {
                const edge = (box: DOMRect): number =>
                    align === "start" ? box.top : align === "center" ? (box.top + box.bottom) / 2 : box.bottom;
                const viewport = screen.getByTestId("timeline-scroller").getBoundingClientRect();
                offset = edge(screen.getByTestId(`row-evt-${index}`).getBoundingClientRect()) - edge(viewport);
            });
            render(
                <div style={{ height: VIEWPORT_HEIGHT, width: 320 }}>
                    <TimelineView
                        vm={vm}
                        renderItem={(item) => (
                            // Heights differ from the estimate, so placing the anchor needs the measured ones.
                            <div
                                data-testid={`row-${item.key}`}
                                style={{ height: ROW_HEIGHT + (Number(item.key.slice("evt-".length)) % 5) * 7 }}
                            >
                                {item.key}
                            </div>
                        )}
                    />
                </div>,
            );
            expect(screen.getByTestId("timeline-scroller")).toHaveStyle({ visibility: "visible" });
            expect(actions.onAnchorReached).toHaveBeenCalledExactlyOnceWith(`evt-${index}`);
            expect(Math.abs(offset!)).toBeLessThan(1);
        },
    );

    it("keeps a first load placed before paint in place when a row above grows before the scroll is read back", async () => {
        const { vm, actions } = makeFakeVm({
            items: eventItems(50),
            pendingAnchor: { targetKey: "evt-35", align: "center" },
        });
        render(
            <div style={{ height: VIEWPORT_HEIGHT, width: 320 }}>
                <TimelineView
                    vm={vm}
                    renderItem={(item) => (
                        <div data-testid={`row-${item.key}`} style={{ height: ROW_HEIGHT }}>
                            {item.key}
                        </div>
                    )}
                />
            </div>,
        );
        expect(actions.onAnchorReached).toHaveBeenCalledExactlyOnceWith("evt-35");
        const scroller = screen.getByTestId("timeline-scroller");
        const centreOffset = (): number => {
            const viewport = scroller.getBoundingClientRect();
            const target = screen.getByTestId("row-evt-35").getBoundingClientRect();
            return (target.top + target.bottom) / 2 - (viewport.top + viewport.bottom) / 2;
        };
        expect(Math.abs(centreOffset())).toBeLessThan(1);
        // In the same task as the placement, before any scroll event: a mounted row above the anchor grows.
        const above = [...scroller.querySelectorAll<HTMLElement>("[data-testid^='row-evt-']")].find(
            (row) => row.getBoundingClientRect().bottom <= scroller.getBoundingClientRect().top,
        );
        expect(above).toBeDefined();
        above!.style.height = `${ROW_HEIGHT + 100}px`;
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        expect(Math.abs(centreOffset())).toBeLessThan(1);
    });

    it("reveals promptly when the first load cannot be placed before paint, without waiting for the timeout", async () => {
        // Rows far shorter than the estimate: the rows mounted first do not reach the anchor at their real heights,
        // so placing it before the first paint fails and the frames after it settle it instead.
        const { vm, actions } = makeFakeVm({
            items: eventItems(200),
            pendingAnchor: { targetKey: "evt-150", align: "center" },
        });
        const started = performance.now();
        let revealedAfter: number | undefined;
        actions.onAnchorReached.mockImplementation(() => (revealedAfter ??= performance.now() - started));
        render(
            <div style={{ height: VIEWPORT_HEIGHT, width: 320 }}>
                <TimelineView
                    vm={vm}
                    renderItem={(item) => (
                        <div data-testid={`row-${item.key}`} style={{ height: 12 }}>
                            {item.key}
                        </div>
                    )}
                />
            </div>,
        );
        await waitFor(() => expect(actions.onAnchorReached).toHaveBeenCalledOnce(), { timeout: 3000 });
        expect(revealedAfter).toBeLessThan(600);
        const scroller = screen.getByTestId("timeline-scroller");
        const viewport = scroller.getBoundingClientRect();
        const target = screen.getByTestId("row-evt-150").getBoundingClientRect();
        expect(Math.abs((target.top + target.bottom) / 2 - (viewport.top + viewport.bottom) / 2)).toBeLessThan(1);
    });

    it("stays hidden behind the cover then reveals after the anchor settles, when it cannot be placed at once", async () => {
        // Without ResizeObserver rows are measured as they mount, so placement settles over frames.
        vi.stubGlobal("ResizeObserver", undefined);
        try {
            // A list taller than the viewport so there is a real scroll offset to settle on.
            const { vm, actions } = makeFakeVm({ items: eventItems(30) });
            renderTimeline(vm);

            const scroller = screen.getByTestId("timeline-scroller");
            // Cover is up initially: the scroller is hidden and the anchor hasn't settled.
            expect(scroller).toHaveStyle({ visibility: "hidden" });
            expect(actions.onAnchorReached).not.toHaveBeenCalled();

            await waitFor(() => expect(actions.onAnchorReached).toHaveBeenCalledTimes(1), { timeout: 5000 });
            // Placed at the end without an anchor, so it reports none: an anchor set meanwhile must stay.
            expect(actions.onAnchorReached).toHaveBeenCalledWith(null);
            await waitFor(() => expect(scroller).toHaveStyle({ visibility: "visible" }));
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("reveals measured tall rows without synchronous row height reads", async () => {
        const { vm, actions, update } = makeFakeVm();
        const heightReads = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get");
        let initialGeometry: { top: number; bottom: number }[] = [];
        let initialTargetCenter = 0;
        let initialViewportCenter = 0;
        try {
            actions.onAnchorReached.mockImplementation(() => {
                const scroller = screen.getByTestId("timeline-scroller");
                initialGeometry = Array.from(scroller.querySelectorAll("[data-index]"), (element) => {
                    const { top, bottom } = element.getBoundingClientRect();
                    return { top, bottom };
                });
                const target = screen.getByTestId("row-evt-35").getBoundingClientRect();
                const viewport = scroller.getBoundingClientRect();
                initialTargetCenter = (target.top + target.bottom) / 2;
                initialViewportCenter = (viewport.top + viewport.bottom) / 2;
                update({ pendingAnchor: null });
            });
            render(
                <div style={{ height: VIEWPORT_HEIGHT, width: 320 }}>
                    <TimelineView
                        vm={vm}
                        renderItem={(item) => (
                            <div
                                data-testid={`row-${item.key}`}
                                style={{ height: 170 + (Number(item.key.slice("evt-".length)) % 3) * 110 }}
                            >
                                {item.key}
                            </div>
                        )}
                    />
                </div>,
            );
            update({ items: eventItems(50), pendingAnchor: { targetKey: "evt-35", align: "center" } });
            await waitFor(() => expect(actions.onAnchorReached).toHaveBeenCalledTimes(1), { timeout: 5000 });

            expect(initialGeometry.length).toBeGreaterThan(1);
            for (let index = 1; index < initialGeometry.length; index++) {
                expect(initialGeometry[index].top).toBeCloseTo(initialGeometry[index - 1].bottom, 0);
            }
            expect(initialTargetCenter).toBeCloseTo(initialViewportCenter, 0);
            expect(
                heightReads.mock.contexts.filter(
                    (element) => element instanceof HTMLElement && element.classList.contains("mx_TimelineView_tile"),
                ),
            ).toEqual([]);
        } finally {
            heightReads.mockRestore();
        }
    });

    it("uses synchronous measurements when ResizeObserver is unavailable", async () => {
        vi.stubGlobal("ResizeObserver", undefined);
        try {
            const { vm, actions } = makeFakeVm({ items: eventItems(30) });
            renderTimeline(vm);

            await waitFor(() => expect(actions.onAnchorReached).toHaveBeenCalledTimes(1), { timeout: 5000 });
            const scroller = screen.getByTestId("timeline-scroller");
            expect(scroller).toHaveStyle({ visibility: "visible" });
            expect(screen.getByTestId("row-evt-29").getBoundingClientRect().bottom).toBeCloseTo(
                scroller.getBoundingClientRect().bottom,
                0,
            );
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("reports the visible range and at-bottom state once live", async () => {
        const { vm, actions } = makeFakeVm({ items: eventItems(30) });
        renderTimeline(vm);

        await waitFor(() => expect(actions.onAnchorReached).toHaveBeenCalled(), { timeout: 5000 });
        await waitFor(() => expect(actions.onVisibleRangeChanged).toHaveBeenCalled());
        await waitFor(() => expect(actions.onAtBottomStateChange).toHaveBeenCalled());

        // Indices are 0-based into the items array.
        const [start, end] = actions.onVisibleRangeChanged.mock.calls.at(-1)!;
        expect(start).toBeGreaterThanOrEqual(0);
        expect(end).toBeGreaterThan(start);
    });

    it("pads the start and end of the list, and keeps the padding in view at either end", async () => {
        const { vm, actions } = makeFakeVm({ items: eventItems(30) });
        render(
            <div style={{ height: VIEWPORT_HEIGHT, width: 320 }}>
                <TimelineView vm={vm} renderItem={renderItem} paddingBlock={18} />
            </div>,
        );
        const scroller = screen.getByTestId("timeline-scroller");
        await waitFor(() => expect(actions.onAnchorReached).toHaveBeenCalled(), { timeout: 5000 });

        // Opened at the newest message, with the padding below it.
        await waitFor(() =>
            expect(screen.getByTestId("row-evt-29").getBoundingClientRect().bottom).toBeCloseTo(
                scroller.getBoundingClientRect().bottom - 18,
                0,
            ),
        );

        scroller.scrollTop = 0;
        await waitFor(() =>
            expect(screen.getByTestId("row-evt-0").getBoundingClientRect().top).toBeCloseTo(
                scroller.getBoundingClientRect().top + 18,
                0,
            ),
        );
    });

    it("keeps the margins between what a row holds, as the old timeline's list keeps them between its items", async () => {
        const { vm, actions } = makeFakeVm({ items: eventItems(1) });
        render(
            <div style={{ height: VIEWPORT_HEIGHT, width: 320 }}>
                <TimelineView
                    vm={vm}
                    renderItem={() => (
                        <>
                            <div data-testid="first" style={{ height: 20, marginBottom: 48 }} />
                            <div data-testid="second" style={{ height: 20, marginTop: 8 }} />
                        </>
                    )}
                />
            </div>,
        );
        await waitFor(() => expect(actions.onAnchorReached).toHaveBeenCalled(), { timeout: 5000 });

        const gap =
            screen.getByTestId("second").getBoundingClientRect().top -
            screen.getByTestId("first").getBoundingClientRect().bottom;
        expect(gap).toBe(56);
    });

    it("tells the view model when the start is no longer shown", async () => {
        const { vm, actions } = makeFakeVm({ items: eventItems(70) });
        renderTimeline(vm);
        const scroller = screen.getByTestId("timeline-scroller");
        await waitFor(() => expect(actions.onAnchorReached).toHaveBeenCalled(), { timeout: 5000 });
        // Opened at the newest messages, so the start was never shown.
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(actions.onStartLeft).not.toHaveBeenCalled();

        scroller.scrollTop = 0;
        await waitFor(() => expect(actions.onStartReached).toHaveBeenCalled());
        expect(actions.onStartLeft).not.toHaveBeenCalled();

        scroller.scrollTop = scroller.scrollHeight;
        await waitFor(() => expect(actions.onStartLeft).toHaveBeenCalledTimes(1));
    });

    it("reports the ends shown again for each placement, as the view model starts over with each load", async () => {
        // Too few rows to scroll, so the reader cannot bring an end into view again themselves.
        const { vm, actions, update } = makeFakeVm({ items: eventItems(3) });
        renderTimeline(vm);
        await waitFor(() => expect(actions.onStartReached).toHaveBeenCalledTimes(1), { timeout: 5000 });
        expect(actions.onEndReached).toHaveBeenCalledTimes(1);

        // The view model loads the same rows again, as when sync brings history that joins a summary, and places them.
        update({ items: eventItems(3), pendingAnchor: { targetKey: "evt-2", align: "end" } });
        await waitFor(() => expect(actions.onAnchorReached).toHaveBeenCalledWith("evt-2"));
        update({ pendingAnchor: null });

        await waitFor(() => expect(actions.onStartReached).toHaveBeenCalledTimes(2));
        expect(actions.onEndReached).toHaveBeenCalledTimes(2);
        // Once for each placement, not over and over while the list sits still.
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(actions.onStartReached).toHaveBeenCalledTimes(2);
        expect(actions.onStartLeft).not.toHaveBeenCalled();
    });

    it("re-renders when the view model pushes a new snapshot", async () => {
        const { vm, update } = makeFakeVm({ items: eventItems(5) });
        renderTimeline(vm);
        await screen.findByTestId("row-evt-0");

        update({ items: eventItems(6) });

        expect(await screen.findByTestId("row-evt-5")).toBeInTheDocument();
    });

    it("shows the jump-to-bottom control once revealed when scrolled off the bottom", async () => {
        const { vm, actions } = makeFakeVm({ items: eventItems(30), isAtBottom: false });
        renderTimeline(vm);

        const jumpToBottom = await screen.findByRole(
            "button",
            { name: "Scroll to most recent messages" },
            { timeout: 5000 },
        );

        const user = userEvent.setup();
        await user.click(jumpToBottom);
        expect(actions.onJumpToLive).toHaveBeenCalledTimes(1);
        // The View hands the VM its imperative scroll handle.
        expect(actions.onJumpToLive.mock.calls[0][0]).toBeTypeOf("function");
    });

    it("holds the newest message in place as a short live list grows past the viewport", async () => {
        const { vm, actions, update } = makeFakeVm({ items: eventItems(2, 20), alignToBottom: true });
        renderTimeline(vm);
        const scroller = screen.getByTestId("timeline-scroller");
        await waitFor(() => expect(actions.onAnchorReached).toHaveBeenCalled(), { timeout: 5000 });
        await waitFor(() => expect(scroller).toHaveStyle({ visibility: "visible" }));
        const newest = screen.getByTestId("row-evt-21");
        const bottom = (): number => newest.getBoundingClientRect().bottom;
        const viewportBottom = scroller.getBoundingClientRect().bottom;
        await waitFor(() => expect(bottom()).toBeCloseTo(viewportBottom, 0));

        // Retain the placement even if the bounded SDK window no longer reaches the live end.
        update({ atLiveEnd: false });
        await new Promise((resolve) => requestAnimationFrame(resolve));
        expect(bottom()).toBeCloseTo(viewportBottom, 0);

        // First prepend still fits; the next crosses from an unscrollable to a scrollable list.
        for (const count of [5, 22]) {
            update({ items: eventItems(count, 22 - count) });
            await waitFor(() => expect(screen.getByTestId("row-evt-21")).toBeInTheDocument());
            for (let frame = 0; frame < 5; frame++) {
                await new Promise((resolve) => requestAnimationFrame(resolve));
                expect(bottom()).toBeCloseTo(viewportBottom, 0);
            }
        }
    });

    it("remeasures a cached row when it mounts again with a different height", async () => {
        const { vm, actions } = makeFakeVm({ items: eventItems(70) });
        let latestHeight = ROW_HEIGHT;
        render(
            <div style={{ height: VIEWPORT_HEIGHT, width: 320 }}>
                <TimelineView
                    vm={vm}
                    renderItem={(item) => (
                        <div
                            data-testid={`row-${item.key}`}
                            style={{ height: item.key === "evt-69" ? latestHeight : ROW_HEIGHT }}
                        >
                            {item.key}
                        </div>
                    )}
                />
            </div>,
        );
        const scroller = screen.getByTestId("timeline-scroller");
        await waitFor(() => expect(actions.onAnchorReached).toHaveBeenCalled(), { timeout: 5000 });
        // Let the initial programmatic scroll retire before the reader scrolls away.
        await new Promise((resolve) => setTimeout(resolve, 100));
        scroller.scrollTop = 0;
        await waitFor(() => expect(screen.queryByTestId("row-evt-69")).not.toBeInTheDocument());

        latestHeight = 390;
        scroller.scrollTop = scroller.scrollHeight;

        await waitFor(() => {
            const latest = screen.getByTestId("row-evt-69").getBoundingClientRect();
            expect(latest.height).toBe(latestHeight);
            expect(latest.bottom).toBeCloseTo(scroller.getBoundingClientRect().bottom, 0);
        });
    });

    it("keeps the latest message at the bottom while a membership summary expands and collapses", async () => {
        const group: TimelineItem = { key: "members", kind: "event-group", events: [null, null, null] };
        const { vm, actions } = makeFakeVm({
            items: [...eventItems(2), group, ...eventItems(2, 2)],
            alignToBottom: true,
        });
        const Summary = (): React.JSX.Element => {
            const [expanded, setExpanded] = React.useState(false);
            return (
                <div style={{ height: expanded ? 500 : ROW_HEIGHT }}>
                    <button onClick={() => setExpanded(!expanded)}>{expanded ? "Collapse" : "Expand"}</button>
                </div>
            );
        };
        render(
            <div style={{ height: VIEWPORT_HEIGHT, width: 320 }}>
                <TimelineView
                    vm={vm}
                    renderItem={(item) => (item.kind === "event-group" ? <Summary /> : renderItem(item))}
                />
            </div>,
        );
        await waitFor(() => expect(actions.onAnchorReached).toHaveBeenCalled());
        const latestBottom = (): number => screen.getByTestId("row-evt-3").getBoundingClientRect().bottom;
        const viewportBottom = (): number => screen.getByTestId("timeline-scroller").getBoundingClientRect().bottom;
        await userEvent.click(screen.getByRole("button", { name: "Expand" }));
        await waitFor(() => expect(latestBottom()).toBeCloseTo(viewportBottom(), 0));
        // The toggle can scroll out of view on expansion; collapse through the rendered button.
        act(() => screen.getByRole("button", { name: "Collapse" }).click());
        await waitFor(() => expect(latestBottom()).toBeCloseTo(viewportBottom(), 0));
    });

    it("reports what is on screen after each placement, even at the same positions as before", async () => {
        const { vm, actions, update } = makeFakeVm({ items: eventItems(30) });
        actions.onAnchorReached.mockImplementation(() => update({ pendingAnchor: null }));
        // Rows exactly the size the view estimates, so new rows land where the old ones were and nothing moves.
        render(
            <div style={{ height: VIEWPORT_HEIGHT, width: 320 }}>
                <TimelineView
                    vm={vm}
                    renderItem={(item) => <div data-testid={`row-${item.key}`} style={{ height: 48 }} />}
                />
            </div>,
        );
        await waitFor(() => expect(actions.onVisibleRangeChanged).toHaveBeenCalled(), { timeout: 5000 });
        await new Promise((resolve) => setTimeout(resolve, 100));
        const [start, end] = actions.onVisibleRangeChanged.mock.calls.at(-1)!;
        actions.onVisibleRangeChanged.mockClear();

        // A reload replaces the rows with others the same size, placed at the newest again.
        update({ items: eventItems(30, 100), pendingAnchor: { targetKey: "evt-129", align: "end" } });

        await waitFor(() => expect(actions.onVisibleRangeChanged).toHaveBeenCalledWith(start, end));
    });

    describe("across reading visits", () => {
        const visit = (
            generation: number,
            rowsReady: boolean,
            placementRevision: number,
        ): TimelineViewSnapshot["visit"] => ({
            generation,
            rowsReady,
            placementRevision,
        });

        /** Render a live list of 30 rows placed at the newest, in visit 1, and wait until it has been reported. */
        const placedInFirstVisit = async (): Promise<FakeVm & { start: number; end: number }> => {
            const fake = makeFakeVm({ items: eventItems(30), visit: visit(1, true, 1) });
            renderTimeline(fake.vm);
            await waitFor(() => expect(fake.actions.onAtBottomStateChange).toHaveBeenCalledWith(true), {
                timeout: 5000,
            });
            await waitFor(() => expect(fake.actions.onVisibleRangeChanged).toHaveBeenCalled());
            await new Promise((resolve) => setTimeout(resolve, 100));
            const [start, end] = fake.actions.onVisibleRangeChanged.mock.calls.at(-1)!;
            for (const action of Object.values(fake.actions)) action.mockClear();
            return { ...fake, start, end };
        };

        it("reports nothing about an earlier visit's rows while a new visit waits for its own", async () => {
            const { actions, update } = await placedInFirstVisit();

            update({ visit: visit(2, false, 1) });
            screen.getByTestId("timeline-scroller").scrollTop = 0;
            await new Promise((resolve) => setTimeout(resolve, 100));

            expect(actions.onVisibleRangeChanged).not.toHaveBeenCalled();
            expect(actions.onAtBottomStateChange).not.toHaveBeenCalled();
            expect(actions.onStartReached).not.toHaveBeenCalled();
        });

        it("tells a new visit where the reader is once its rows are shown, though nothing moved", async () => {
            const { actions, update, start, end } = await placedInFirstVisit();

            // A new visit begins, and its rows turn out the same as the last one's, with the reader still at the newest.
            update({ visit: visit(2, false, 1) });
            update({ visit: visit(2, true, 2) });

            await waitFor(() => expect(actions.onVisibleRangeChanged).toHaveBeenCalledWith(start, end));
            // The bottom and the end are told again too, though they are as they were in the last visit.
            await waitFor(() => expect(actions.onAtBottomStateChange).toHaveBeenCalledWith(true));
            expect(actions.onEndReached).toHaveBeenCalled();
        });

        it("reports what it shows after a placement that takes the reader nowhere new", async () => {
            const { vm, actions, update } = makeFakeVm({ items: eventItems(30), visit: visit(1, true, 1) });
            render(
                <div style={{ height: VIEWPORT_HEIGHT, width: 320 }}>
                    <TimelineView
                        vm={vm}
                        renderItem={(item) => <div data-testid={`row-${item.key}`} style={{ height: 48 }} />}
                    />
                </div>,
            );
            await waitFor(() => expect(actions.onVisibleRangeChanged).toHaveBeenCalled(), { timeout: 5000 });
            await new Promise((resolve) => setTimeout(resolve, 100));
            const [start, end] = actions.onVisibleRangeChanged.mock.calls.at(-1)!;
            actions.onVisibleRangeChanged.mockClear();

            // A load replaces the rows with others the same size and asks for no placement of its own.
            update({ items: eventItems(30, 100), visit: visit(1, true, 2) });

            await waitFor(() => expect(actions.onVisibleRangeChanged).toHaveBeenCalledWith(start, end));
        });
    });

    describe("when a host lends it to one room at a time", () => {
        /** An execution whose answers the test sets; `next` gives a new one, as the host does when they change. */
        const gate = (
            revision = 1,
        ): { open: boolean; placed: boolean; revision: number; next: () => TimelineViewExecution } => {
            const state = {
                open: false,
                placed: true,
                revision,
                next: (): TimelineViewExecution => ({
                    revision: state.revision,
                    isCurrent: () => state.open,
                    onPlaced: () => state.placed,
                }),
            };
            return state;
        };
        const renderLent = (
            vm: TimelineViewModel,
            execution: TimelineViewExecution,
            onItemsPainted?: (items: TimelineItem[]) => void,
        ): ((next: TimelineViewExecution) => void) => {
            const tree = (current: TimelineViewExecution): React.ReactElement => (
                <div style={{ height: VIEWPORT_HEIGHT, width: 320 }}>
                    <TimelineView vm={vm} renderItem={renderItem} execution={current} onItemsPainted={onItemsPainted} />
                </div>
            );
            const { rerender } = render(tree(execution));
            return (next) => rerender(tree(next));
        };
        const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 150));

        it("does not place or report before execution is current", async () => {
            const { vm, actions } = makeFakeVm({ items: eventItems(30) });
            const execution = gate();
            const rerender = renderLent(vm, execution.next());
            await settle();

            expect(actions.onAnchorReached).not.toHaveBeenCalled();
            expect(actions.onVisibleRangeChanged).not.toHaveBeenCalled();
            expect(screen.getByTestId("timeline-scroller")).toHaveStyle({ visibility: "hidden" });

            execution.open = true;
            rerender(execution.next());
            await waitFor(() => expect(actions.onAnchorReached).toHaveBeenCalled(), { timeout: 5000 });
            await waitFor(() => expect(actions.onVisibleRangeChanged).toHaveBeenCalled());
            expect(screen.getByTestId("timeline-scroller")).toHaveStyle({ visibility: "visible" });
        });

        it("waits for the rows its view model accepted for the visit it is on", async () => {
            const { vm, actions, update } = makeFakeVm({
                items: eventItems(30),
                visit: { generation: 2, rowsReady: false, placementRevision: 1 },
            });
            const execution = gate();
            execution.open = true;
            renderLent(vm, execution.next());
            await settle();
            expect(actions.onAnchorReached).not.toHaveBeenCalled();

            update({ visit: { generation: 2, rowsReady: true, placementRevision: 2 } });
            await waitFor(() => expect(actions.onAnchorReached).toHaveBeenCalled(), { timeout: 5000 });
        });

        it("abandons a placement its host no longer allows, and places once allowed again", async () => {
            const { vm, actions } = makeFakeVm({ items: eventItems(30) });
            const execution = gate();
            execution.open = true;
            execution.placed = false;
            const rerender = renderLent(vm, execution.next());
            await settle();

            expect(actions.onAnchorReached).not.toHaveBeenCalled();
            expect(screen.getByTestId("timeline-scroller")).toHaveStyle({ visibility: "hidden" });

            execution.placed = true;
            rerender(execution.next());
            await waitFor(() => expect(actions.onAnchorReached).toHaveBeenCalled(), { timeout: 5000 });
        });

        it("stops placing when its host stops allowing it part-way, and places once allowed again", async () => {
            // Without ResizeObserver rows are measured as they mount, so placement goes on over frames.
            vi.stubGlobal("ResizeObserver", undefined);
            try {
                const { vm, actions, update } = makeFakeVm({ items: eventItems(30) });
                const execution = gate();
                execution.open = true;
                const rerender = renderLent(vm, execution.next());
                const scroller = screen.getByTestId("timeline-scroller");
                expect(actions.onAnchorReached).not.toHaveBeenCalled();

                execution.open = false;
                const offset = scroller.scrollTop;
                // A commit while it is closed tries to place before the paint, as every commit while placing does.
                update({ numUnreadMessages: 1 });
                await settle();

                expect(actions.onAnchorReached).not.toHaveBeenCalled();
                expect(scroller).toHaveStyle({ visibility: "hidden" });
                expect(scroller.scrollTop).toBe(offset);

                execution.open = true;
                rerender(execution.next());
                await waitFor(() => expect(actions.onAnchorReached).toHaveBeenCalled(), { timeout: 5000 });
            } finally {
                vi.unstubAllGlobals();
            }
        });

        it("does not tell its view model of a later jump its host refuses", async () => {
            const { vm, actions, update } = makeFakeVm({ items: eventItems(60) });
            const execution = gate();
            execution.open = true;
            renderLent(vm, execution.next());
            await waitFor(() => expect(actions.onAnchorReached).toHaveBeenCalled(), { timeout: 5000 });
            actions.onAnchorReached.mockClear();

            execution.placed = false;
            update({ pendingAnchor: { targetKey: "evt-5", align: "start" } });
            await settle();

            expect(actions.onAnchorReached).not.toHaveBeenCalled();
        });

        it("drops painted callbacks its host no longer allows", async () => {
            const { vm, actions, update } = makeFakeVm({ items: eventItems(30) });
            const painted = vi.fn();
            const execution = gate();
            execution.open = true;
            renderLent(vm, execution.next(), painted);
            await waitFor(() => expect(painted).toHaveBeenCalled(), { timeout: 5000 });
            expect(actions.onAnchorReached).toHaveBeenCalled();

            // The host closes, and a frame is scheduled and drawn while it is closed.
            execution.open = false;
            painted.mockClear();
            update({ numUnreadMessages: 1 });
            await settle();
            expect(painted).not.toHaveBeenCalled();
        });

        it("places its anchor again and reports what it shows for a new execution revision", async () => {
            const { vm, actions } = makeFakeVm({
                items: eventItems(60),
                pendingAnchor: { targetKey: "evt-10", align: "start" },
            });
            const execution = gate();
            execution.open = true;
            const rerender = renderLent(vm, execution.next());
            await waitFor(() => expect(actions.onAnchorReached).toHaveBeenCalledWith("evt-10"), { timeout: 5000 });
            const scroller = screen.getByTestId("timeline-scroller");
            const placedAt = scroller.scrollTop;

            // The reader scrolls away; the view is then moved, and has to place its anchor again.
            act(() => {
                scroller.scrollTop = placedAt + 400;
            });
            await settle();
            actions.onAnchorReached.mockClear();
            execution.revision = 2;
            rerender(execution.next());

            await waitFor(() => expect(actions.onAnchorReached).toHaveBeenCalledWith("evt-10"));
            expect(Math.abs(scroller.scrollTop - placedAt)).toBeLessThan(ROW_HEIGHT);
        });

        it("reports an unchanged range again after a new execution revision", async () => {
            const { vm, actions } = makeFakeVm({ items: eventItems(30) });
            const execution = gate();
            execution.open = true;
            const rerender = renderLent(vm, execution.next());
            await waitFor(() => expect(actions.onVisibleRangeChanged).toHaveBeenCalled(), { timeout: 5000 });
            await settle();
            const [start, end] = actions.onVisibleRangeChanged.mock.calls.at(-1)!;
            actions.onVisibleRangeChanged.mockClear();
            actions.onAtBottomStateChange.mockClear();

            execution.revision = 2;
            rerender(execution.next());

            await waitFor(() => expect(actions.onVisibleRangeChanged).toHaveBeenCalledWith(start, end));
            expect(actions.onAtBottomStateChange).toHaveBeenCalledWith(true);
        });

        it("does not report what the reader scrolls to while its host does not allow it", async () => {
            const { vm, actions } = makeFakeVm({ items: eventItems(60) });
            const execution = gate();
            execution.open = true;
            renderLent(vm, execution.next());
            await waitFor(() => expect(actions.onVisibleRangeChanged).toHaveBeenCalled(), { timeout: 5000 });
            await settle();
            actions.onVisibleRangeChanged.mockClear();
            actions.onAtBottomStateChange.mockClear();

            execution.open = false;
            act(() => {
                screen.getByTestId("timeline-scroller").scrollTop = 0;
            });
            await settle();

            expect(actions.onVisibleRangeChanged).not.toHaveBeenCalled();
            expect(actions.onAtBottomStateChange).not.toHaveBeenCalled();
        });

        it("does not jump to a message while its host does not allow it", async () => {
            const { vm, actions, update } = makeFakeVm({ items: eventItems(60) });
            const execution = gate();
            execution.open = true;
            renderLent(vm, execution.next());
            await waitFor(() => expect(actions.onAnchorReached).toHaveBeenCalled(), { timeout: 5000 });
            const scroller = screen.getByTestId("timeline-scroller");
            const placedAt = scroller.scrollTop;
            actions.onAnchorReached.mockClear();

            execution.open = false;
            update({ pendingAnchor: { targetKey: "evt-5", align: "start" } });
            await settle();

            expect(actions.onAnchorReached).not.toHaveBeenCalled();
            expect(scroller.scrollTop).toBe(placedAt);
        });

        it("does not scroll for an overlay button while its host does not allow it", async () => {
            const { vm, actions } = makeFakeVm({ items: eventItems(60), isAtBottom: false, atLiveEnd: true });
            const execution = gate();
            execution.open = true;
            renderLent(vm, execution.next());
            await waitFor(() => expect(actions.onAnchorReached).toHaveBeenCalled(), { timeout: 5000 });
            const scroller = screen.getByTestId("timeline-scroller");
            act(() => {
                scroller.scrollTop = 0;
            });
            await settle();

            execution.open = false;
            // The jump to the newest message asks for an immediate scroll, which a closed view ignores.
            actions.onJumpToLive.mockImplementation((scrollNow: ImmediateScroll) =>
                scrollNow({ targetKey: "evt-59", align: "end" }),
            );
            await userEvent.click(await screen.findByRole("button", { name: "Scroll to most recent messages" }));
            await settle();
            expect(scroller.scrollTop).toBe(0);
        });
    });

    describe("placing a row a third of the way down, as the old timeline places the unread line", () => {
        const thirdDown = (key: string): number =>
            screen.getByTestId(`row-${key}`).getBoundingClientRect().bottom -
            screen.getByTestId("timeline-scroller").getBoundingClientRect().top;

        it("on the first load", async () => {
            const { vm, actions } = makeFakeVm({
                items: eventItems(60),
                pendingAnchor: { targetKey: "evt-30", align: "third" },
            });
            renderTimeline(vm);
            await waitFor(() => expect(actions.onAnchorReached).toHaveBeenCalled(), { timeout: 5000 });
            expect(thirdDown("evt-30")).toBeCloseTo(VIEWPORT_HEIGHT / 3, 0);
        });

        it("when jumping there later", async () => {
            const { vm, actions, update } = makeFakeVm({ items: eventItems(60) });
            renderTimeline(vm);
            await waitFor(() => expect(actions.onAnchorReached).toHaveBeenCalled(), { timeout: 5000 });

            update({ pendingAnchor: { targetKey: "evt-20", align: "third" } });

            // A later jump scrolls once, from estimated heights for rows not drawn yet, as for any alignment: it lands
            // within a row of the place.
            await waitFor(() => expect(Math.abs(thirdDown("evt-20") - VIEWPORT_HEIGHT / 3)).toBeLessThan(ROW_HEIGHT));
        });
    });

    it("keeps short anchored lists at the top", async () => {
        const { vm, actions } = makeFakeVm({
            items: eventItems(2),
            pendingAnchor: { targetKey: "evt-0", align: "center" },
            alignToBottom: false,
        });
        renderTimeline(vm);
        await waitFor(() => expect(actions.onAnchorReached).toHaveBeenCalled(), { timeout: 5000 });
        expect(screen.getByTestId("row-evt-0").getBoundingClientRect().top).toBeCloseTo(
            screen.getByTestId("timeline-scroller").getBoundingClientRect().top,
            0,
        );
    });

    describe("when messages arrive at the bottom", () => {
        const distanceFromBottom = (el: HTMLElement): number => el.scrollHeight - el.scrollTop - el.clientHeight;

        it("never tells the view model the reader left the bottom while it follows them", async () => {
            const { vm, actions, update } = makeFakeVm({ items: eventItems(30) });
            renderTimeline(vm);
            await waitFor(() => expect(actions.onAnchorReached).toHaveBeenCalled(), { timeout: 5000 });
            await waitFor(() => expect(actions.onAtBottomStateChange).toHaveBeenLastCalledWith(true));
            actions.onAtBottomStateChange.mockClear();

            // A burst, as when sync brings many messages at once.
            for (let count = 31; count <= 60; count++) update({ items: eventItems(count) });

            const scroller = screen.getByTestId("timeline-scroller");
            await waitFor(() => expect(screen.getByTestId("row-evt-59")).toBeInTheDocument());
            await waitFor(() => expect(distanceFromBottom(scroller)).toBeLessThanOrEqual(1));
            expect(actions.onAtBottomStateChange).not.toHaveBeenCalledWith(false);
        });

        it("follows a short list that grows past the screen, as in a new room", async () => {
            const { vm, actions, update } = makeFakeVm({ items: eventItems(3) });
            renderTimeline(vm);
            await waitFor(() => expect(actions.onAnchorReached).toHaveBeenCalled(), { timeout: 5000 });
            await waitFor(() => expect(actions.onAtBottomStateChange).toHaveBeenLastCalledWith(true));
            actions.onAtBottomStateChange.mockClear();

            for (let count = 4; count <= 50; count++) update({ items: eventItems(count) });

            const scroller = screen.getByTestId("timeline-scroller");
            await waitFor(() => expect(screen.getByTestId("row-evt-49")).toBeInTheDocument());
            await waitFor(() => expect(distanceFromBottom(scroller)).toBeLessThanOrEqual(1));
            expect(actions.onAtBottomStateChange).not.toHaveBeenCalledWith(false);
        });

        it("stays at the bottom when new rows grow just after they arrive, as a sent message's does", async () => {
            // A message being sent is drawn, then grows a little once the server has it.
            const Growing = ({ id }: { id: string }): React.JSX.Element => {
                const [grown, setGrown] = React.useState(false);
                React.useEffect(() => {
                    const timer = setTimeout(() => setGrown(true), 30);
                    return () => clearTimeout(timer);
                }, []);
                return <div data-testid={`row-${id}`} style={{ height: grown ? ROW_HEIGHT + 27 : ROW_HEIGHT }} />;
            };
            const { vm, actions, update } = makeFakeVm({ items: eventItems(3) });
            render(
                <div style={{ height: VIEWPORT_HEIGHT, width: 320 }}>
                    <TimelineView vm={vm} renderItem={(item) => <Growing id={item.key} />} />
                </div>,
            );
            await waitFor(() => expect(actions.onAnchorReached).toHaveBeenCalled(), { timeout: 5000 });

            for (let count = 4; count <= 30; count++) {
                update({ items: eventItems(count) });
                await new Promise((resolve) => setTimeout(resolve, 15));
            }

            const scroller = screen.getByTestId("timeline-scroller");
            await waitFor(() => expect(screen.getByTestId("row-evt-29")).toBeInTheDocument());
            await waitFor(() => expect(distanceFromBottom(scroller)).toBeLessThanOrEqual(1), { timeout: 2000 });
        });

        it("stays at the bottom when the room's start arrives and is drawn around the row at the top of the screen", async () => {
            // A new encrypted room's first screen, as drawn while its start loads: a spinner, two settings changes, the
            // tall "encryption enabled" notice, another change, then the messages, the first with its sender.
            const row = (key: string): TimelineItem => ({ ...eventItems(1)[0], key });
            const heights: Record<string, number> = {
                [BACKWARD_LOADING_KEY]: 32,
                "change-1": 22,
                "change-2": 22,
                "encryption": 197,
                "change-3": 22,
                "date": 34,
                "creation": 229,
                "message-0": 65,
            };
            const messages = Array.from({ length: 14 }, (_, i) => row(`message-${i}`));
            const { vm, actions, update } = makeFakeVm({
                items: [
                    { key: BACKWARD_LOADING_KEY, kind: "loading" },
                    ...["change-1", "change-2", "encryption", "change-3"].map(row),
                    ...messages,
                ],
            });
            actions.onAnchorReached.mockImplementation(() => update({ pendingAnchor: null }));
            render(
                <div style={{ height: 577, width: 320 }}>
                    <TimelineView
                        vm={vm}
                        paddingBlock={18}
                        renderItem={(item) => (
                            <div data-testid={`row-${item.key}`} style={{ height: heights[item.key] ?? 27 }} />
                        )}
                    />
                </div>,
            );
            await waitFor(() => expect(actions.onAtBottomStateChange).toHaveBeenLastCalledWith(true), {
                timeout: 5000,
            });
            const scroller = screen.getByTestId("timeline-scroller");
            expect(distanceFromBottom(scroller)).toBeLessThanOrEqual(1);

            // The room's start arrives: a date takes the spinner's place and the settings changes become the room's
            // creation, drawn below the notice at the top of the screen and much taller than a row is first given.
            update({
                items: [
                    { key: "date", kind: "event" } as TimelineItem,
                    row("encryption"),
                    row("creation"),
                    ...messages,
                ],
            });

            for (let frame = 0; frame < 10; frame++) await new Promise((resolve) => requestAnimationFrame(resolve));
            expect(distanceFromBottom(scroller)).toBeLessThanOrEqual(1);
            expect(actions.onAtBottomStateChange).not.toHaveBeenCalledWith(false);
        });

        it("stays at the newest message it was placed at when older history starts loading above", async () => {
            // A little more than a screenful, as in a new room: the spinner above is near enough to be drawn.
            const items = eventItems(9);
            const { vm, actions, update } = makeFakeVm({ items, pendingAnchor: { targetKey: "evt-8", align: "end" } });
            // As the view model does once it takes note of the placement: it starts loading older history, which shows
            // as a spinner above the messages, smaller than the height rows are first given.
            // It does so at once, so the spinner arrives before the placed list is first painted.
            actions.onAnchorReached.mockImplementation(() =>
                update({ pendingAnchor: null, items: [{ key: BACKWARD_LOADING_KEY, kind: "loading" }, ...items] }),
            );
            render(
                <div style={{ height: VIEWPORT_HEIGHT, width: 320 }}>
                    <TimelineView
                        vm={vm}
                        renderItem={(item) => (
                            <div
                                data-testid={`row-${item.key}`}
                                style={{ height: item.kind === "loading" ? 32 : ROW_HEIGHT }}
                            />
                        )}
                    />
                </div>,
            );
            await waitFor(() => expect(screen.getByTestId(`row-${BACKWARD_LOADING_KEY}`)).toBeInTheDocument(), {
                timeout: 5000,
            });

            const scroller = screen.getByTestId("timeline-scroller");
            for (let frame = 0; frame < 10; frame++) await new Promise((resolve) => requestAnimationFrame(resolve));
            expect(distanceFromBottom(scroller)).toBeLessThanOrEqual(1);
            expect(actions.onAtBottomStateChange).not.toHaveBeenCalledWith(false);
        });

        it("stays at the bottom while the reader's own messages are sent one after another", async () => {
            // Each message shows first as the reader's own copy, keyed by its transaction, then takes the server's
            // id. The newest message also carries the "sent" mark, which the one before it gives up.
            const rows = (sent: number, pending: boolean): TimelineItem[] => [
                ...eventItems(sent),
                ...(pending ? [{ ...eventItems(1, sent)[0], key: `~txn-${sent}` }] : []),
            ];
            const { vm, actions, update } = makeFakeVm({ items: rows(3, false) });
            const heightOf = (item: TimelineItem, items: TimelineItem[]): number =>
                item === items.at(-1) && !item.key.startsWith("~") ? ROW_HEIGHT + 27 : ROW_HEIGHT;
            let current = rows(3, false);
            render(
                <div style={{ height: VIEWPORT_HEIGHT, width: 320 }}>
                    <TimelineView
                        vm={vm}
                        renderItem={(item) => (
                            <div data-testid={`row-${item.key}`} style={{ height: heightOf(item, current) }} />
                        )}
                    />
                </div>,
            );
            await waitFor(() => expect(actions.onAnchorReached).toHaveBeenCalled(), { timeout: 5000 });

            for (let sent = 3; sent < 40; sent++) {
                current = rows(sent, true);
                update({ items: current });
                await new Promise((resolve) => setTimeout(resolve, 10));
                current = rows(sent + 1, false);
                update({ items: current });
                await new Promise((resolve) => setTimeout(resolve, 10));
            }

            const scroller = screen.getByTestId("timeline-scroller");
            await waitFor(() => expect(screen.getByTestId("row-evt-39")).toBeInTheDocument(), { timeout: 2000 });
            await waitFor(() => expect(distanceFromBottom(scroller)).toBeLessThanOrEqual(1), { timeout: 2000 });
        });

        it("leaves a reader who scrolls up as rows arrive where they scrolled to", async () => {
            const { vm, actions, update } = makeFakeVm({ items: eventItems(30) });
            renderTimeline(vm);
            await waitFor(() => expect(actions.onAnchorReached).toHaveBeenCalled(), { timeout: 5000 });
            await waitFor(() => expect(actions.onAtBottomStateChange).toHaveBeenLastCalledWith(true));
            await new Promise((resolve) => setTimeout(resolve, 100));
            const scroller = screen.getByTestId("timeline-scroller");

            // A row arrives, moving the end away, and the reader scrolls up before anything has followed it.
            update({ items: eventItems(31) });
            scroller.scrollTop = 100;

            await new Promise((resolve) => setTimeout(resolve, 200));
            expect(scroller.scrollTop).toBeLessThan(200);
            expect(actions.onAtBottomStateChange).toHaveBeenLastCalledWith(false);
        });

        it("still tells the view model when the reader scrolls up", async () => {
            const { vm, actions, update } = makeFakeVm({ items: eventItems(30) });
            renderTimeline(vm);
            await waitFor(() => expect(actions.onAnchorReached).toHaveBeenCalled(), { timeout: 5000 });
            await waitFor(() => expect(actions.onAtBottomStateChange).toHaveBeenLastCalledWith(true));
            // Let the first load's placement finish steering, or it would undo the scroll below.
            await new Promise((resolve) => setTimeout(resolve, 100));

            screen.getByTestId("timeline-scroller").scrollTop = 100;

            await waitFor(() => expect(actions.onAtBottomStateChange).toHaveBeenLastCalledWith(false));
            update({ items: eventItems(31) });
            await new Promise((resolve) => setTimeout(resolve, 100));
            expect(actions.onAtBottomStateChange).toHaveBeenLastCalledWith(false);
        });

        it("lets a reader scroll up a few pixels at a time, as with a trackpad", async () => {
            const { vm, actions } = makeFakeVm({ items: eventItems(30) });
            renderTimeline(vm);
            await waitFor(() => expect(actions.onAtBottomStateChange).toHaveBeenLastCalledWith(true));
            await new Promise((resolve) => setTimeout(resolve, 200));
            const scroller = screen.getByTestId("timeline-scroller");
            const bottom = scroller.scrollTop;

            // Each step is within the tolerance for being at the bottom; together they are not.
            for (let step = 0; step < 10; step++) {
                scroller.scrollTop -= 3;
                await new Promise((resolve) => setTimeout(resolve, 200));
            }

            // Rows above, measured as they come into view, can take the reader a little further up; never back down.
            expect(scroller.scrollTop).toBeLessThanOrEqual(bottom - 29);
            expect(actions.onAtBottomStateChange).toHaveBeenLastCalledWith(false);
        });

        it("never takes a reader back to the bottom from a message they were taken to meanwhile", async () => {
            const { vm, actions, update } = makeFakeVm({ items: eventItems(30) });
            renderTimeline(vm);
            await waitFor(() => expect(actions.onAtBottomStateChange).toHaveBeenLastCalledWith(true));
            await new Promise((resolve) => setTimeout(resolve, 200));
            actions.onAnchorReached.mockImplementation(() => update({ pendingAnchor: null }));

            // Many rows arrive, and before the next frame the reader is taken to one of them, below where they were.
            // Holding the frames back and running them all afterwards also runs any the view tried to cancel.
            const frames: FrameRequestCallback[] = [];
            const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
                frames.push(callback);
                return -frames.length;
            });
            try {
                update({ items: eventItems(60) });
                update({ pendingAnchor: { targetKey: "evt-35", align: "center" } });
            } finally {
                requestFrame.mockRestore();
            }
            for (const frame of frames) frame(performance.now());
            await new Promise((resolve) => setTimeout(resolve, 300));

            const middle = (box: DOMRect): number => (box.top + box.bottom) / 2;
            const viewport = screen.getByTestId("timeline-scroller").getBoundingClientRect();
            const row = screen.getByTestId("row-evt-35").getBoundingClientRect();
            expect(Math.abs(middle(row) - middle(viewport))).toBeLessThan(ROW_HEIGHT);
        });
    });

    describe("when the viewport changes height", () => {
        // The view is height:100%, so re-rendering the wrapper with a new height is how the composer
        // growing, or a banner appearing above the timeline, reaches the scroller.
        function renderResizable(vm: TimelineViewModel, height: number): { resize: (h: number) => void } {
            const view = (h: number): React.ReactElement => (
                <div style={{ height: h, width: 320 }}>
                    <TimelineView vm={vm} renderItem={renderItem} />
                </div>
            );
            const result = render(view(height));
            return { resize: (h) => result.rerender(view(h)) };
        }

        const distanceFromBottom = (el: HTMLElement): number => el.scrollHeight - el.scrollTop - el.clientHeight;
        // Long enough for TanStack's scroll corrections to finish, or for a wrongful scroll to show.
        const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 100));

        it("keeps a reader who was at the bottom at the bottom when the viewport shrinks", async () => {
            const { vm, actions } = makeFakeVm({ items: eventItems(30) });
            const { resize } = renderResizable(vm, VIEWPORT_HEIGHT);
            const scroller = screen.getByTestId("timeline-scroller");
            await waitFor(() => expect(actions.onAnchorReached).toHaveBeenCalled(), { timeout: 5000 });
            await waitFor(() => expect(actions.onAtBottomStateChange).toHaveBeenLastCalledWith(true));
            expect(distanceFromBottom(scroller)).toBeLessThanOrEqual(1);
            actions.onAtBottomStateChange.mockClear();

            resize(VIEWPORT_HEIGHT - 60);

            await waitFor(() => expect(scroller.clientHeight).toBe(VIEWPORT_HEIGHT - 60));
            await waitFor(() => expect(distanceFromBottom(scroller)).toBeLessThanOrEqual(1));
            // The view model is never told the reader left the bottom: they did not.
            expect(actions.onAtBottomStateChange).not.toHaveBeenCalledWith(false);
        });

        it("leaves the scroll position alone when the reader was not at the bottom", async () => {
            const { vm, actions } = makeFakeVm({ items: eventItems(30) });
            const { resize } = renderResizable(vm, VIEWPORT_HEIGHT);
            const scroller = screen.getByTestId("timeline-scroller");
            await waitFor(() => expect(actions.onAnchorReached).toHaveBeenCalled(), { timeout: 5000 });
            // The first load's scrollToIndex keeps steering back to its target for a moment; let
            // it settle, or it would undo the reader's scroll below.
            await settle();
            scroller.scrollTop = 200;
            await waitFor(() => expect(actions.onAtBottomStateChange).toHaveBeenLastCalledWith(false));
            // Rows the first load did not render are measured as the reader scrolls to them, and the scroll
            // position absorbs their real heights so nothing on screen moves. Read where that left it.
            await settle();
            const readerPosition = scroller.scrollTop;

            resize(VIEWPORT_HEIGHT - 60);

            await waitFor(() => expect(scroller.clientHeight).toBe(VIEWPORT_HEIGHT - 60));
            // Give the view time to scroll, in case it wrongly does.
            await settle();
            expect(scroller.scrollTop).toBe(readerPosition);
        });

        it("keeps a reader at the bottom when the window shrinks and some rows shrink with it", async () => {
            // Every fourth row is sized as a share of the window height, like a collapsed code
            // block, so it changes height in the same frame as the viewport.
            const renderWindowSizedItem = (item: TimelineItem): React.ReactNode => (
                <div
                    data-testid={`row-${item.key}`}
                    style={{ height: Number(item.key.slice("evt-".length)) % 4 === 0 ? "30vh" : ROW_HEIGHT }}
                >
                    {item.key}
                </div>
            );
            const { vm, actions } = makeFakeVm({ items: eventItems(30) });
            render(
                <div style={{ height: "50vh", width: 320 }}>
                    <TimelineView vm={vm} renderItem={renderWindowSizedItem} />
                </div>,
            );
            const scroller = screen.getByTestId("timeline-scroller");
            await waitFor(() => expect(actions.onAnchorReached).toHaveBeenCalled(), { timeout: 5000 });
            await waitFor(() => expect(actions.onAtBottomStateChange).toHaveBeenLastCalledWith(true));
            await settle();
            actions.onAtBottomStateChange.mockClear();

            const { innerWidth: width, innerHeight: height } = window;
            try {
                // Shrink in steps, as dragging the window edge does.
                for (const shrinkBy of [60, 120, 180]) {
                    await page.viewport(width, height - shrinkBy);
                    await waitFor(() => expect(scroller.clientHeight).toBe(Math.round((height - shrinkBy) / 2)));
                    await settle();
                    expect(distanceFromBottom(scroller)).toBeLessThanOrEqual(1);
                }
            } finally {
                await page.viewport(width, height);
            }
            expect(actions.onAtBottomStateChange).not.toHaveBeenCalledWith(false);
        });
    });
});
