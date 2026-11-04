/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type MatrixClient } from "matrix-js-sdk/src/matrix";

import { CallStore } from "../../../stores/CallStore";
import SdkConfig from "../../../SdkConfig";

/** How long a join waits for the account's `.well-known` when it has not arrived yet. */
const WELL_KNOWN_WAIT_MS = 5_000;

/**
 * The LiveKit call service of the account that is joining, for Element Call to use when the homeserver does not list
 * transports itself. It is read at join time from that account, so a window that signed in to another account, or
 * whose `.well-known` arrived late, never uses a previous or missing one.
 */
export async function callServiceUrlFor(client: MatrixClient): Promise<string | undefined> {
    const waiting =
        SdkConfig.get("enable_client_well_known_lookups") &&
        !client.cachedRtcTransports.get() &&
        client.getClientWellKnown() === undefined;
    if (waiting) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
            client.waitForClientWellKnown().catch(() => undefined),
            new Promise<void>((resolve) => (timer = setTimeout(resolve, WELL_KNOWN_WAIT_MS))),
        ]);
        clearTimeout(timer);
    }
    const transport = CallStore.configuredRTCTransports(client).find(
        (candidate): candidate is typeof candidate & { livekit_service_url: string } =>
            candidate.type === "livekit" && typeof candidate.livekit_service_url === "string",
    );
    return transport?.livekit_service_url;
}
