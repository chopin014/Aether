/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import classNames from "classnames";

import styles from "./LiveIcons.module.css";
import { useMaskId } from "./useMaskId";

/** A solid smiling face, like Compound's. Hovering its button makes it tilt, grin and wink. */
export function ReactionIcon({ className }: { className?: string }): JSX.Element {
    const mask = useMaskId("reaction-face");
    return (
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={classNames(styles.live, className)}>
            <mask id={mask} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
                <rect width="24" height="24" fill="white" />
                <circle className={styles.reactionEye} cx="8.5" cy="10.5" r="1.5" />
                <circle className={styles.reactionEye} cx="15.5" cy="10.5" r="1.5" />
                <path className={styles.reactionFeature} d="M9.17 14.83a4 4 0 0 0 5.66 0" />
            </mask>
            <circle className={styles.reactionFace} cx="12" cy="12" r="10" mask={`url(#${mask})`} />
        </svg>
    );
}
