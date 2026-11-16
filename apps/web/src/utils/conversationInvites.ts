/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { KnownMembership, type MatrixClient, type Room } from "matrix-js-sdk/src/matrix";

import { MetaSpace } from "../stores/spaces";
import type SpaceStore from "../stores/spaces/SpaceStore";

/** Who invited the person to a room they are invited to, if known. */
export function inviterOf(client: MatrixClient, room: Room): string | undefined {
    return room.getDMInviter() ?? room.getMember(client.getSafeUserId())?.events.member?.getSender();
}

/**
 * Whether a room is an invitation to a conversation in Home: a direct message or a group outside any server. The desktop
 * shell treats these as Discord treats friend requests. Invitations to servers wait in the server rail, and to a
 * server's channels in that server.
 */
export function isConversationInvite(room: Room, spaceStore: Pick<SpaceStore, "isRoomInSpace">): boolean {
    return (
        room.getMyMembership() === KnownMembership.Invite &&
        !room.isSpaceRoom() &&
        spaceStore.isRoomInSpace(MetaSpace.Home, room.roomId)
    );
}

/** How many invitations to conversations wait for an answer, leaving out those from people the person ignores. */
export function countConversationInvites(client: MatrixClient, spaceStore: Pick<SpaceStore, "isRoomInSpace">): number {
    const ignored = new Set(client.getIgnoredUsers());
    return client.getVisibleRooms().filter((room) => {
        if (!isConversationInvite(room, spaceStore)) return false;
        const inviter = inviterOf(client, room);
        return !inviter || !ignored.has(inviter);
    }).length;
}
