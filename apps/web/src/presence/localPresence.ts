/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type MatrixClient } from "matrix-js-sdk/src/matrix";

import Presence from "../Presence";
import SettingsStore from "../settings/SettingsStore";
import { type MergedPresence } from "./mergedPresence";

/** This device knows its own status without receiving a server or encrypted presence echo. */
export function getLocalPresence(client: MatrixClient, userId: string): MergedPresence | null {
    if (!SettingsStore.getValue("feature_desktop_shell") || userId !== client.getUserId()) return null;
    const presence = Presence.forClient(client);
    if (!presence.getSnapshot().enabled) return null;
    return { state: presence.getDesired(), source: "local" };
}
