/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// Tests for Aether's patch to @tanstack/virtual-core.

import { describe, expect, it, vi } from "vitest";
import { Virtualizer, elementScroll, observeElementOffset, observeElementRect } from "@tanstack/react-virtual";

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

    it("tells its listener nothing when no size changed", () => {
        const onChange = vi.fn();
        const virtualizer = makeVirtualizer(onChange);
        virtualizer.resizeItems([[0, 50]]);
        onChange.mockClear();
        virtualizer.resizeItems([[0, 50]]);
        expect(onChange).not.toHaveBeenCalled();
    });
});
