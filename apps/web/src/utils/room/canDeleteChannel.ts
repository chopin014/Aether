/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { EventType, KnownMembership, type Room } from "matrix-js-sdk/src/matrix";

import { canDeleteRoom } from "./canDeleteRoom";

/** Whether the user can close this channel and remove its link from the selected server. */
export function canDeleteChannel(room: Room, space: Room | null, userId: string, requireLink = true): boolean {
    return (
        !!space &&
        !room.isSpaceRoom() &&
        space.getMember(userId)?.membership === KnownMembership.Join &&
        (!requireLink ||
            Array.isArray(space.currentState.getStateEvents(EventType.SpaceChild, room.roomId)?.getContent().via)) &&
        space.currentState.maySendStateEvent(EventType.SpaceChild, userId) &&
        canDeleteRoom(room, userId)
    );
}
