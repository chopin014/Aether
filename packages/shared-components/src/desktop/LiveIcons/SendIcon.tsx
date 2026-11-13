/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import classNames from "classnames";

import styles from "./LiveIcons.module.css";

/** Compound's solid paper plane. Hovering its button sends the plane off to the right while a new one glides in. */
export function SendIcon({ className }: { className?: string }): JSX.Element {
    return (
        <svg
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
            className={classNames(styles.live, styles.send, className)}
        >
            <path d="m21.211 12.895-16.14 8.07c-.785.392-1.658-.342-1.406-1.182L5.7 13h6.55a1 1 0 1 0 0-2H5.7L3.665 4.217c-.252-.84.621-1.574 1.405-1.182l16.141 8.07a1 1 0 0 1 0 1.79" />
        </svg>
    );
}
