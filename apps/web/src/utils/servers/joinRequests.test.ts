/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    EventTimeline,
    JoinRule,
    KnownMembership,
    type MatrixClient,
    Room,
    type RoomMember,
} from "matrix-js-sdk/src/matrix";
import { stubClient } from "test-utils";

import { canDeclineJoinRequests, canReviewJoinRequests, pendingJoinRequests } from "./joinRequests";

describe("joinRequests", () => {
    let client: MatrixClient;
    let space: Room;
    const carol = { userId: "@carol:example.org" } as RoomMember;

    beforeEach(() => {
        client = stubClient();
        space = new Room("!server:example.org", client, client.getSafeUserId());
        vi.spyOn(space, "getMyMembership").mockReturnValue(KnownMembership.Join);
        vi.spyOn(space, "getJoinRule").mockReturnValue(JoinRule.Knock);
        vi.spyOn(space, "canInvite").mockReturnValue(true);
        vi.spyOn(space, "getMembersWithMembership").mockImplementation((membership) =>
            membership === KnownMembership.Knock ? [carol] : [],
        );
    });

    afterEach(() => vi.restoreAllMocks());

    it("lists the people asking to join for someone who can let them in", () => {
        expect(canReviewJoinRequests(space)).toBe(true);
        expect(pendingJoinRequests(space)).toEqual([carol]);
    });

    it("lists nobody for someone who cannot invite", () => {
        vi.mocked(space.canInvite).mockReturnValue(false);
        expect(pendingJoinRequests(space)).toEqual([]);
    });

    it("lists nobody when the server does not take requests or the user is not in it", () => {
        vi.mocked(space.getJoinRule).mockReturnValue(JoinRule.Invite);
        expect(pendingJoinRequests(space)).toEqual([]);

        vi.mocked(space.getJoinRule).mockReturnValue(JoinRule.Knock);
        vi.mocked(space.getMyMembership).mockReturnValue(KnownMembership.Invite);
        expect(pendingJoinRequests(space)).toEqual([]);
    });

    it("lets only people with the power to remove members turn requests down", () => {
        vi.spyOn(space, "getMember").mockReturnValue({ powerLevel: 50 } as RoomMember);
        const state = space.getLiveTimeline().getState(EventTimeline.FORWARDS)!;
        const sufficient = vi.spyOn(state, "hasSufficientPowerLevelFor").mockReturnValue(true);
        expect(canDeclineJoinRequests(space)).toBe(true);
        expect(sufficient).toHaveBeenCalledWith("kick", 50);

        sufficient.mockReturnValue(false);
        expect(canDeclineJoinRequests(space)).toBe(false);

        vi.mocked(space.getMember).mockReturnValue(null);
        expect(canDeclineJoinRequests(space)).toBe(false);
    });
});
