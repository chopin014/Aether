/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { createContext, type CSSProperties, useContext, useEffect, useMemo, useState } from "react";

/** How long a card keeps animating after it opens, before only hover or focus keeps it moving. */
const INTRO_MS = 7000;

/** What a surface applies so its artwork moves while it is active. */
export interface ProfileMotion {
    /** Animated media should be playing. */
    live: boolean;
    /** The pointer is over the surface, whether or not anything moves. */
    hovered: boolean;
    /**
     * Motion is allowed at all: the person has not asked for reduced motion and the window has focus. Card effects
     * loop for as long as this holds, as Discord's do, rather than only while the pointer is on the card.
     */
    allowed: boolean;
    /** Spread onto the surface element. */
    bind: {
        style: CSSProperties;
        onPointerEnter: () => void;
        onPointerLeave: () => void;
        onFocus: () => void;
        onBlur: () => void;
    };
}

/** Whether the surface around a piece of artwork is active, for artwork that is not told directly. */
export const ProfileLiveContext = createContext(false);

/** Whether the profile surface around this component is active. */
export function useProfileLive(): boolean {
    return useContext(ProfileLiveContext);
}

function prefersReducedMotion(): boolean {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
}

/**
 * Whether the app's window has focus. Artwork stops while the person is in another window, as Discord's does, so a
 * profile left open in the background costs nothing. A window counts as focused until it reports otherwise.
 */
export function useWindowFocused(): boolean {
    const [focused, setFocused] = useState(true);
    useEffect(() => {
        const onFocus = (): void => setFocused(true);
        const onBlur = (): void => setFocused(false);
        window.addEventListener("focus", onFocus);
        window.addEventListener("blur", onBlur);
        return () => {
            window.removeEventListener("focus", onFocus);
            window.removeEventListener("blur", onBlur);
        };
    }, []);
    return focused;
}

/**
 * Animate a surface while it has just opened or the pointer or keyboard is on it, so a screen full of profiles stays
 * still. People who ask their system for reduced motion get still images and artwork throughout, and nothing moves
 * while the window is in the background.
 *
 * @param intro Whether to play once on opening rather than waiting for the pointer.
 */
export function useProfileMotion(intro = true): ProfileMotion {
    const [reduced] = useState(prefersReducedMotion);
    const windowFocused = useWindowFocused();
    const [opening, setOpening] = useState(intro);
    const [hovered, setHovered] = useState(false);
    const [focused, setFocused] = useState(false);

    useEffect(() => {
        if (!opening) return;
        const timer = window.setTimeout(() => setOpening(false), INTRO_MS);
        return () => window.clearTimeout(timer);
    }, [opening]);

    const allowed = !reduced && windowFocused;
    const live = allowed && (opening || hovered || focused);
    return useMemo(
        () => ({
            live,
            hovered,
            allowed,
            bind: {
                style: { "--profile-motion": live ? "running" : "paused" } as CSSProperties,
                onPointerEnter: () => setHovered(true),
                onPointerLeave: () => setHovered(false),
                onFocus: () => setFocused(true),
                onBlur: () => setFocused(false),
            },
        }),
        [live, hovered, allowed],
    );
}
