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
 * A solid screen with an arrow cut out of it, like Compound's. Hovering its button sends the arrow flying up off the
 * screen while a new one rises into place.
 */
export function ScreenShareIcon({ className }: { className?: string }): JSX.Element {
    const mask = useMaskId("share-arrow");
    return (
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={classNames(styles.live, className)}>
            <mask id={mask} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
                <rect width="24" height="24" fill="white" />
                <path className={styles.shareArrow} d="M12 13.5V8M9.25 10.5 12 7.75l2.75 2.75" />
            </mask>
            <rect x="2" y="3" width="20" height="15" rx="2" mask={`url(#${mask})`} />
            <rect x="1" y="19" width="22" height="2" rx="1" />
        </svg>
    );
}
