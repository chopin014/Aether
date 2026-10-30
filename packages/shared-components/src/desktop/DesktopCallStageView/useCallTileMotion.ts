/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type RefObject, useEffect, useState } from "react";

/** Play call artwork while its tile is visible, respecting the viewing window and reduced motion. */
export function useCallTileMotion(surface: RefObject<HTMLElement | null>, enabled: boolean): boolean {
    const [running, setRunning] = useState(false);

    useEffect(() => {
        const element = surface.current;
        const ownerDocument = element?.ownerDocument;
        const ownerWindow = ownerDocument?.defaultView;
        if (!enabled || !element || !ownerDocument || !ownerWindow) {
            setRunning(false);
            return;
        }
        const reducedMotion = ownerWindow.matchMedia("(prefers-reduced-motion: reduce)");
        let inView = false;
        const update = (): void => {
            setRunning(inView && ownerDocument.visibilityState !== "hidden" && !reducedMotion.matches);
        };
        const observer = new ownerWindow.IntersectionObserver(([entry]) => {
            inView = entry.isIntersecting;
            update();
        });
        observer.observe(element);
        ownerDocument.addEventListener("visibilitychange", update);
        reducedMotion.addEventListener("change", update);
        return () => {
            observer.disconnect();
            ownerDocument.removeEventListener("visibilitychange", update);
            reducedMotion.removeEventListener("change", update);
        };
    }, [enabled, surface]);

    return running;
}
