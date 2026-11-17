/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { EventTimeline, JoinRule, KnownMembership, type Room, type RoomMember } from "matrix-js-sdk/src/matrix";

/**
 * Whether the user can let people in to a server that takes requests to join: approving sends them an invite, so it
 * needs the invite power level.
 */
export function canReviewJoinRequests(space: Room): boolean {
    const userId = space.client.getUserId();
    if (!userId || space.getMyMembership() !== KnownMembership.Join) return false;
    if (space.getJoinRule() !== JoinRule.Knock) return false;
    return space.canInvite(userId);
}

/** Whether the user may turn a request down, which removes it with a kick. */
export function canDeclineJoinRequests(space: Room): boolean {
    const member = space.getMember(space.client.getUserId() ?? "");
    const state = space.getLiveTimeline().getState(EventTimeline.FORWARDS);
    return !!member && !!state?.hasSufficientPowerLevelFor("kick", member.powerLevel);
}

/** The people waiting for an answer to their request to join, for someone who can let them in; otherwise none. */
export function pendingJoinRequests(space: Room): RoomMember[] {
    if (!canReviewJoinRequests(space)) return [];
    return space.getMembersWithMembership(KnownMembership.Knock);
}
