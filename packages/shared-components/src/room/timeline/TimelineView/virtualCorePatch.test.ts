/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// Tests for Aether's patch to @tanstack/virtual-core.

import { describe, expect, it, vi } from "vitest";
import {
    Virtualizer,
    elementScroll,
    observeElementOffset,
    observeElementRect,
    observeWindowOffset,
    observeWindowRect,
    windowScroll,
    type VirtualizerOptions,
} from "@tanstack/react-virtual";

function makeVirtualizer(
    onChange: () => void,
    count = 20,
): Virtualizer<HTMLDivElement, HTMLDivElement> & { scroller: HTMLDivElement } {
    const scroller = document.createElement("div");
    scroller.style.height = "300px";
    scroller.style.overflow = "auto";
    // Room to scroll, with some to spare for rows that grow.
    const content = document.createElement("div");
    content.style.height = `${count * 40 + 1000}px`;
    scroller.append(content);
    document.body.append(scroller);
    const virtualizer = new Virtualizer<HTMLDivElement, HTMLDivElement>({
        count,
        estimateSize: () => 40,
        getScrollElement: () => scroller,
        scrollToFn: elementScroll,
        observeElementOffset,
        observeElementRect,
        onChange,
    });
    virtualizer._willUpdate();
    return Object.assign(virtualizer, { scroller });
}

describe("virtual-core patch", () => {
    it("resizes several items as one batch, telling its listener once", () => {
        const onChange = vi.fn();
        const virtualizer = makeVirtualizer(onChange);
        onChange.mockClear();
        virtualizer.resizeItems([
            [0, 50],
            [1, 60],
            [2, 70],
        ]);
        expect(onChange).toHaveBeenCalledOnce();
        expect(virtualizer.getTotalSize()).toBe(50 + 60 + 70 + 17 * 40);

        // Each separate resize tells it again.
        onChange.mockClear();
        virtualizer.resizeItem(3, 50);
        virtualizer.resizeItem(4, 50);
        expect(onChange).toHaveBeenCalledTimes(2);
    });

    it("compensates a row above that grows before the scroll is read back, from the offset scrolled to", () => {
        const virtualizer = makeVirtualizer(() => {}, 50);
        // Written through the virtualizer, which notes the offset it means to be at.
        virtualizer.scrollToOffsetNow(1000);
        expect(virtualizer.scroller.scrollTop).toBe(1000);
        // A row above the viewport grows by 100 in the same task, before any scroll event.
        virtualizer.resizeItem(5, 140);
        expect(virtualizer.scroller.scrollTop).toBe(1100);
        virtualizer.scroller.remove();
    });

    it("keeps what it scrolled to in place when rows are added above before the scroll is read back", () => {
        const keys = Array.from({ length: 50 }, (_, i) => `row-${i}`);
        const virtualizer = makeVirtualizer(() => {}, 50);
        virtualizer.setOptions({ ...virtualizer.options, anchorTo: "end", getItemKey: (index) => keys[index] });
        virtualizer.scrollToOffsetNow(1000);

        // In the same task, before any scroll event: a row is added above, as older history starting to load shows a
        // spinner, and it measures smaller than the estimate it was laid out with.
        const withSpinner = ["spinner", ...keys];
        virtualizer.setOptions({ ...virtualizer.options, count: 51, getItemKey: (index) => withSpinner[index] });
        virtualizer.resizeItem(0, 32);

        // The rows on screen stay where they were: moved down by the row above, as it measures.
        expect(virtualizer.scroller.scrollTop).toBe(1000 + 32);
        virtualizer._willUpdate();
        expect(virtualizer.scroller.scrollTop).toBe(1000 + 32);
        virtualizer.scroller.remove();
    });

    it("lets a smooth scroll run on when rows are added above before it gets far", () => {
        const keys = Array.from({ length: 50 }, (_, i) => `row-${i}`);
        const virtualizer = makeVirtualizer(() => {}, 50);
        virtualizer.setOptions({ ...virtualizer.options, anchorTo: "end", getItemKey: (index) => keys[index] });
        virtualizer.scrollToOffset(1000, { behavior: "smooth" });

        // Before the animation's first frame, a row is added above.
        const withRow = ["new", ...keys];
        virtualizer.setOptions({ ...virtualizer.options, count: 51, getItemKey: (index) => withRow[index] });
        virtualizer._willUpdate();

        // The animation goes on from where the view is, rather than the view jumping to where it was heading.
        expect(virtualizer.scroller.scrollTop).toBeLessThan(1000);
        virtualizer.scroller.remove();
    });

    it("drops an iOS correction held for the end of a touch scroll when scrolling to an offset at once", () => {
        const virtualizer = makeVirtualizer(() => {}, 50);
        // On iOS, compensation for a row that grew during a touch scroll waits for the scroll to end. The offset
        // scrolled to already allows for that growth, so applying it later would move the view twice.
        const internals = virtualizer as unknown as { _iosDeferredAdjustment: number };
        internals._iosDeferredAdjustment = 100;
        virtualizer.scrollToOffsetNow(1000);
        expect(internals._iosDeferredAdjustment).toBe(0);
        expect(virtualizer.scroller.scrollTop).toBe(1000);
        virtualizer.scroller.remove();
    });

    it("tells its listener nothing when no size changed", () => {
        const onChange = vi.fn();
        const virtualizer = makeVirtualizer(onChange);
        virtualizer.resizeItems([[0, 50]]);
        onChange.mockClear();
        virtualizer.resizeItems([[0, 50]]);
        expect(onChange).not.toHaveBeenCalled();
    });
});

