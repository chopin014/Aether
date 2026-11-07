/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import classNames from "classnames";

import styles from "./LiveIcons.module.css";

/**
 * Compound's audio waveform, drawn as separate bars. Hovering its button makes the bars jump about like noise, then
 * presses them flat before they settle.
 */
export function NoiseSuppressionIcon({ className }: { className?: string }): JSX.Element {
    return (
        <svg viewBox="0 0 24 24" aria-hidden="true" className={classNames(styles.live, styles.noise, className)}>
            <line x1="4" y1="10" x2="4" y2="14" />
            <line x1="8" y1="7" x2="8" y2="17" />
            <line x1="12" y1="4" x2="12" y2="20" />
            <line x1="16" y1="7" x2="16" y2="17" />
            <line x1="20" y1="10" x2="20" y2="14" />
        </svg>
    );
}
