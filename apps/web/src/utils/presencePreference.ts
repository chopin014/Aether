/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type MatrixClient, SetPresence } from "matrix-js-sdk/src/matrix";

/** Keep this device's intent separate for each account and homeserver, including across client restarts. */
export function presencePreferenceKey(client: MatrixClient): string {
    return `aether.presence.${JSON.stringify([client.baseUrl, client.getUserId(), client.getDeviceId()])}`;
}

/** Read a saved choice without allowing unavailable browser storage to prevent login. */
export function readPresencePreference(client: MatrixClient): SetPresence {
    try {
        const value = localStorage.getItem(presencePreferenceKey(client));
        if (value === SetPresence.Offline || value === SetPresence.Unavailable) return value;
    } catch {
        // Storage can be unavailable in private browsing.
    }
    return SetPresence.Online;
}
