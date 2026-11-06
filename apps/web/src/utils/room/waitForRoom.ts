/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { ClientEvent, type MatrixClient, type Room, RoomEvent, RoomStateEvent } from "matrix-js-sdk/src/matrix";

/**
 * Wait until sync has delivered a room in the state `ready` describes, such as a newly created space whose create
 * event has arrived.
 *
 * @returns the room, or null if it was not ready within `timeoutMs`.
 */
export function waitForRoom(
    client: MatrixClient,
    roomId: string,
    ready: (room: Room) => boolean,
    timeoutMs = 30_000,
): Promise<Room | null> {
    return new Promise((resolve) => {
        const isReady = (room: Room | null): room is Room => !!room && ready(room);
        const existing = client.getRoom(roomId);
        if (isReady(existing)) return resolve(existing);

        const finish = (room: Room | null): void => {
            client.off(ClientEvent.Room, check);
            client.off(RoomEvent.MyMembership, check);
            client.off(RoomStateEvent.Events, check);
            clearTimeout(timer);
            resolve(room);
        };
        const check = (): void => {
            const room = client.getRoom(roomId);
            if (isReady(room)) finish(room);
        };
        const timer = setTimeout(() => finish(null), timeoutMs);
        client.on(ClientEvent.Room, check);
        client.on(RoomEvent.MyMembership, check);
        client.on(RoomStateEvent.Events, check);
    });
}
