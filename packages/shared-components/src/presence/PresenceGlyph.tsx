/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, type SVGProps } from "react";

/** A state a person's presence can be drawn in. */
export type PresenceGlyphStatus = "online" | "unavailable" | "busy" | "offline";

/**
 * The shape of each presence state, the same everywhere a person's status appears. Every state has its own shape, so
 * it can be told apart without relying on colour: a solid dot, a crescent moon, a dot with a bar, and a ring.
 * Colour comes from `currentColor`, because each surface has its own palette.
 */
export function PresenceGlyph({
    status,
    ...props
}: SVGProps<SVGSVGElement> & { status?: PresenceGlyphStatus }): JSX.Element {
    return (
        <svg aria-hidden="true" {...props} data-presence={status} viewBox="0 0 16 16">
            {status === "online" ? (
                <circle cx="8" cy="8" r="7" fill="currentColor" />
            ) : status === "unavailable" ? (
                <path d="M15 8a7 7 0 1 1-7-7 5.5 5.5 0 0 0 7 7Z" fill="currentColor" />
            ) : status === "busy" ? (
                <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1ZM4 6.75h8v2.5H4Z" fill="currentColor" fillRule="evenodd" />
            ) : (
                <circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" strokeWidth="4" />
            )}
        </svg>
    );
}
