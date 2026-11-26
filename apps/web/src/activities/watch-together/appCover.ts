/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/**
 * The app's pop-up UI that is looked for by name. These are found the moment they open, and some of them (tooltips)
 * take no clicks, so the sampling in {@link appPaintsOver} cannot see them.
 */
const FLOATING_UI = [
    "[role='menu']",
    "[role='listbox']",
    "[role='dialog']",
    "[role='alertdialog']",
    "[role='tooltip']",
    ".mx_ContextualMenu",
    ".mx_Dialog",
].join(", ");

/** Gap between sample points along the edges of the element, where anything reaching in from outside crosses. */
const EDGE_STEP = 32;
/** Gap between sample points inside the element, for UI that opens wholly inside it (toasts, dialogs). */
const INSIDE_STEP = 64;

function overlaps(a: DOMRect, b: DOMRect): boolean {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function visible(element: Element): boolean {
    // Without the browser's check (as in some test environments), anything laid out counts as visible.
    return typeof element.checkVisibility !== "function"
        ? true
        : element.checkVisibility({ opacityProperty: true, visibilityProperty: true });
}

/**
 * Whether a pop-up overlapping the element is drawn above it rather than behind it, looked at in a few places where
 * the two overlap. A pop-up that takes no clicks (a tooltip) cannot be found this way, and counts as above.
 */
function drawnAbove(element: HTMLElement, floating: Element, r: DOMRect, box: DOMRect): boolean {
    const doc = element.ownerDocument;
    if (typeof doc.elementsFromPoint !== "function") return true;
    const left = Math.max(r.left, box.left);
    const right = Math.min(r.right, box.right);
    const top = Math.max(r.top, box.top);
    const bottom = Math.min(r.bottom, box.bottom);
    const points: [number, number][] = [
        [(left + right) / 2, (top + bottom) / 2],
        [left + 1, top + 1],
        [right - 1, top + 1],
        [left + 1, bottom - 1],
        [right - 1, bottom - 1],
    ];
    let found = false;
    for (const [x, y] of points) {
        const stack = doc.elementsFromPoint(x, y);
        const at = stack.findIndex((hit) => floating.contains(hit));
        if (at < 0) continue;
        found = true;
        const under = stack.findIndex((hit) => element.contains(hit));
        if (under < 0 || at < under) return true;
    }
    return !found && getComputedStyle(floating).pointerEvents === "none";
}

/** Whether one of the app's known pop-ups (menus, dialogs, tooltips, …) is shown over the element. */
export function floatingUiOver(element: HTMLElement, box: DOMRect): boolean {
    for (const floating of element.ownerDocument.querySelectorAll(FLOATING_UI)) {
        // A dialog the element itself sits in is not on top of it.
        if (floating.contains(element) || element.contains(floating)) continue;
        const r = floating.getBoundingClientRect();
        if (r.width < 1 || r.height < 1 || !overlaps(r, box)) continue;
        // A closed pop-up kept in the page, or one behind the element, is not over it.
        if (visible(floating) && drawnAbove(element, floating, r, box)) return true;
    }
    return false;
}

/** Points along the edges and across the inside of the box, kept within the window. */
export function samplePoints(box: DOMRect, viewWidth: number, viewHeight: number): [number, number][] {
    const left = Math.max(box.left, 0) + 1;
    const top = Math.max(box.top, 0) + 1;
    const right = Math.min(box.right, viewWidth) - 1;
    const bottom = Math.min(box.bottom, viewHeight) - 1;
    if (right <= left || bottom <= top) return [];
    const steps = (from: number, to: number, step: number): number[] => {
        const count = Math.max(1, Math.ceil((to - from) / step));
        return Array.from({ length: count + 1 }, (_, i) => from + ((to - from) * i) / count);
    };
    const points: [number, number][] = [];
    for (const x of steps(left, right, EDGE_STEP)) points.push([x, top], [x, bottom]);
    for (const y of steps(top, bottom, EDGE_STEP).slice(1, -1)) points.push([left, y], [right, y]);
    const xs = steps(left, right, INSIDE_STEP).slice(1, -1);
    for (const y of steps(top, bottom, INSIDE_STEP).slice(1, -1)) for (const x of xs) points.push([x, y]);
    return points;
}

/** Whether a computed colour is fully see-through. */
export function transparent(color: string): boolean {
    // Only an alpha can be zero here: "rgba(0, 0, 0, 0)" (four parts) or "oklch(0.5 0.1 200 / 0)". An opaque colour
    // is computed without one, so the last part of "rgb(0, 0, 0)" is its blue, not its alpha.
    return (
        color === "transparent" ||
        /^rgba\([^,]*,[^,]*,[^,]*,\s*0(\.0*)?\s*\)$/.test(color) ||
        /\/\s*0(\.0*)?%?\s*\)$/.test(color)
    );
}

/**
 * Whether the element draws something people would see: a background, a picture or icon, or its own text. Empty
 * see-through layers, like the one that closes a menu when clicking outside it, do not count.
 */
function paints(element: Element): boolean {
    if (!element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    if (
        element instanceof SVGElement ||
        element instanceof HTMLImageElement ||
        element instanceof HTMLCanvasElement ||
        element instanceof HTMLVideoElement ||
        element instanceof HTMLIFrameElement
    )
        return true;
    const style = getComputedStyle(element);
    if (style.backgroundImage !== "none" || !transparent(style.backgroundColor)) return true;
    for (const node of element.childNodes) {
        if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) return true;
    }
    return false;
}

/** Whether, at one point, something of the app is drawn over the element. */
function paintedOverAt(element: HTMLElement, doc: Document, x: number, y: number): boolean {
    const top = doc.elementFromPoint(x, y);
    // Nothing there (outside the window) or the element itself: the common case, answered without more work.
    if (!top || element.contains(top)) return false;
    const stack = doc.elementsFromPoint(x, y);
    const index = stack.findIndex((hit) => element.contains(hit));
    // The element is not under this point (a rounded corner clips it), so what is there may be drawn below it.
    if (index < 0) return false;
    // The element's own containers are drawn under it.
    return stack.slice(0, index).some((above) => !above.contains(element) && paints(above));
}

/**
 * Whether any part of the app is drawn over the element, whatever it is and wherever it was opened from. This is
 * the catch-all for UI not listed in {@link floatingUiOver}: profile cards, toasts, the incoming call, a picture in
 * picture call, the drop target for files. It samples the element's area, so it costs more and is meant to run a
 * few times a second, not every frame.
 *
 * Being a sample, it finds what crosses the edges more than {@link EDGE_STEP} pixels apart, and what lies wholly
 * inside more than {@link INSIDE_STEP} apart; smaller marks can be missed. Layers that take no clicks are passed over
 * like the page itself, so the call stage's header, which spans the top of the stage at all times, does not count.
 */
export function appPaintsOver(element: HTMLElement, box: DOMRect): boolean {
    const doc = element.ownerDocument;
    const view = doc.defaultView;
    if (!view || typeof doc.elementsFromPoint !== "function") return false;
    for (const [x, y] of samplePoints(box, view.innerWidth, view.innerHeight)) {
        if (paintedOverAt(element, doc, x, y)) return true;
    }
    return false;
}
