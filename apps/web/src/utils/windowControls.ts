/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/**
 * The native window controls (minimise, maximise, close) that the desktop shell draws over the top right corner of
 * the page. Both sizes are 0 when there are none: on macOS, in a browser and with the shell flag off.
 */
export interface WindowControls {
    /** Width of the controls, measured from the right edge of the window. */
    inline: number;
    /** Height of the controls, measured from the top edge of the window. */
    block: number;
}

/** A box in viewport coordinates. */
export interface Box {
    top: number;
    left: number;
    width: number;
    height: number;
}

/**
 * Reads the size of the window controls from `--mx-window-controls-inline-size` and `--mx-window-controls-block-size`.
 * The variables hold `env()` expressions, so a probe element is measured instead of parsing their text.
 */
export function readWindowControls(): WindowControls {
    if (typeof document === "undefined" || !document.body) return { inline: 0, block: 0 };
    const probe = document.createElement("div");
    probe.style.cssText =
        "position:fixed;visibility:hidden;pointer-events:none;" +
        "width:var(--mx-window-controls-inline-size, 0px);height:var(--mx-window-controls-block-size, 0px)";
    document.body.appendChild(probe);
    const { offsetWidth: width, offsetHeight: height } = probe;
    probe.remove();
    return { inline: Number.isFinite(width) ? width : 0, block: Number.isFinite(height) ? height : 0 };
}

/**
 * Moves a box that would sit under the window controls: first to the left of them, and when it does not fit
 * there, below them. Boxes that do not reach the controls are returned unchanged.
 */
export function avoidWindowControls(
    box: Box,
    controls: WindowControls,
    viewportWidth: number,
    gap = 8,
): { top: number; left: number } {
    const { top, left } = box;
    if (controls.inline <= 0 || controls.block <= 0) return { top, left };
    const underControls = top < controls.block && left + box.width > viewportWidth - controls.inline;
    if (!underControls) return { top, left };
    const leftOfControls = viewportWidth - controls.inline - box.width - gap;
    if (leftOfControls >= gap) return { top, left: leftOfControls };
    return { top: controls.block + gap, left };
}
