/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/** The message a navigation is to show: an event in a room's main timeline, with some of its text. */
export interface ReadableTarget {
    /** The room whose main timeline shows it. */
    roomId: string;
    /** The event's id, as its row carries it. */
    eventId: string;
    /** Text of the message that has to be in view. */
    text: string;
}

/** What {@link installReadableCheck} puts on the page's window. */
export interface ReadableWindow {
    /**
     * Whether `target` can be read on screen now; see {@link installReadableCheck}.
     * @param thorough - Also look for covers that let the pointer through, which costs a style recalculation.
     */
    aetherBenchReadable?: (target: ReadableTarget, thorough?: boolean) => boolean;
}

/**
 * Puts `aetherBenchReadable` on the page's window: whether a target message can be read on screen.
 *
 * Readable means all of these hold for one place the wanted text occurs, which may run across several nested elements:
 * - It is in the target event's row, in the main timeline of the target room. That timeline is in the `<main>`
 *   element that RoomView marks with the room's id. A copy elsewhere does not count: in the right panel, a thread,
 *   search results, or another room.
 * - Nothing from the text up is hidden, inert or hidden from assistive technology, and the text is not concealed by
 *   `display`, `visibility`, `opacity` or `content-visibility`.
 * - A whole line of it lies inside the viewport and inside what every element from the text up lets show along each
 *   axis it clips: its padding box, less any scrollbar.
 * - At the middle of that line nothing is drawn over the text: no element above it there, inside it or elsewhere,
 *   paints media or a background. Transparent layers do not count. Asked to be thorough, this also catches covers the
 *   pointer passes through. Text drawn over it by a transparent element is not caught.
 *
 * It is handed to `page.addInitScript`, so it runs in the page and must use nothing from outside itself.
 */
