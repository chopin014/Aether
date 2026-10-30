/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, type SVGProps } from "react";

/** A monochrome party popper, matching the weight of the call toolbar icons. */
export function SoundboardIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
    return (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" {...props}>
            <g stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="m4 12-2 9 9-2c1.1-.3.4-2.5-1.6-4.5S4.3 10.9 4 12Z" />
                <path d="M4.3 12.1c-.3 1 1 3 2.3 4.3s3.4 2.7 4.4 2.4M12 12l2-2m-5-1c-1-3 3-3 2-6m4 11c3 1 3-3 6-2m-6-5 1-3m2 5 3-1" />
            </g>
            <g fill="currentColor">
                <circle cx="6" cy="5" r="1" />
                <circle cx="19" cy="17" r="1" />
                <circle cx="19" cy="3" r="1" />
            </g>
        </svg>
    );
}
