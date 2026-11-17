/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { logger } from "matrix-js-sdk/src/logger";
import { KnownMembership } from "matrix-js-sdk/src/types";
import { RoomEvent, type MatrixClient, type Room } from "matrix-js-sdk/src/matrix";

const watched = new WeakSet<MatrixClient>();

/**
 * Join a server or room as soon as a member lets the user in. Letting someone in sends them an invite, but they
 * already asked to join, so making them accept it as well would only add a step. Joining a server also joins its
 * channels, as any other way in does.
 */
export function joinWhenLetIn(client: MatrixClient): void {
    if (watched.has(client)) return;
    watched.add(client);
    client.on(RoomEvent.MyMembership, (room: Room, membership: string, prevMembership?: string) => {
        if (prevMembership !== KnownMembership.Knock || membership !== KnownMembership.Invite) return;
        void join(client, room.roomId);
    });
}

async function join(client: MatrixClient, roomId: string): Promise<void> {
    try {
        await client.joinRoom(roomId, { acceptSharedHistory: true });
        // Loaded lazily, as the room view store does: the flow opens dialogs that depend on the stores.
        const { onServerJoined } = await import("./joinServer");
        await onServerJoined(client, roomId);
    } catch (error) {
        // The invite stays, so the user can still accept it by hand.
        logger.warn("Could not join after being let in", error);
    }
}
