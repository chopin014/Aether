/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type User } from "matrix-js-sdk/src/matrix";

/** Read received presence only: the SDK's initial offline value is not a server observation. */
export function getKnownPresence(user: User | null | undefined): string | undefined {
    return user?.events?.presence ? user.presence : undefined;
}
