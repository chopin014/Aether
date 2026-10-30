/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, type SVGProps } from "react";

/**
 * The symbol of a text channel: a slanted hash, drawn rather than typed so it reads as a symbol beside the channel's
 * name instead of a character of it. Sized and coloured like Compound icons, through `width`, `height` and `color`.
 */
export function TextChannelIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
    return (
        <svg
            width="1em"
            height="1em"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.1}
            strokeLinecap="round"
            {...props}
        >
            <path d="M10.2 3.5 7.6 20.5M16.6 3.5 14 20.5M4.8 8.6h15.4M3.8 15.4h15.4" />
        </svg>
    );
}
