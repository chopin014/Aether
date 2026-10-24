/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { Room, RoomMember as SdkRoomMember } from "matrix-js-sdk/src/matrix";
import { KnownMembership } from "matrix-js-sdk/src/types";
import { mkThirdPartyInviteEvent, stubClient } from "test-utils";

import { type RoomMember } from "../../models/rooms/RoomMember";
import { SEPARATOR } from "../../components/viewmodels/memberlist/MemberListViewModel";
import { groupDesktopMembers, isMemberHeading, type DesktopMemberListItem } from "./desktopMemberGroups";

function member(name: string, powerLevel = 0, presenceState: RoomMember["presenceState"] = "online") {
    return {
        member: {
            roomId: "!channel:example.org",
            userId: `@${name.toLowerCase()}:example.org`,
            displayUserId: `@${name.toLowerCase()}:example.org`,
            name,
            powerLevel,
            presenceState,
            disambiguate: false,
            lastModifiedTime: 0,
            isInvite: false,
        },
    };
}

function headings(items: DesktopMemberListItem[]) {
    return items.filter(isMemberHeading).map(({ heading, count }) => [heading, count]);
}

function names(items: DesktopMemberListItem[]) {
    return items.flatMap((item) =>
        item !== SEPARATOR && !isMemberHeading(item) && item.member ? item.member.name : [],
    );
}

describe("groupDesktopMembers", () => {
    it("should use roles and neutral Members when no presence is available", () => {
        const admin: { member: RoomMember } = member("Admin", 100);
        const regular: { member: RoomMember } = member("Regular");
        delete admin.member.presenceState;
        delete regular.member.presenceState;
        expect(headings(groupDesktopMembers([admin, regular], true, null, "en"))).toEqual([
            ["Admin", 1],
            ["Member list", 1],
        ]);
    });

    it("should preserve all genuinely offline users without assuming a disabled server", () => {
        expect(headings(groupDesktopMembers([member("Offline", 0, "offline")], true, null, "en"))).toEqual([
            ["Offline", 1],
        ]);
    });

    it("should group available members by highest standard role, then online members and all offline roles", () => {
        const items = groupDesktopMembers(
            [
                member("Zoe", 0),
                member("Offline owner", Infinity, "offline"),
                member("Moderator", 75, "unavailable"),
                member("Admin", 100),
                member("Owner", Infinity),
                member("Offline admin", 100, "offline"),
                member("Ada"),
                member("Offline moderator", 50, "offline"),
            ],
            true,
            null,
            "en",
        );
        expect(headings(items)).toEqual([
            ["Owner", 1],
            ["Admin", 1],
            ["Moderator", 1],
            ["Online", 2],
            ["Offline", 3],
        ]);
        expect(names(items)).toEqual([
            "Owner",
            "Admin",
            "Moderator",
            "Ada",
            "Zoe",
            "Offline admin",
            "Offline moderator",
            "Offline owner",
        ]);
    });

    it("should reuse badge thresholds for numeric custom levels instead of inventing named roles", () => {
        const items = groupDesktopMembers(
            [member("Level 200", 200), member("Level 99", 99), member("Level 49", 49), member("Restricted", -1)],
            true,
            null,
            "en",
        );
        expect(headings(items)).toEqual([
            ["Admin", 1],
            ["Moderator", 1],
            ["Online", 2],
        ]);
    });

    it("should use actual joined Space roles without falling back to channel authority for absent or invited members", () => {
        const client = stubClient();
        const space = new Room("!space:example.org", client, client.getSafeUserId());
        const channelAdmin = member("Channel admin", 100);
        const serverAdmin = member("Server admin", 0);
        const absent = member("Absent", 100);
        const invited = member("Space invite", 100);
        for (const [item, level, membership] of [
            [channelAdmin, 0, KnownMembership.Join],
            [serverAdmin, 100, KnownMembership.Join],
            [invited, 100, KnownMembership.Invite],
        ] as const) {
            const spaceMember = new SdkRoomMember(space.roomId, item.member.userId);
            spaceMember.powerLevel = level;
            spaceMember.membership = membership;
            space.currentState.members[spaceMember.userId] = spaceMember;
        }
        const items = groupDesktopMembers([absent, channelAdmin, invited, serverAdmin], true, space, "en");
        expect(headings(items)).toEqual([
            ["Admin", 1],
            ["Online", 3],
        ]);
        expect(names(items)[0]).toBe("Server admin");
        expect(serverAdmin.member.powerLevel).toBe(0);
        expect(serverAdmin.member.roomId).toBe("!channel:example.org");
    });

    it("should distinguish unknown and unreachable members from received offline presence", () => {
        const missingPresence: { member: RoomMember } = member("Missing", 100);
        delete missingPresence.member.presenceState;
        const items = groupDesktopMembers(
            [member("Unreachable", 50, "io.element.unreachable"), missingPresence, member("Offline", 100, "offline")],
            true,
            null,
            "en",
        );
        expect(headings(items)).toEqual([
            ["Status unknown", 2],
            ["Offline", 1],
        ]);
    });

    it("should use neutral role and member groups when the homeserver disables presence", () => {
        const items = groupDesktopMembers(
            [member("Offline admin", 100, "offline"), member("Offline", 0, "offline"), member("Online")],
            false,
            null,
            "en",
        );
        expect(headings(items)).toEqual([
            ["Admin", 1],
            ["Member list", 2],
        ]);
    });

    it("should omit empty groups and deduplicate rows without combining distinct invitations", () => {
        const ada = member("Ada", 100);
        const invitation = member("Invited", 100);
        invitation.member.isInvite = true;
        const threePidInvite = {
            threePidInvite: {
                event: mkThirdPartyInviteEvent("@sender:example.org", "same@example.org", "!channel:example.org"),
            },
        };
        const anotherInvite = {
            threePidInvite: {
                event: mkThirdPartyInviteEvent("@sender:example.org", "same@example.org", "!channel:example.org"),
            },
        };
        const items = groupDesktopMembers(
            [ada, ada, SEPARATOR, invitation, threePidInvite, anotherInvite],
            true,
            null,
            "en",
        );
        expect(headings(items)).toEqual([
            ["Admin", 1],
            ["Invited", 3],
        ]);
        expect(items).toHaveLength(6);
        expect(groupDesktopMembers([], true, null, "en")).toEqual([]);
    });

    it("should break matching display names by user ID and ignore activity and input order", () => {
        const first = member("Same");
        first.member.userId = "@a:example.org";
        const second = member("same");
        second.member.userId = "@b:example.org";
        const rows = groupDesktopMembers([second, first], true, null, "en");
        expect(rows.slice(1)).toEqual([first, second]);
    });

    it("should derive counts from the filtered rows and retain the original member objects for profile actions", () => {
        const ada = member("Ada", 100);
        const rows = groupDesktopMembers([ada], true, null, "en");
        expect(headings(rows)).toEqual([["Admin", 1]]);
        expect(rows[1]).toBe(ada);
    });
});
