/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { EventType, type MatrixClient, type Room } from "matrix-js-sdk/src/matrix";
import { KnownMembership } from "matrix-js-sdk/src/types";

import { MAX_RECIPIENTS, MAX_ROOM_MEMBERS } from "./aetherPresence";

/** Whether the room is a DM according to the `m.direct` account data, and with whom. */
function directPartners(client: MatrixClient): Set<string> {
    const partners = new Set<string>();
    const direct = client.getAccountData(EventType.Direct)?.getContent<Record<string, string[]>>() ?? {};
    for (const [userId, roomIds] of Object.entries(direct)) {
        if (!Array.isArray(roomIds)) continue;
        for (const roomId of roomIds) {
            const room = client.getRoom(roomId);
            if (room?.getMyMembership() === KnownMembership.Join && room.getMember(userId)) {
                partners.add(userId);
                break;
            }
        }
    }
    return partners;
}

/**
 * The users this client announces its status to: people it has a DM with, plus joined members of joined rooms
 * with at most {@link MAX_ROOM_MEMBERS} joined members. The result is de-duplicated, never contains the account
 * itself or ignored users, and is capped at {@link MAX_RECIPIENTS} with DM partners kept first.
 */
export function selectPresenceRecipients(client: MatrixClient): string[] {
    const self = client.getUserId();
    const ignored = new Set(client.getIgnoredUsers());
    const result = new Set<string>();
    const add = (userId: string): void => {
        if (userId !== self && !ignored.has(userId)) result.add(userId);
    };

    for (const userId of directPartners(client)) add(userId);
    for (const room of client.getRooms()) {
        if (room.getMyMembership() !== KnownMembership.Join) continue;
        if (room.getJoinedMemberCount() > MAX_ROOM_MEMBERS) continue;
        for (const member of room.getJoinedMembers()) add(member.userId);
    }
    return [...result].slice(0, MAX_RECIPIENTS);
}

/** Whether we are both joined to a room together. Used to ignore signals from strangers. */
export function sharesJoinedRoom(client: MatrixClient, userId: string): boolean {
    return client
        .getRooms()
        .some(
            (room: Room) =>
                room.getMyMembership() === KnownMembership.Join &&
                room.getMember(userId)?.membership === KnownMembership.Join,
        );
}
