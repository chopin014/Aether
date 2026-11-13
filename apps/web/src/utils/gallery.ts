/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { EventType, MsgType, type MatrixEvent } from "matrix-js-sdk/src/matrix";

/** The longest gap between two pictures from one person for them to count as sent together. */
export const GALLERY_WINDOW_MS = 60_000;

/**
 * Whether an event is a picture that a gallery can hold. Videos keep their own row, where their player has room.
 *
 * @param event - the event to check
 * @param asFirst - whether it would open the gallery, which may carry the text sent with the pictures (a caption)
 *   and reply to a message; later pictures may not, since that text belongs to them alone
 */
export function isGalleryMedia(event: MatrixEvent, asFirst: boolean): boolean {
    if (event.getType() !== EventType.RoomMessage || event.isRedacted() || event.isDecryptionFailure()) return false;
    const content = event.getContent();
    if (content.msgtype !== MsgType.Image) return false;
    if (asFirst) return true;
    const hasCaption = !!content.filename && content.filename !== content.body;
    return !hasCaption && !event.replyEventId;
}

/** How many columns the pictures after the first fill: one row for up to three, then pairs, then threes. */
export function galleryColumns(count: number): number {
    if (count <= 3) return count;
    if (count === 4) return 2;
    return 3;
}
