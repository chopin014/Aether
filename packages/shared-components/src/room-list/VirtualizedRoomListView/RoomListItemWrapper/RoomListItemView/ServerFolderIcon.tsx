/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { Avatar } from "@vector-im/compound-web";
import classNames from "classnames";

import styles from "./RoomListItemView.module.css";

/** Props for {@link ServerFolderIcon}. */
export interface ServerFolderIconProps {
    /** The nested server's room id, which picks the colour of its initial when it has no avatar. */
    id: string;
    /** The nested server's name, whose initial stands in for a missing avatar. */
    name: string;
    /** The nested server's avatar, as an http URL. */
    avatarUrl?: string;
    /** Whether the folder is open, showing the server's channels beneath it. */
    expanded: boolean;
}

/**
 * A folder with a nested server's avatar on its front, open while the server's channels show beneath it, as a
 * file manager draws a folder with a picture on it.
 */
export function ServerFolderIcon({ id, name, avatarUrl, expanded }: ServerFolderIconProps): JSX.Element {
    return (
        <span
            className={classNames(styles.folderIcon, { [styles.folderOpen]: expanded })}
            data-testid={expanded ? "server-folder-open" : "server-folder-closed"}
            aria-hidden
        >
            <svg viewBox="0 0 24 24" className={styles.folderShape}>
                {/* The back of the folder and its tab. */}
                <path
                    className={styles.folderBack}
                    d="M1.5 5.75A2.25 2.25 0 0 1 3.75 3.5h4.4c.55 0 1.08.22 1.47.6L11.2 5.7h9.05a2.25 2.25 0 0 1 2.25 2.25v11.3a2.25 2.25 0 0 1-2.25 2.25H3.75a2.25 2.25 0 0 1-2.25-2.25z"
                />
                {expanded ? (
                    <>
                        {/* An open folder shows the sheet inside, behind a front that leans forward. */}
                        <path className={styles.folderSheet} d="M4.5 7.6h14.5a1 1 0 0 1 1 1v3H3.5v-3a1 1 0 0 1 1-1z" />
                        <path
                            className={styles.folderFront}
                            d="M5.6 10.4h16.3a1.3 1.3 0 0 1 1.26 1.62l-1.95 7.75a2.25 2.25 0 0 1-2.18 1.73H3.1a1.3 1.3 0 0 1-1.26-1.62l1.77-7.7A2.25 2.25 0 0 1 5.6 10.4z"
                        />
                    </>
                ) : (
                    <rect className={styles.folderFront} x="1.5" y="7.75" width="21" height="13.75" rx="2.25" />
                )}
            </svg>
            <span className={styles.folderAvatar}>
                <Avatar id={id} name={name} src={avatarUrl} size="10px" type="square" />
            </span>
        </span>
    );
}
