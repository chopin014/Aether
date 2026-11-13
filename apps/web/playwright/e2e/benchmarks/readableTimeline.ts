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
     * @param thorough - Also look for covers that let the pointer through, which costs restyling the page twice.
     */
    aetherBenchReadable?: (target: ReadableTarget, thorough?: boolean) => boolean;
    /**
     * Watch for `target` to be painted readable, and call `onReadable` once with when it was: the start of the frame
     * after the first one painted with it readable, if it is still readable, checked thoroughly, after that frame too.
     * Every check runs in a task of its own once a frame has been painted, so it never lengthens the app's frames and
     * sees what was painted. Returns a function that stops watching.
     */
    aetherBenchWatchReadable?: (target: ReadableTarget, onReadable: (at: number) => void) => () => void;
}

/**
 * Puts `aetherBenchReadable` and `aetherBenchWatchReadable` on the page's window: whether a target message can be read
 * on screen, and when it first was.
 *
 * Readable means all of these hold for one place the wanted text occurs, which may run across several nested elements.
 * Spaces between its words are not themselves checked.
 * - It is in the target event's row, in the main timeline of the target room. That timeline is in the `<main>`
 *   element that RoomView marks with the room's id. A copy elsewhere does not count: in the right panel, a thread,
 *   search results, or another room.
 * - Nothing from each piece of the text up is hidden, inert or hidden from assistive technology, and no piece is
 *   concealed by `display`, `visibility`, `opacity`, an `opacity()` filter or `content-visibility`.
 * - Every line of every piece is drawn, and lies inside the viewport and inside what each element from that piece up
 *   lets show along each axis it clips, by overflow or paint containment: its padding box, less any scrollbar.
 * - At the middle of each of those lines nothing visible is drawn over the text: no element above it there, inside it
 *   or elsewhere, paints media or a background, or has a `::before` or `::after` box that does. Of the text's own
 *   element and those around it, only such boxes they position absolutely, and not behind their content, count, and
 *   only when the text is not what the pointer would land on there. Asked to be thorough, this also catches covers the
 *   pointer passes through.
 *
 * Not caught: text drawn over it by an element without a background, what a canvas holds, and clipping by `clip-path`.
 *
 * It is handed to `page.addInitScript`, so it runs in the page and must use nothing from outside itself.
 */
