/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import classNames from "classnames";

import styles from "./LiveIcons.module.css";

/**
 * Compound's plus. Hovering its button gives it a quarter turn, and it turns into a cross while the menu it opens is
 * showing, read from the button's `aria-expanded`.
 */
export function AddIcon({ className }: { className?: string }): JSX.Element {
    return (
        <svg
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
            className={classNames(styles.live, styles.add, className)}
        >
            <path d="M11 13H6a1 1 0 1 1 0-2h5V6a1 1 0 1 1 2 0v5h5a1 1 0 1 1 0 2h-5v5a1 1 0 1 1-2 0z" />
        </svg>
    );
}
