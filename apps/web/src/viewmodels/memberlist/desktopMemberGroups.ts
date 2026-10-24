/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type Room } from "matrix-js-sdk/src/matrix";
import { KnownMembership } from "matrix-js-sdk/src/types";

import { type RoomMember as Member } from "../../models/rooms/RoomMember";
import { SEPARATOR, type MemberWithSeparator } from "../../components/viewmodels/memberlist/MemberListViewModel";
import { _t } from "../../languageHandler";
import { getPowerLevelRole } from "../../Roles";

/** A non-focusable heading in the desktop member list. Counts include only visible matching members. */
export interface DesktopMemberHeading {
    heading: string;
    count: number;
    key: string;
}

/** Existing member rows interleaved with desktop group headings. */
export type DesktopMemberListItem = MemberWithSeparator | DesktopMemberHeading;

/** Whether an item is a group heading rather than a member row. */
export function isMemberHeading(item: DesktopMemberListItem): item is DesktopMemberHeading {
    return typeof item === "object" && "heading" in item;
}

/**
 * Group the channel's visible members by presence and highest standard Matrix role.
 * In a Space, only joined Space members receive Space roles; channel power never supplies a missing server role.
 * Missing or unsupported presence is presented in Offline alongside received offline states.
 */
export function groupDesktopMembers(
    members: MemberWithSeparator[],
    isPresenceEnabled: boolean,
    roleSpace: Room | null,
    language: string,
): DesktopMemberListItem[] {
    const roles = new Map<number, { heading: string; members: MemberWithSeparator[] }>();
    const others: MemberWithSeparator[] = [];
    const offline: MemberWithSeparator[] = [];
    // Local intent and Aether reports also work when homeserver presence is disabled.
    const knownState = (member: Member | undefined): string | undefined =>
        member?.presenceSource === "aether" ||
        member?.presenceSource === "local" ||
        (isPresenceEnabled && !member?.presenceSource)
            ? member?.presenceState
            : undefined;
    const invited: MemberWithSeparator[] = [];
    const seen = new Set<string>();
    for (const item of members) {
        if (item === SEPARATOR) continue;
        const member = item.member;
        const key = member ? member.userId : `invite-${item.threePidInvite.event.getStateKey()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!member || member.isInvite) {
            invited.push(item);
            continue;
        }
        const state = knownState(member);
        if (state !== "online" && state !== "unavailable" && state !== "busy") {
            offline.push(item);
            continue;
        }
        const spaceMember = roleSpace?.getMember(member.userId);
        const powerLevel = roleSpace
            ? spaceMember?.membership === KnownMembership.Join
                ? spaceMember.powerLevel
                : 0
            : member.powerLevel;
        const role = getPowerLevelRole(powerLevel);
        if (role) {
            const group = roles.get(role.level) ?? { heading: role.label, members: [] };
            group.members.push(item);
            roles.set(role.level, group);
        } else {
            others.push(item);
        }
    }

    const collator = new Intl.Collator(language, { sensitivity: "base", ignorePunctuation: true });
    const sortKey = (item: MemberWithSeparator): string => {
        if (item === SEPARATOR) return "";
        return item.member?.name ?? item.threePidInvite?.event.getContent().display_name ?? "";
    };
    const identity = (item: MemberWithSeparator): string => {
        if (item === SEPARATOR) return "";
        return item.member?.userId ?? item.threePidInvite?.event.getStateKey() ?? "";
    };
    const result: DesktopMemberListItem[] = [];
    const append = (key: string, heading: string, rows: MemberWithSeparator[]): void => {
        if (!rows.length) return;
        rows.sort((a, b) => collator.compare(sortKey(a), sortKey(b)) || identity(a).localeCompare(identity(b)));
        result.push({ key, heading, count: rows.length }, ...rows);
    };
    for (const [level, group] of [...roles].sort(([a], [b]) => b - a)) {
        append(`role-${level}`, group.heading, group.members);
    }
    append("online", _t("desktop|contacts|online"), others);
    append("offline", _t("desktop|contacts|offline"), offline);
    append("invited", _t("desktop|members|invited"), invited);
    return result;
}
