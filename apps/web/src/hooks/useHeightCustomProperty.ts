/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { useCallback } from "react";

/**
 * Keeps a CSS custom property on `document.body` set to an element's height, for layouts elsewhere in the
 * page that must make room for it. The property is removed once the element unmounts.
 * @param property - The custom property to set, such as `--mx-desktop-dock-height`.
 * @returns A ref callback for the element to measure.
 */
export function useHeightCustomProperty(property: string): (element: HTMLElement | null) => (() => void) | void {
    return useCallback(
        (element: HTMLElement | null) => {
            if (!element) return;
            const observer = new ResizeObserver(() => {
                document.body.style.setProperty(property, `${element.offsetHeight}px`);
            });
            observer.observe(element);
            return () => {
                observer.disconnect();
                document.body.style.removeProperty(property);
            };
        },
        [property],
    );
}