describe("virtual-core patch: pausing", () => {
    /** Wait for the browser to draw a frame, and so deliver what its observers saw. */
    const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

    /** A virtualizer over `count` rows of `height` pixels in the page, each measured as its element is given. */
    function makeRows(
        count: number,
        height: number,
        options: Partial<VirtualizerOptions<HTMLDivElement, HTMLDivElement>> = {},
    ): {
        virtualizer: Virtualizer<HTMLDivElement, HTMLDivElement>;
        scroller: HTMLDivElement;
        rows: HTMLDivElement[];
        onChange: ReturnType<typeof vi.fn>;
    } {
        const scroller = document.createElement("div");
        scroller.style.height = "200px";
        scroller.style.overflow = "auto";
        const rows = Array.from({ length: count }, (_, index) => {
            const row = document.createElement("div");
            row.dataset.index = String(index);
            row.style.height = `${height}px`;
            return row;
        });
        scroller.append(...rows);
        document.body.append(scroller);
        const onChange = vi.fn();
        const virtualizer = new Virtualizer<HTMLDivElement, HTMLDivElement>({
            count,
            estimateSize: () => 40,
            getScrollElement: () => scroller,
            getItemKey: (index) => `row-${index}`,
            scrollToFn: elementScroll,
            observeElementOffset,
            observeElementRect,
            onChange,
            ...options,
        });
        virtualizer._willUpdate();
        for (const row of rows) virtualizer.measureElement(row);
        return { virtualizer, scroller, rows, onChange };
    }

    it("keeps the sizes, the range, the offset and the rows' elements while paused", async () => {
        const { virtualizer, scroller, rows, onChange } = makeRows(10, 50);
        expect(virtualizer.getTotalSize()).toBe(500);
        scroller.scrollTop = 100;
        await vi.waitFor(() => expect(virtualizer.scrollOffset).toBe(100));
        const range = virtualizer.range;
        const elements = [...virtualizer.elementsCache.entries()];

        virtualizer.setPaused(true);
        onChange.mockClear();
        rows[0].style.height = "90px";
        scroller.style.height = "150px";
        scroller.scrollTop = 0;
        scroller.dispatchEvent(new Event("scroll"));
        await nextFrame();
        await nextFrame();

        expect(virtualizer.getTotalSize()).toBe(500);
        expect(virtualizer.scrollOffset).toBe(100);
        expect(virtualizer.range).toEqual(range);
        expect(virtualizer.scrollRect?.height).toBe(200);
        expect(onChange).not.toHaveBeenCalled();
        // A row's element going from the page, as React lets go of it, leaves it noted.
        rows[1].remove();
        virtualizer.measureElement(null);
        expect([...virtualizer.elementsCache.entries()]).toEqual(elements);
        scroller.remove();
    });

    it("scrolls nowhere while paused, and drops a scroll on its way as it pauses", async () => {
        const frames = new Map<number, FrameRequestCallback>();
        let nextId = 1;
        vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
            frames.set(nextId, callback);
            return nextId++;
        });
        vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => void frames.delete(id));
        const { virtualizer, scroller } = makeRows(20, 50);
        virtualizer.scrollToIndex(10, { align: "start" });
        const steering = frames.size;
        expect(steering).toBeGreaterThan(0);

        virtualizer.setPaused(true);
        expect(frames.size).toBe(steering - 1);
        const top = scroller.scrollTop;
        virtualizer.scrollToOffset(0);
        virtualizer.scrollToIndex(0);
        virtualizer.scrollBy(-100);
        virtualizer.scrollToEnd();
        virtualizer.scrollToOffsetNow(0);
        virtualizer.resizeItems([[0, 400]]);

        expect(scroller.scrollTop).toBe(top);
        expect(frames.size).toBe(steering - 1);
        expect(virtualizer.getTotalSize()).toBe(1000);
        vi.restoreAllMocks();
        scroller.remove();
    });

    it("stops a smooth scroll the browser is running as it pauses, and keeps where it stopped", async () => {
        const { virtualizer, scroller } = makeRows(50, 50);
        virtualizer.scrollToOffset(1000, { behavior: "smooth" });
        await nextFrame();

        virtualizer.setPaused(true);
        const stoppedAt = scroller.scrollTop;
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(scroller.scrollTop).toBe(stoppedAt);
        expect(stoppedAt).toBeLessThan(1000);
        expect(virtualizer.scrollOffset).toBe(stoppedAt);

        virtualizer.setPaused(false);
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(scroller.scrollTop).toBe(stoppedAt);
        scroller.remove();
    });

    it("keeps where a smooth scroll stopped in a horizontal right-to-left list", async () => {
        const scroller = document.createElement("div");
        scroller.dir = "rtl";
        Object.assign(scroller.style, { width: "200px", height: "50px", overflow: "auto" });
        const content = document.createElement("div");
        Object.assign(content.style, { width: "2500px", height: "10px" });
        scroller.append(content);
        document.body.append(scroller);
        const virtualizer = new Virtualizer<HTMLDivElement, HTMLDivElement>({
            count: 50,
            estimateSize: () => 50,
            horizontal: true,
            isRtl: true,
            getScrollElement: () => scroller,
            // Offsets count from the start of a right-to-left list, where the browser's go negative.
            scrollToFn: (offset, { behavior }, instance) =>
                instance.scrollElement?.scrollTo({ left: -offset, behavior }),
            observeElementOffset,
            observeElementRect,
            onChange: () => {},
        });
        virtualizer._willUpdate();
        virtualizer.scrollToOffset(1000, { behavior: "smooth" });
        await nextFrame();
        await nextFrame();
        await new Promise((resolve) => setTimeout(resolve, 50));

        virtualizer.setPaused(true);
        const stoppedAt = -scroller.scrollLeft;
        expect(stoppedAt).toBeGreaterThan(0);
        expect(stoppedAt).toBeLessThan(1000);
        expect(virtualizer.scrollOffset).toBe(stoppedAt);

        virtualizer.setPaused(false);
        expect(-scroller.scrollLeft).toBe(stoppedAt);
        scroller.remove();
    });

    it("keeps where a smooth scroll stopped in a window scrolled right to left", async () => {
        const root = document.documentElement;
        const dir = root.dir;
        root.dir = "rtl";
        const content = document.createElement("div");
        Object.assign(content.style, { width: "6000px", height: "10px" });
        document.body.append(content);
        const overflow = [root.style.overflow, document.body.style.overflow];
        root.style.overflow = "auto";
        document.body.style.overflow = "visible";
        // A window keeps the browser's own offsets, which go negative right to left.
        window.scrollTo({ left: -2000, behavior: "instant" });
        expect(window.scrollX).toBe(-2000);
        const virtualizer = new Virtualizer<Window, HTMLDivElement>({
            count: 100,
            estimateSize: () => 50,
            horizontal: true,
            isRtl: true,
            getScrollElement: () => window,
            // Where the window is, which attaching writes back.
            initialOffset: -2000,
            scrollToFn: windowScroll,
            observeElementOffset: observeWindowOffset,
            observeElementRect: observeWindowRect,
            onChange: () => {},
        });
        try {
            virtualizer._willUpdate();
            virtualizer.scrollToOffset(0, { behavior: "smooth" });
            await nextFrame();
            await nextFrame();
            await new Promise((resolve) => setTimeout(resolve, 50));

            virtualizer.setPaused(true);
            const stoppedAt = window.scrollX;
            expect(stoppedAt).toBeLessThan(0);
            expect(stoppedAt).toBeGreaterThan(-2000);
            expect(virtualizer.scrollOffset).toBe(stoppedAt);

            virtualizer.setPaused(false);
            expect(window.scrollX).toBe(stoppedAt);
        } finally {
            virtualizer._didMount()();
            content.remove();
            root.dir = dir;
            [root.style.overflow, document.body.style.overflow] = overflow;
            window.scrollTo({ left: 0, behavior: "instant" });
        }
    });

    it("attaches nothing again as its owner renders while paused, nor keeps rows in place that change meanwhile", async () => {
        const { virtualizer, scroller, onChange } = makeRows(10, 50, { anchorTo: "end" });
        scroller.scrollTop = 150;
        await vi.waitFor(() => expect(virtualizer.scrollOffset).toBe(150));
        virtualizer.setPaused(true);
        onChange.mockClear();
        const listens = vi.spyOn(scroller, "addEventListener");

        // Rows added above, which would move the offset to keep the rows shown in place.
        virtualizer.setOptions({ ...virtualizer.options, count: 12, getItemKey: (index) => `row-${index - 2}` });
        virtualizer._willUpdate();
        expect(virtualizer.scrollOffset).toBe(150);
        // Let go of as React does when it runs its effects again, in StrictMode, before rendering once more.
        virtualizer._didMount()();
        virtualizer._willUpdate();
        scroller.scrollTop = 0;
        scroller.dispatchEvent(new Event("scroll"));
        await nextFrame();

        expect(onChange).not.toHaveBeenCalled();
        expect(listens).not.toHaveBeenCalled();
        expect(virtualizer.scrollOffset).toBe(150);
        expect(scroller.scrollTop).toBe(0);
        scroller.remove();
    });

    it("ignores what its observers saw before it paused, even once it has resumed", async () => {
        // Each observer's deliveries are held, to be handed over by the test.
        const held: FrameRequestCallback[] = [];
        const { virtualizer, scroller, rows } = makeRows(10, 50, { useAnimationFrameWithResizeObserver: true });
        await vi.waitFor(() => expect(virtualizer.getTotalSize()).toBe(500));
        vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
            held.push(callback);
            return held.length;
        });
        rows[0].style.height = "80px";
        scroller.style.height = "150px";
        await vi.waitFor(() => expect(held.length).toBeGreaterThanOrEqual(2));
        const beforePause = held.splice(0);

        virtualizer.setPaused(true);
        // Nothing is observed while paused.
        rows[1].style.height = "60px";
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(held).toHaveLength(0);
        virtualizer.setPaused(false);
        const resizes = vi.spyOn(virtualizer, "resizeItem");
        // What the observers of this attachment see comes first: the viewport has changed size again.
        scroller.style.height = "250px";
        await vi.waitFor(() => expect(held.length).toBeGreaterThan(0));
        for (const deliver of held.splice(0)) deliver(performance.now());
        expect(virtualizer.scrollRect?.height).toBe(250);
        resizes.mockClear();
        for (const deliver of beforePause) deliver(performance.now());

        expect(resizes).not.toHaveBeenCalled();
        expect(virtualizer.scrollRect?.height).toBe(250);
        vi.restoreAllMocks();
        scroller.remove();
    });

    it("measures the rows afresh and writes its offset back as it resumes, letting go of rows gone meanwhile", async () => {
        const { virtualizer, scroller, rows, onChange } = makeRows(10, 50);
        scroller.scrollTop = 120;
        await vi.waitFor(() => expect(virtualizer.scrollOffset).toBe(120));
        virtualizer.setPaused(true);
        // Taken out of the page and put back, which loses the scroll position, while rows change and one goes.
        scroller.remove();
        rows[9].style.height = "70px";
        rows[8].remove();
        virtualizer.measureElement(null);
        document.body.append(scroller);
        expect(scroller.scrollTop).toBe(0);

        virtualizer.setPaused(false);
        expect(scroller.scrollTop).toBe(120);
        await vi.waitFor(() => expect(virtualizer.getTotalSize()).toBe(8 * 50 + 50 + 70));
        expect(virtualizer.elementsCache.has("row-8")).toBe(false);
        expect(onChange).toHaveBeenCalled();
        // An offset scrolled to just before a pause, not yet read back, is the one written back.
        virtualizer.scrollToOffsetNow(60);
        virtualizer.setPaused(true);
        scroller.scrollTop = 0;
        virtualizer.setPaused(false);
        expect(scroller.scrollTop).toBe(60);
        virtualizer.scrollToOffsetNow(120);
        // Pausing twice, or resuming twice, is as once.
        virtualizer.setPaused(false);
        virtualizer.setPaused(true);
        virtualizer.setPaused(true);
        virtualizer.setPaused(false);
        expect(scroller.scrollTop).toBe(120);
        scroller.remove();
    });
});
