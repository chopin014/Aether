/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type MatrixEvent } from "matrix-js-sdk/src/matrix";

import { MessagePreviewStore } from "../../stores/message-preview";
import { _t } from "../../languageHandler";

/** Derive a thread label from the current root, including edits, decryption and redactions. */
export function threadLabel(event?: MatrixEvent): string {
    if (event?.isRedacted()) return _t("desktop|threads|removed");
    if (!event) return _t("common|thread");
    return MessagePreviewStore.instance.generatePreviewForEvent(event) || _t("common|thread");
}
