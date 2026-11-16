/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { Avatar } from "@vector-im/compound-web";

import styles from "./CallParticipantDragOverlayView.module.css";

/** Props for {@link CallParticipantDragOverlayView}. */
export interface CallParticipantDragOverlayViewProps {
    /** The Matrix user ID of the person being dragged. */
    userId: string;
    /** Their name in the channel. */
    name: string;
    /** Their avatar, as an HTTP URL. */
    avatarUrl?: string;
}

/**
 * The person being dragged out of a voice channel's call to another voice channel, as it follows the pointer. It is
 * only a picture: the dragged row keeps focus and the drag is narrated by the room list's live region.
 */
export function CallParticipantDragOverlayView({
    userId,
    name,
    avatarUrl,
}: CallParticipantDragOverlayViewProps): JSX.Element {
    return (
        <div aria-hidden={true} className={styles.dragOverlay} data-testid="call-participant-drag-overlay">
            <Avatar id={userId} name={name} src={avatarUrl} size="20px" type="round" />
            <span className={styles.name}>{name}</span>
        </div>
    );
}
