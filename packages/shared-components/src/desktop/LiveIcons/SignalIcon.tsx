/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import classNames from "classnames";

import styles from "./LiveIcons.module.css";

interface SignalIconProps {
    /** How many of the four bars are lit, from 0 for no connection to 4 for a good one. */
    bars: 0 | 1 | 2 | 3 | 4;
    /** Whether the connection is still being made; the bars then fill one after another. */
    pending?: boolean;
    className?: string;
}

/**
 * Four rising bars showing a call's connection strength. Unlit bars stay faint so the icon keeps its shape. Hovering
 * its button sweeps through the bars, like a signal being found.
 */
export function SignalIcon({ bars, pending, className }: SignalIconProps): JSX.Element {
    return (
        <svg
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
            className={classNames(styles.live, styles.signal, className)}
            data-bars={bars}
            data-pending={pending || undefined}
        >
            <rect x="2.5" y="16" width="3" height="5" rx="1.5" />
            <rect x="8" y="12" width="3" height="9" rx="1.5" />
            <rect x="13.5" y="8" width="3" height="13" rx="1.5" />
            <rect x="19" y="4" width="3" height="17" rx="1.5" />
        </svg>
    );
}
