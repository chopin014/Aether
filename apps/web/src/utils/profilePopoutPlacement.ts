/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { avoidWindowControls, type WindowControls } from "./windowControls";

/** A rectangle in viewport coordinates. */
export interface PlacementRect {
    top: number;
    left: number;
    width: number;
    height: number;
}

/** Where to draw the popout. */
export interface PopoutPosition {
    top: number;
    left: number;
    /** The side of the anchor that was used. */
    side: "right" | "left" | "below" | "above";
}

/**
 * Place a card beside the clicked element, as Discord does: to its right when there is room, otherwise to its
 * left, aligned with the top of the anchor and shifted so the whole card stays inside the viewport. If neither
 * side fits (a very narrow window) it goes below or above the anchor instead.
 */
export function placeProfilePopout(
    anchor: PlacementRect,
    card: { width: number; height: number },
    viewport: { width: number; height: number },
    gap = 8,
    controls: WindowControls = { inline: 0, block: 0 },
): PopoutPosition {
    const placed = placeBesideAnchor(anchor, card, viewport, gap);
    // A card opened from the top of a list can reach the corner under the window controls.
    const moved = avoidWindowControls({ ...placed, ...card }, controls, viewport.width, gap);
    return { ...placed, ...moved };
}

function placeBesideAnchor(
    anchor: PlacementRect,
    card: { width: number; height: number },
    viewport: { width: number; height: number },
    gap: number,
): PopoutPosition {
    const clamp = (value: number, size: number, limit: number): number =>
        Math.max(gap, Math.min(value, limit - size - gap));
    const right = anchor.left + anchor.width + gap;
    const left = anchor.left - gap - card.width;
    if (right + card.width <= viewport.width - gap) {
        return { top: clamp(anchor.top, card.height, viewport.height), left: right, side: "right" };
    }
    if (left >= gap) {
        return { top: clamp(anchor.top, card.height, viewport.height), left, side: "left" };
    }
    const below = anchor.top + anchor.height + gap;
    const fitsBelow = below + card.height <= viewport.height - gap;
    return {
        top: fitsBelow ? below : Math.max(gap, anchor.top - gap - card.height),
        left: clamp(anchor.left, card.width, viewport.width),
        side: fitsBelow ? "below" : "above",
    };
}
