/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, type SVGProps } from "react";

/** A screen with a play mark, for watching and listening together; drawn like Compound's solid icons. */
export function WatchTogetherIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
    return (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" {...props}>
            <path
                fillRule="evenodd"
                d="M4.5 3h15A2.5 2.5 0 0 1 22 5.5v9a2.5 2.5 0 0 1-2.5 2.5h-15A2.5 2.5 0 0 1 2 14.5v-9A2.5 2.5 0 0 1 4.5 3Zm5.3 3.6v6.8c0 .6.7 1 1.2.7l5.2-3.4c.5-.3.5-1 0-1.4L11 5.9c-.5-.3-1.2 0-1.2.7Z"
            />
            <rect x="7" y="19" width="10" height="2" rx="1" />
        </svg>
    );
}