export function installReadableCheck(): void {
    type Box = { left: number; top: number; right: number; bottom: number };
    /** A piece of an occurrence of the wanted text: the part of it in one text node. */
    type Piece = { range: Range; holder: Element; text: string };
    const HIDDEN = "[hidden], [inert], [aria-hidden='true'], .mx_RoomView_searchResultsPanel";
    // Allow for line boxes that end a fraction of a pixel past their container.
    const within = (inner: Box, outer: Box): boolean =>
        inner.left >= outer.left - 0.5 &&
        inner.right <= outer.right + 0.5 &&
        inner.top >= outer.top - 0.5 &&
        inner.bottom <= outer.bottom + 0.5;
    // Display types whose boxes neither overflow nor paint containment clip.
    const UNCLIPPED = /^(?:inline|contents|table-(?:row|row-group|header-group|footer-group|column|column-group))$/;
    // What `element` lets its content show in, along each axis it clips by overflow or paint containment: its padding
    // box, less any scrollbar. Null when it clips along neither.
    const clipOf = (element: Element): Box | null => {
        const style = getComputedStyle(element);
        if (UNCLIPPED.test(style.display)) return null;
        const contained = /\b(?:paint|strict|content)\b/.test(style.contain);
        const clipsX = contained || style.overflowX !== "visible";
        const clipsY = contained || style.overflowY !== "visible";
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
    // Each place `text` occurs under `root`, as its pieces in the text nodes it runs across.
    const occurrences = (root: Element, text: string): Piece[][] => {
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
        const found: Piece[][] = [];
        if (!text) return found;
        for (let at = all.indexOf(text); at >= 0; at = all.indexOf(text, at + 1)) {
            const first = nodeAt(at);
            const last = nodeAt(at + text.length - 1);
            const pieces: Piece[] = [];
            for (let index = first; index <= last; index++) {
                const node = nodes[index];
                const start = index === first ? at - starts[index] : 0;
                const end = index === last ? at + text.length - starts[index] : node.data.length;
                const range = document.createRange();
                range.setStart(node, start);
                range.setEnd(node, end);
                // Every text node under an element has a parent element.
                pieces.push({ range, holder: node.parentElement!, text: node.data.slice(start, end) });
            }
            found.push(pieces);
        }
        return found;
    };
    // How opaque a computed colour is, from 0 to 1, in the legacy and the modern syntax alike. A colour it cannot read
    // counts as opaque.
    const alphaOf = (color: string): number => {
        if (color === "transparent") return 0;
        const value =
            /\/\s*([^\s)]+)\s*\)$/.exec(color)?.[1] ?? /^rgba\((?:[^,]+,){3}\s*([^\s)]+)\s*\)$/.exec(color)?.[1];
        if (value === undefined) return 1;
        if (value === "none") return 0;
        const alpha = value.endsWith("%") ? Number.parseFloat(value) / 100 : Number.parseFloat(value);
        return Number.isNaN(alpha) ? 1 : alpha;
    };
    // Whether a computed filter leaves what it applies to fully transparent.
    const fadesOut = (filter: string): boolean => /opacity\(\s*(?:0+(?:\.0*)?|\.0+)%?\s*\)/.test(filter);
    // Whether `element` or an element around it has an `opacity()` filter that leaves it fully transparent.
    const fadedOut = (element: Element): boolean => {
        for (let at: Element | null = element; at; at = at.parentElement) {
            if (fadesOut(getComputedStyle(at).filter)) return true;
        }
        return false;
    };
    // Whether a box with these computed styles draws a background.
    const drawsBackground = (style: CSSStyleDeclaration): boolean =>
        style.backgroundImage !== "none" || style.backdropFilter !== "none" || alphaOf(style.backgroundColor) > 0;
    // The `::before` and `::after` boxes `element` has that draw a background and are not concealed themselves.
    const drawingPseudos = (element: Element): CSSStyleDeclaration[] =>
        ["::before", "::after"]
            .map((pseudo) => getComputedStyle(element, pseudo))
            .filter(
                (style) =>
                    style.content !== "none" &&
                    style.content !== "normal" &&
                    style.display !== "none" &&
                    style.visibility === "visible" &&
                    Number(style.opacity) > 0 &&
                    !fadesOut(style.filter) &&
                    drawsBackground(style),
            );
    // Whether `element`, found above the text at a point, draws anything visible over it there: media, a background,
    // or a `::before` or `::after` box that draws one. A transparent layer, such as the one the timeline's floating
    // buttons sit in, draws nothing where they are not. A canvas is taken to be transparent: what it holds cannot be
    // read without disturbing it, and the room's chat effects canvas, over the whole room, is transparent between
    // effects.
    const drawsOver = (element: Element): boolean => {
        const style = getComputedStyle(element);
        const media =
            element instanceof HTMLImageElement ||
            element instanceof HTMLMediaElement ||
            element instanceof HTMLIFrameElement ||
            element instanceof SVGElement;
        const ownBox = style.visibility === "visible" && (media || drawsBackground(style));
        if (!ownBox && drawingPseudos(element).length === 0) return false;
        // Whatever it draws is concealed when it, or an element around it, is.
        return element.checkVisibility({ opacityProperty: true }) && !fadedOut(element);
    };
    // Whether the text's own element, or one around it, draws a box over its content: one of its `::before` and
    // `::after` boxes, positioned absolutely and not behind its content.
    const drawsOverContent = (element: Element): boolean =>
        drawingPseudos(element).some(
            (style) =>
                (style.position === "absolute" || style.position === "fixed") && !(Number.parseInt(style.zIndex) < 0),
        );
    // Whether the pointer would land on `node`'s own text at a point: inside it, rather than at either end, where it
    // lands when a box the text's element draws is on top there.
    const textOnTop = (x: number, y: number, node: Text): boolean => {
        const caret = document.caretPositionFromPoint(x, y);
        return caret?.offsetNode === node && caret.offset > 0 && caret.offset < node.length;
    };
    // Whether something is drawn over the text in `node` at a point: going down the elements there from the top, one is
    // reached that draws over the text before the text's own element, or one around it, is.
    const coveredAt = (x: number, y: number, node: Text, holder: Element): boolean => {
        for (const element of document.elementsFromPoint(x, y)) {
            if (element === holder || element.contains(holder)) {
                return drawsOverContent(element) && !textOnTop(x, y, node);
            }
            if (drawsOver(element)) return true;
        }
        // The text is not there at all.
        return true;
    };
    // Whether the text in `holder` is shown at all.
    const shown = (holder: Element): boolean =>
        !holder.closest(HIDDEN) &&
        holder.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true }) &&
        !fadedOut(holder);
    const readable = (pieces: Piece[]): boolean => {
        let drawn = false;
        for (const { range, holder, text } of pieces) {
            if (!text.trim()) continue;
            if (!shown(holder)) return false;
            const boxes = clips(holder);
            let lines = 0;
            for (const line of range.getClientRects()) {
                if (line.width <= 0 || line.height <= 0) continue;
                if (!boxes.every((box) => within(line, box))) return false;
                const x = line.left + line.width / 2;
                const y = line.top + line.height / 2;
                if (coveredAt(x, y, range.startContainer as Text, holder)) return false;
                lines++;
            }
            // A piece with no line drawn, such as one sized to nothing, cannot be read.
            if (lines === 0) return false;
            drawn = true;
        }
        return drawn;
    };
    const readableNow = (target: ReadableTarget, thorough = false): boolean => {
        // Being thorough lets the pointer hit everything while the check runs.
        const style = thorough ? document.createElement("style") : undefined;
        if (style) {
            style.textContent = "*, *::before, *::after { pointer-events: auto !important; }";
            (document.head ?? document.documentElement).append(style);
        }
        try {
            for (const surface of document.querySelectorAll<HTMLElement>("main[data-room-id]")) {
                if (surface.dataset.roomId !== target.roomId) continue;
                for (const row of surface.querySelectorAll<HTMLElement>("[data-event-id]")) {
                    if (row.dataset.eventId !== target.eventId) continue;
                    for (const pieces of occurrences(row, target.text)) {
                        if (readable(pieces)) return true;
                    }
                }
            }
            return false;
        } finally {
            if (style) {
                style.remove();
                // Restyle the page now, within the check, rather than leave that to the app's next frame.
                document.documentElement.getBoundingClientRect();
            }
        }
    };
    const watchReadable = (target: ReadableTarget, onReadable: (at: number) => void): (() => void) => {
        let active = true;
        let frame = 0;
        // When the frame last painted started, and whether the target was readable after the one before it.
        let frameAt = 0;
        let seen = false;
        const afterPaint = new MessageChannel();
        const stop = (): void => {
            active = false;
            cancelAnimationFrame(frame);
            afterPaint.port1.close();
        };
        // A message posted from a frame's callback is handled in a task of its own once that frame has been painted.
        afterPaint.port1.onmessage = (): void => {
            if (!active) return;
            if (seen && readableNow(target, true)) {
                stop();
                onReadable(frameAt);
                return;
            }
            // When the thorough check fails, start again from the next frame.
            seen = !seen && readableNow(target);
            frame = requestAnimationFrame(onFrame);
        };
        const onFrame = (): void => {
            frameAt = performance.now();
            afterPaint.port2.postMessage(null);
        };
        frame = requestAnimationFrame(onFrame);
        return stop;
    };
    const win = window as unknown as ReadableWindow;
    win.aetherBenchReadable = readableNow;
    win.aetherBenchWatchReadable = watchReadable;
}
