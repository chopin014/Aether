/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { EventStatus, type MatrixEvent } from "matrix-js-sdk/src/matrix";

import type { EventSendState } from "@element-hq/web-shared-components";

/**
 * The send state of a row's message, read as `MessagePanel` reads it for the old timeline: the
 * associated status also covers our pending edit or redaction of a message the server already has.
 */
export function sendStateOf(event: MatrixEvent): EventSendState | undefined {
    switch (event.getAssociatedStatus()) {
        case EventStatus.ENCRYPTING:
            return "encrypting";
        case EventStatus.QUEUED:
        case EventStatus.SENDING:
            return "sending";
        case EventStatus.SENT:
            return "sent";
        case EventStatus.NOT_SENT:
            return "failed";
        default:
            return undefined;
    }
}
