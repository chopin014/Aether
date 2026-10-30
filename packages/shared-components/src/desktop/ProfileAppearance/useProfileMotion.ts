/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type CSSProperties, useEffect, useMemo, useState } from "react";

/** How long a card keeps animating after it opens, before only hover or focus keeps it moving. */
const INTRO_MS = 7000;

/** What a surface applies so its artwork moves while it is active. */
export interface ProfileMotion {
    /** Animated media should be playing. */
    live: boolean;
    /** Spread onto the surface element. */
    bind: {
        style: CSSProperties;
        onPointerEnter: () => void;
        onPointerLeave: () => void;
        onFocus: () => void;
        onBlur: () => void;
    };
}

function prefersReducedMotion(): boolean {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
}

/**
 * Animate a surface while it has just opened or the pointer or keyboard is on it, so a screen full of profiles stays
 * still. People who ask their system for reduced motion get still images and artwork throughout.
 *
 * @param intro Whether to play once on opening rather than waiting for the pointer.
 */
export function useProfileMotion(intro = true): ProfileMotion {
    const [reduced] = useState(prefersReducedMotion);
    const [opening, setOpening] = useState(intro);
    const [hovered, setHovered] = useState(false);
    const [focused, setFocused] = useState(false);

    useEffect(() => {
        if (!opening) return;
        const timer = window.setTimeout(() => setOpening(false), INTRO_MS);
        return () => window.clearTimeout(timer);
    }, [opening]);

    const live = !reduced && (opening || hovered || focused);
    return useMemo(
        () => ({
            live,
            bind: {
                style: { "--profile-motion": live ? "running" : "paused" } as CSSProperties,
                onPointerEnter: () => setHovered(true),
                onPointerLeave: () => setHovered(false),
                onFocus: () => setFocused(true),
                onBlur: () => setFocused(false),
            },
        }),
        [live],
    );
}
