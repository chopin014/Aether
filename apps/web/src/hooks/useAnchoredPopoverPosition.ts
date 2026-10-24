/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type RefObject, useLayoutEffect, useRef } from "react";

import UIStore, { UI_EVENTS } from "../stores/UIStore";

/** Space kept between a popover, its trigger and the viewport edges. */
const GAP = 8;
const MAX_WIDTH = 480;

/** Viewport coordinates of a popover anchored to its trigger. */
export interface AnchoredPopoverPosition {
    top: number;
    left: number;
    width: number;
    /** Height from `top` to the bottom of the viewport. */
    availableHeight: number;
}

/**
 * Right-aligns a popover to its trigger and places it below, clamped inside the viewport.
 * @param anchor - the trigger's bounding rect
 */
export function computeAnchoredPopoverPosition(
    anchor: Pick<DOMRect, "right" | "bottom">,
    viewport: { width: number; height: number },
): AnchoredPopoverPosition {
    const width = Math.min(MAX_WIDTH, viewport.width - GAP * 2);
    const top = Math.min(anchor.bottom + GAP, viewport.height - GAP);
    const left = Math.max(GAP, Math.min(anchor.right - width, viewport.width - width - GAP));
    return { top, left, width, availableHeight: Math.max(0, viewport.height - top) };
}

/**
 * Keeps a popover anchored below its trigger while `active`, recomputing on window resize, scrolling and
 * trigger resize (for example when the right panel opens). `apply` receives each new position.
 */
export function useAnchoredPopoverPosition(
    active: boolean,
    trigger: RefObject<HTMLElement | null>,
    apply: (position: AnchoredPopoverPosition) => void,
): void {
    // Callers pass inline functions; reading the latest one avoids resubscribing on every render.
    const applyRef = useRef(apply);
    applyRef.current = apply;
    useLayoutEffect(() => {
        if (!active) return;
        const place = (): void => {
            const anchor = trigger.current?.getBoundingClientRect();
            if (!anchor) return;
            const { windowWidth, windowHeight } = UIStore.instance;
            applyRef.current(computeAnchoredPopoverPosition(anchor, { width: windowWidth, height: windowHeight }));
        };
        place();
        UIStore.instance.on(UI_EVENTS.Resize, place);
        window.addEventListener("scroll", place, true);
        const observer = new ResizeObserver(place);
        if (trigger.current) observer.observe(trigger.current);
        return () => {
            UIStore.instance.off(UI_EVENTS.Resize, place);
            window.removeEventListener("scroll", place, true);
            observer.disconnect();
        };
    }, [active, trigger]);
}
