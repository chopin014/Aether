/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type IPushRules, type MatrixClient, MatrixError, Method } from "matrix-js-sdk/src/matrix";
import { encodeUri } from "matrix-js-sdk/src/utils";

/*
 * The server's own copy of what a change is about to read, fetched instead of taken from the sync. The sync brings a
 * write back some time after the server accepted it, possibly after other changes or never on its own, so a change
 * that follows another one reads the server's state to see the one before.
 *
 * A server with workers may answer from a worker that hasn't caught up with a write yet, so a caller expecting its own
 * write reads again after each of {@link CATCH_UP_DELAYS} before taking the copy as someone else's newer change.
 */

/** How long to wait before each new read of a copy that doesn't show this client's last write yet. */
export const CATCH_UP_DELAYS = [250, 500, 1_000, 2_000];

/** How long to wait for the server's copy; reading it again later is harmless, unlike a write. */
const FETCH_TIMEOUT = 30_000;

/** The person's push rules, as the server holds them now. */
export function fetchPushRules(client: MatrixClient): Promise<IPushRules> {
    return client.http.authedRequest<IPushRules>(Method.Get, "/pushrules/", undefined, undefined, {
        localTimeoutMs: FETCH_TIMEOUT,
    });
}

/** A room's account data of one type, as the server holds it now; empty when there is none. */
export async function fetchRoomAccountData(
    client: MatrixClient,
    roomId: string,
    type: string,
): Promise<Record<string, unknown>> {
    const path = encodeUri("/user/$userId/rooms/$roomId/account_data/$type", {
        $userId: client.getSafeUserId(),
        $roomId: roomId,
        $type: type,
    });
    try {
        const content = await client.http.authedRequest<Record<string, unknown>>(
            Method.Get,
            path,
            undefined,
            undefined,
            {
                localTimeoutMs: FETCH_TIMEOUT,
            },
        );
        return content ?? {};
    } catch (error) {
        if (error instanceof MatrixError && error.errcode === "M_NOT_FOUND") return {};
        throw error;
    }
}
