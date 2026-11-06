/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, type SVGProps } from "react";

/** A solid party popper drawn like Compound's solid icons, so it sits evenly beside the call controls. */
export function SoundboardIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
    return (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" {...props}>
            {/* The stroke rounds the cone's corners to match Compound's soft joins. */}
            <path
                d="M4.4 9.4 14.6 19.6 11.3 20.1 3.9 12.7ZM3.5 15.1 8.9 20.5 2.4 21.6Z"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinejoin="round"
            />
            <path
                d="M19.2 2.4c.3 1.4.9 2.1 2.4 2.4-1.5.3-2.1 1-2.4 2.4-.3-1.4-.9-2.1-2.4-2.4 1.5-.3 2.1-1 2.4-2.4Z"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinejoin="round"
            />
            <path
                d="M10.2 7.8c-.8-1.4.1-2.3 1-2.8.9-.5 1.3-1.5.7-2.5M16.2 13.8c1.4.8 2.3-.1 2.8-1 .5-.9 1.5-1.3 2.5-.7M13.3 10.7l2.5-2.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
            />
        </svg>
    );
}
