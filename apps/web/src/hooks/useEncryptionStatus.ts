/*
Copyright 2024 New Vector Ltd.
Copyright 2023 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { type MatrixClient, type MatrixEvent, type Room, EventType, RoomStateEvent } from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";
import { useEffect, useState } from "react";
import { throttle } from "lodash";
import { CryptoEvent } from "matrix-js-sdk/src/crypto-api";

import { type E2EStatus, shieldStatusForRoom } from "../utils/ShieldUtils";
import { isRoomEncrypted } from "./useIsEncrypted";

/** Watch the trust shield for an encrypted room, leaving public rooms unloaded. */
export function useEncryptionStatus(client: MatrixClient, room: Room): E2EStatus | null {
    const [result, setResult] = useState<{ client: MatrixClient; room: Room; status: E2EStatus | null } | null>(null);

    useEffect(() => {
        let disposed = false;
        let latestRequest = 0;
        const updateEncryptionStatus = throttle(
            () => {
                const request = ++latestRequest;
                const isCurrent = (): boolean => !disposed && request === latestRequest;
                const crypto = client.getCrypto();
                if (!crypto) {
                    setResult({ client, room, status: null });
                    return;
                }
                // Shield evaluation loads encryption target members. Public rooms must
                // never start that work, including while a new room's check is pending.
                void isRoomEncrypted(room, crypto)
                    .then(async (encrypted) => {
                        if (!isCurrent()) return;
                        const status = encrypted ? await shieldStatusForRoom(client, room) : null;
                        if (isCurrent()) setResult({ client, room, status });
                    })
                    .catch((error: unknown) => {
                        if (isCurrent()) logger.warn("Unable to update room encryption status", error);
                    });
            },
            250,
            { leading: true, trailing: true },
        );
        const onStateEvent = (event: MatrixEvent): void => {
            if (event.getType() === EventType.RoomEncryption) updateEncryptionStatus();
        };

        // Trust depends on membership and device verification; encryption can also be
        // enabled after the header has already mounted in a public room.
        room.currentState.on(RoomStateEvent.Events, onStateEvent);
        room.on(RoomStateEvent.Members, updateEncryptionStatus);
        client.on(CryptoEvent.UserTrustStatusChanged, updateEncryptionStatus);
        client.on(CryptoEvent.DevicesUpdated, updateEncryptionStatus);
        updateEncryptionStatus();
        return () => {
            disposed = true;
            updateEncryptionStatus.cancel();
            room.currentState.off(RoomStateEvent.Events, onStateEvent);
            room.off(RoomStateEvent.Members, updateEncryptionStatus);
            client.off(CryptoEvent.UserTrustStatusChanged, updateEncryptionStatus);
            client.off(CryptoEvent.DevicesUpdated, updateEncryptionStatus);
        };
    }, [client, room]);

    return result?.client === client && result.room === room ? result.status : null;
}
