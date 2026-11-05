/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { useLayoutEffect, useState } from "react";

/** Size equal 16:9 tiles to fit the stage, including a centered incomplete last row. */
export function useCallGridLayout(count: number): (element: HTMLDivElement | null) => void {
    const [element, setElement] = useState<HTMLDivElement | null>(null);

    useLayoutEffect(() => {
        if (!element || count === 0) return;
        const update = (): void => {
            const { width, height } = element.getBoundingClientRect();
            const gap = parseFloat(element.ownerDocument.defaultView!.getComputedStyle(element).columnGap) || 0;
            let tileWidth = 0;
            // Try each column count and keep the arrangement with the largest tiles that fits both axes.
            for (let columns = 1; columns <= count; columns++) {
                const rows = Math.ceil(count / columns);
                const candidate = Math.min(
                    (width - gap * (columns - 1)) / columns,
                    ((height - gap * (rows - 1)) / rows) * (16 / 9),
                );
                tileWidth = Math.max(tileWidth, candidate);
            }
            // Round down so subpixel rounding cannot push a tile onto an extra row.
            element.style.setProperty("--call-grid-tile-width", `${Math.floor(tileWidth)}px`);
        };
        update();
        const observer = new ResizeObserver(update);
        observer.observe(element);
        return () => observer.disconnect();
    }, [element, count]);

    return setElement;
}
