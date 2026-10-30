/*
Copyright 2024 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { type JSX, useEffect } from "react";
import {
    useCreateAutoDisposedViewModel,
    DisambiguatedProfileView,
    ProfileDecoration,
    ProfileNameplate,
} from "@element-hq/web-shared-components";

import { type RoomMember } from "../../../../../models/rooms/RoomMember";
import { useMemberTileViewModel } from "../../../../viewmodels/memberlist/tiles/MemberTileViewModel";
import { E2EIconView } from "./common/E2EIconView";
import { useFeatureEnabled } from "../../../../../hooks/useSettings";
import { useMergedPresence } from "../../../../../presence/useMergedPresence";
import AvatarPresenceIconView from "./common/PresenceIconView";
import BaseAvatar from "../../../avatars/BaseAvatar";
import { _t } from "../../../../../languageHandler";
import { MemberTileView } from "./common/MemberTileView";
import { InvitedIconView } from "./common/InvitedIconView";
import { type MemberWithSeparator } from "../../../../viewmodels/memberlist/MemberListViewModel";
import { DisambiguatedProfileViewModel } from "../../../../../viewmodels/room/timeline/event-tile/DisambiguatedProfileViewModel";
import { useUserStatus } from "../../../../../hooks/useUserStatus";
import { useRichRowProfile } from "../../../../../profile/useRichProfile";

interface IProps {
    /**
     * Needed for `onFocus`
     */
    item: MemberWithSeparator;
    member: RoomMember;
    index: number;
    memberCount: number;
    showPresence?: boolean;
    /** Whether to display the member's channel role next to their name. Defaults to true. */
    showRole?: boolean;
    focused?: boolean;
    tabIndex?: number;
    onFocus: (item: MemberWithSeparator, e: React.FocusEvent) => void;
}

export function RoomMemberTileView(props: IProps): JSX.Element {
    const vm = useMemberTileViewModel(props);
    const member = vm.member;
    const rich = useRichRowProfile(member.isInvite ? undefined : member.userId);
    const av = (
        <>
            <BaseAvatar
                size="32px"
                name={member.name}
                idName={member.userId}
                title={member.displayUserId}
                url={member.avatarThumbnailUrl}
                altText={_t("common|user_avatar")}
            />
            {rich?.appearance?.decoration && <ProfileDecoration id={rich.appearance.decoration} />}
        </>
    );
    const name = vm.name;
    const syncedStatus = useUserStatus(member.userId);
    // A status shown as its own line under the name does not also need its emoji beside the name.
    const userStatus = rich?.status ? undefined : syncedStatus;
    const disambiguatedProfileVM = useCreateAutoDisposedViewModel(
        () =>
            new DisambiguatedProfileViewModel({
                fallbackName: name,
                member,
                withTooltip: true,
                userStatus,
            }),
    );
    useEffect(() => {
        disambiguatedProfileVM.setMember(name, member);
    }, [disambiguatedProfileVM, member, name]);
    useEffect(() => {
        disambiguatedProfileVM.setUserStatus(userStatus);
    }, [disambiguatedProfileVM, userStatus]);
    const nameJSX = (
        <DisambiguatedProfileView
            vm={disambiguatedProfileVM}
            className="mx_DisambiguatedProfile"
            nameStyle={rich?.appearance?.nameStyle}
            tag={rich?.tag}
        />
    );

    const desktopShell = useFeatureEnabled("feature_desktop_shell");
    const merged = useMergedPresence(member.isInvite ? undefined : member.userId);
    // Match the desktop Offline group when no presence was reported; activity alone is not an online status.
    const reported = merged && merged.source !== "activity" ? merged : null;
    const presenceState = desktopShell ? (reported?.state ?? "offline") : member.presenceState;
    let presenceJSX: JSX.Element | undefined;
    if (vm.showPresence && presenceState) {
        presenceJSX = (
            <AvatarPresenceIconView
                presenceState={presenceState}
                label={desktopShell ? reported?.label : member.presenceLabel}
            />
        );
    }

    let iconJsx;
    if (vm.e2eStatus) {
        iconJsx = <E2EIconView status={vm.e2eStatus} />;
    }
    if (member.isInvite) {
        iconJsx = <InvitedIconView isThreePid={false} />;
    }

    return (
        <MemberTileView
            onClick={vm.onClick}
            onFocus={(e) => props.onFocus(props.item, e)}
            avatarJsx={av}
            presenceJsx={presenceJSX}
            nameJsx={nameJSX}
            backgroundJsx={
                rich?.appearance?.nameplate ? <ProfileNameplate nameplate={rich.appearance.nameplate} /> : undefined
            }
            subtitleJsx={
                rich?.status ? (
                    <div className="mx_MemberTileView_status" title={rich.status.text}>
                        <span aria-hidden="true">{rich.status.emoji}</span> {rich.status.text}
                    </div>
                ) : undefined
            }
            userLabel={vm.userLabel}
            ariaLabel={name}
            iconJsx={iconJsx}
            focused={props.focused}
            tabIndex={props.tabIndex}
            memberIndex={props.index - (member.isInvite ? 1 : 0)} // Adjust as invites are below the seperator
            memberCount={props.memberCount}
        />
    );
}