export function installReadableCheck(): void {
    type Box = { left: number; top: number; right: number; bottom: number };
    const HIDDEN = "[hidden], [inert], [aria-hidden='true'], .mx_RoomView_searchResultsPanel";
    // Allow for line boxes that end a fraction of a pixel past their container.
    const within = (inner: Box, outer: Box): boolean =>
        inner.left >= outer.left - 0.5 &&
        inner.right <= outer.right + 0.5 &&
        inner.top >= outer.top - 0.5 &&
        inner.bottom <= outer.bottom + 0.5;
    // What `element` lets its content show in, along each axis it clips: its padding box, less any scrollbar. Null when
    // it clips along neither.
    const clipOf = (element: Element): Box | null => {
        const style = getComputedStyle(element);
        const clipsX = style.overflowX !== "visible";
        const clipsY = style.overflowY !== "visible";
        if (!clipsX && !clipsY) return null;
        const rect = element.getBoundingClientRect();
        const left = rect.left + element.clientLeft;
        const top = rect.top + element.clientTop;
        return {
            left: clipsX ? left : -Infinity,
            right: clipsX ? left + element.clientWidth : Infinity,
            top: clipsY ? top : -Infinity,
            bottom: clipsY ? top + element.clientHeight : Infinity,
        };
    };
    // The boxes that clip `element`'s content: its own and every ancestor's, and the viewport. The root and body pass
    // their overflow to the viewport, so the viewport stands for them.
    const clips = (element: Element): Box[] => {
        const viewport = document.documentElement;
        const boxes: Box[] = [{ left: 0, top: 0, right: viewport.clientWidth, bottom: viewport.clientHeight }];
        for (let at: Element | null = element; at && at !== document.body && at !== viewport; at = at.parentElement) {
            const box = clipOf(at);
            if (box) boxes.push(box);
        }
        return boxes;
    };
    // Each place `text` occurs under `root`, as a range that may run across several text nodes, with the elements
    // holding those text nodes.
    const occurrences = (root: Element, text: string): { range: Range; holders: Element[] }[] => {
        const nodes: Text[] = [];
        const starts: number[] = [];
        let all = "";
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            starts.push(all.length);
            nodes.push(node as Text);
            all += (node as Text).data;
        }
        // The text node a position in `all` falls in, the last one starting at or before it.
        const nodeAt = (position: number): number => {
            let index = 0;
            while (index + 1 < nodes.length && starts[index + 1] <= position) index++;
            return index;
        };
        const found: { range: Range; holders: Element[] }[] = [];
        if (!text) return found;
        for (let at = all.indexOf(text); at >= 0; at = all.indexOf(text, at + 1)) {
            const first = nodeAt(at);
            const last = nodeAt(at + text.length - 1);
            const range = document.createRange();
            range.setStart(nodes[first], at - starts[first]);
            range.setEnd(nodes[last], at + text.length - starts[last]);
            const holders: Element[] = [];
            for (let index = first; index <= last; index++) {
                const holder = nodes[index].parentElement;
                if (holder && !holders.includes(holder)) holders.push(holder);
            }
            found.push({ range, holders });
        }
        return found;
    };
    // Whether `element` draws anything of its own over what is under it: media, or a background. A transparent layer,
    // such as the one the timeline's floating buttons sit in, draws nothing where they are not. A canvas is taken to be
    // transparent: what it holds cannot be read without disturbing it, and the room's chat effects canvas, over the
    // whole room, is transparent between effects.
    const paints = (element: Element): boolean => {
        if (element instanceof HTMLImageElement || element instanceof HTMLMediaElement) return true;
        if (element instanceof HTMLIFrameElement || element instanceof SVGElement) return true;
        const style = getComputedStyle(element);
        if (style.backgroundImage !== "none" || style.backdropFilter !== "none") return true;
        const alpha = /rgba?\([^,]+,[^,]+,[^,]+(?:,\s*([\d.]+))?\)/.exec(style.backgroundColor)?.[1];
        return style.backgroundColor !== "transparent" && (alpha === undefined || Number(alpha) > 0);
    };
    // Whether something is drawn over the text at a point: going down the elements there from the top, one that draws
    // before the text's own element, or one around it, is reached. When asked to be thorough, elements the pointer
    // passes through count as well, which costs a style recalculation.
    const coveredAt = (x: number, y: number, holders: Element[], common: Element, thorough: boolean): boolean => {
        const style = thorough ? document.createElement("style") : undefined;
        if (style) {
            style.textContent = "*, *::before, *::after { pointer-events: auto !important; }";
            document.head.append(style);
        }
        try {
            for (const element of document.elementsFromPoint(x, y)) {
                if (holders.includes(element) || element.contains(common)) return false;
                if (paints(element)) return true;
            }
            // The text is not there at all.
            return true;
        } finally {
            style?.remove();
        }
    };
    const readable = (range: Range, holders: Element[], thorough: boolean): boolean => {
        for (const holder of holders) {
            if (holder.closest(HIDDEN)) return false;
            if (
                !holder.checkVisibility({
                    opacityProperty: true,
                    visibilityProperty: true,
                    contentVisibilityAuto: true,
                })
            ) {
                return false;
            }
        }
        const common =
            range.commonAncestorContainer instanceof Element
                ? range.commonAncestorContainer
                : range.commonAncestorContainer.parentElement;
        if (!common) return false;
        const boxes = clips(common);
        for (const line of range.getClientRects()) {
            if (line.width <= 0 || line.height <= 0) continue;
            if (!boxes.every((box) => within(line, box))) continue;
            if (!coveredAt(line.left + line.width / 2, line.top + line.height / 2, holders, common, thorough)) {
                return true;
            }
        }
        return false;
    };
    (window as unknown as ReadableWindow).aetherBenchReadable = (target: ReadableTarget, thorough = false): boolean => {
        for (const surface of document.querySelectorAll<HTMLElement>("main[data-room-id]")) {
            if (surface.dataset.roomId !== target.roomId) continue;
            for (const row of surface.querySelectorAll<HTMLElement>("[data-event-id]")) {
                if (row.dataset.eventId !== target.eventId) continue;
                for (const { range, holders } of occurrences(row, target.text)) {
                    if (readable(range, holders, thorough)) return true;
                }
            }
        }
        return false;
    };
}
