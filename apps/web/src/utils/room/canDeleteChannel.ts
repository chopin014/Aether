/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { EventType, KnownMembership, type Room } from "matrix-js-sdk/src/matrix";

/** Whether the user can close this channel and remove its link from the selected server. */
export function canDeleteChannel(room: Room, space: Room | null, userId: string, requireLink = true): boolean {
    const actor = room.getMember(userId);
    const state = room.currentState;
    if (
        !space ||
        room.isSpaceRoom() ||
        actor?.membership !== KnownMembership.Join ||
        space.getMember(userId)?.membership !== KnownMembership.Join ||
        (requireLink &&
            !Array.isArray(space.currentState.getStateEvents(EventType.SpaceChild, room.roomId)?.getContent().via)) ||
        !space.currentState.maySendStateEvent(EventType.SpaceChild, userId) ||
        !state.maySendStateEvent(EventType.RoomJoinRules, userId) ||
        !state.maySendStateEvent(EventType.RoomPowerLevels, userId) ||
        !state.hasSufficientPowerLevelFor("kick", actor.powerLevel)
    ) {
        return false;
    }

    const invitations = state.getStateEvents(EventType.RoomThirdPartyInvite);
    if (invitations.some((event) => Object.keys(event.getContent()).length > 0)) {
        if (!state.maySendStateEvent(EventType.RoomThirdPartyInvite, userId)) return false;
    }

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
