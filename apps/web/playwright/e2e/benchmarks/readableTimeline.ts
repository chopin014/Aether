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
    /** Whether `target` can be read on screen now; see {@link installReadableCheck}. */
    aetherBenchReadable?: (target: ReadableTarget) => boolean;
}

/**
 * Puts `aetherBenchReadable` on the page's window: whether a target message can be read on screen.
 *
 * Readable means all of these:
 * - The message is the target event, in the main timeline of the target room. That timeline is in the `<main>` element
 *   that RoomView marks with the room's id. A copy elsewhere does not count: in the right panel, a thread, search
 *   results, or another room.
 * - Nothing on the way up from it is hidden, inert or hidden from assistive technology, and it is not concealed by
 *   `display`, `visibility`, `opacity` or `content-visibility`.
 * - A whole line of the wanted text lies inside every box that clips it and inside the window. A tall message whose box
 *   reaches into view does not count unless its text does.
 * - At the middle of that line the page shows the message, not something covering it.
 *
 * It is handed to `page.addInitScript`, so it runs in the page and must use nothing from outside itself.
 */
export function installReadableCheck(): void {
    type Box = { left: number; top: number; right: number; bottom: number };
    const within = (inner: Box, outer: Box): boolean =>
        inner.left >= outer.left - 0.5 &&
        inner.right <= outer.right + 0.5 &&
        inner.top >= outer.top - 0.5 &&
        inner.bottom <= outer.bottom + 0.5;
    // The boxes that clip what is inside `element`: every ancestor whose overflow is not visible, and the viewport.
    const clips = (element: Element): Box[] => {
        const viewport = document.documentElement;
        const boxes: Box[] = [{ left: 0, top: 0, right: viewport.clientWidth, bottom: viewport.clientHeight }];
        for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
            const style = getComputedStyle(ancestor);
            if (style.overflowX !== "visible" || style.overflowY !== "visible") {
                boxes.push(ancestor.getBoundingClientRect());
            }
        }
        return boxes;
    };
    // The text node holding `text` under `root`, and where in it.
    const findText = (root: Element, text: string): { node: Text; offset: number } | null => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const offset = node.textContent?.indexOf(text) ?? -1;
            if (offset >= 0) return { node: node as Text, offset };
        }
        return null;
    };
    const readableIn = (row: HTMLElement, text: string): boolean => {
        if (row.closest("[hidden], [inert], [aria-hidden='true'], .mx_RoomView_searchResultsPanel")) return false;
        const found = findText(row, text);
        const holder = found?.node.parentElement;
        if (!found || !holder) return false;
        if (!holder.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) {
            return false;
        }
        const range = document.createRange();
        range.setStart(found.node, found.offset);
        range.setEnd(found.node, found.offset + text.length);
        const boxes = clips(holder);
        for (const line of range.getClientRects()) {
            if (line.width <= 0 || line.height <= 0) continue;
            if (!boxes.every((box) => within(line, box))) continue;
            const atMiddle = document.elementFromPoint(line.left + line.width / 2, line.top + line.height / 2);
            if (atMiddle && (atMiddle === holder || holder.contains(atMiddle) || atMiddle.contains(holder)))
                return true;
        }
        return false;
    };
    (window as unknown as ReadableWindow).aetherBenchReadable = (target: ReadableTarget): boolean => {
        for (const surface of document.querySelectorAll<HTMLElement>("main[data-room-id]")) {
            if (surface.dataset.roomId !== target.roomId) continue;
            for (const row of surface.querySelectorAll<HTMLElement>("[data-event-id]")) {
                if (row.dataset.eventId === target.eventId && readableIn(row, target.text)) return true;
            }
        }
        return false;
    };
}
