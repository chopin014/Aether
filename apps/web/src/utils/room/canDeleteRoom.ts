/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { EventType, KnownMembership, type Room } from "matrix-js-sdk/src/matrix";

/** Whether the user can lock this room and remove every other member and invitation. */
export function canDeleteRoom(room: Room, userId: string): boolean {
    const actor = room.getMember(userId);
    const state = room.currentState;
    if (
        actor?.membership !== KnownMembership.Join ||
        !state.maySendStateEvent(EventType.RoomJoinRules, userId) ||
        !state.maySendStateEvent(EventType.RoomPowerLevels, userId) ||
        !state.hasSufficientPowerLevelFor("kick", actor.powerLevel)
    )
        return false;

    if (
        state
            .getStateEvents(EventType.RoomThirdPartyInvite)
            .some((event) => Object.keys(event.getContent()).length > 0) &&
        !state.maySendStateEvent(EventType.RoomThirdPartyInvite, userId)
    )
        return false;

    return room
        .getMembers()
        .every(
            (member) =>
                member.userId === userId ||
                ![KnownMembership.Join, KnownMembership.Invite, KnownMembership.Knock].some(
                    (membership) => member.membership === membership,
                ) ||
                member.powerLevel < actor.powerLevel,
        );
}
