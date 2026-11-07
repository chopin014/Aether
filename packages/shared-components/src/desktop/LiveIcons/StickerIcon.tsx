/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import classNames from "classnames";

import styles from "./LiveIcons.module.css";
import { useMaskId } from "./useMaskId";

/**
 * A solid sticker with its corner peeled up, the shape of Compound's outlined one. Hovering its button slaps the
 * sticker down, and its corner peels up again.
 */
export function StickerIcon({ className }: { className?: string }): JSX.Element {
    const mask = useMaskId("sticker-peel");
    return (
        <svg
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
            className={classNames(styles.live, styles.sticker, className)}
        >
            <mask id={mask} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
                <rect width="24" height="24" fill="white" />
                <path className={styles.stickerFold} d="M13 21.5V16a3 3 0 0 1 3-3h5.5" pathLength="1" />
            </mask>
            <g className={styles.stickerBody}>
                <path
                    d="M17 2a5 5 0 0 1 5 5v5.334a5 5 0 0 1-1.58 3.647l-4.978 4.667A5 5 0 0 1 12.023 22H7a5 5 0 0 1-5-5V7a5 5 0 0 1 5-5z"
                    mask={`url(#${mask})`}
                />
            </g>
        </svg>
    );
}
