/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import classNames from "classnames";

import styles from "./LiveIcons.module.css";

/** Compound's end call handset. Hovering its button lifts the handset, then puts it down hard. */
export function HangUpIcon({ className }: { className?: string }): JSX.Element {
    return (
        <svg
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
            className={classNames(styles.live, styles.hangUp, className)}
        >
            <path d="m2.765 16.02-2.47-2.416A1.02 1.02 0 0 1 0 12.852q0-.456.295-.751a15.6 15.6 0 0 1 5.316-3.786A15.9 15.9 0 0 1 12 7q3.355 0 6.39 1.329a16 16 0 0 1 5.315 3.772q.295.294.295.751t-.295.752l-2.47 2.416a1.047 1.047 0 0 1-1.396.108l-3.114-2.363a1.1 1.1 0 0 1-.322-.376 1.1 1.1 0 0 1-.108-.483v-2.27a13.6 13.6 0 0 0-2.12-.524C13.459 9.996 12 9.937 12 9.937s-1.459.059-2.174.175q-1.074.174-2.121.523v2.271q0 .268-.108.483a1.1 1.1 0 0 1-.322.376l-3.114 2.363a1.047 1.047 0 0 1-1.396-.107" />
        </svg>
    );
}
