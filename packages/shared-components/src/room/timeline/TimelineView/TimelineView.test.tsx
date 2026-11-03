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
import type { TimelineItem, TimelineViewModel, TimelineViewSnapshot } from "./types";

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

    it("stays hidden behind the cover then reveals after the anchor settles", async () => {
        // A list taller than the viewport so there is a real scroll offset to settle on.
        const { vm, actions } = makeFakeVm({ items: eventItems(30) });
        renderTimeline(vm);

        const scroller = screen.getByTestId("timeline-scroller");
        // Cover is up initially: the scroller is hidden and the anchor hasn't settled.
        expect(scroller).toHaveStyle({ visibility: "hidden" });
        expect(actions.onAnchorReached).not.toHaveBeenCalled();

        await waitFor(() => expect(actions.onAnchorReached).toHaveBeenCalledTimes(1), { timeout: 5000 });
        await waitFor(() => expect(scroller).toHaveStyle({ visibility: "visible" }));
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
            await settle();
            expect(scroller.scrollTop).toBe(200);

            resize(VIEWPORT_HEIGHT - 60);

            await waitFor(() => expect(scroller.clientHeight).toBe(VIEWPORT_HEIGHT - 60));
            // Give the view time to scroll, in case it wrongly does.
            await settle();
            expect(scroller.scrollTop).toBe(200);
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
