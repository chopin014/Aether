/*
Copyright 2024 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { type JSX, useEffect } from "react";
import VolumeOnIcon from "@vector-im/compound-design-tokens/assets/web/icons/volume-on";
import {
    useCreateAutoDisposedViewModel,
    useProfileMotion,
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
import { useVoiceRoom } from "../../../../../profile/voiceActivity";
import { useMatrixClientContext } from "../../../../../contexts/MatrixClientContext";

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
    /** The member is listed under Offline, so the row is dimmed until it is hovered. */
    offline?: boolean;
    onFocus: (item: MemberWithSeparator, e: React.FocusEvent) => void;
}

export function RoomMemberTileView(props: IProps): JSX.Element {
    const vm = useMemberTileViewModel(props);
    const member = vm.member;
    const rich = useRichRowProfile(member.isInvite ? undefined : member.userId, member.avatarMxc);
    // A list of decorated people stays still until the pointer or keyboard reaches one of them, like Discord's.
    const motion = useProfileMotion(false);
    const av = (
        <>
            <BaseAvatar
                size="32px"
                name={member.name}
                idName={member.userId}
                title={member.displayUserId}
                url={(motion.live && rich?.appearance?.avatarAnimatedUrl) || member.avatarThumbnailUrl}
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
    const client = useMatrixClientContext();
    // Like Discord's "In voice", from the MatrixRTC calls this client follows.
    const voiceRoomId = useVoiceRoom(desktopShell && !member.isInvite ? member.userId : undefined);
    const voiceChannel = voiceRoomId ? client.getRoom(voiceRoomId)?.name : undefined;
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
            offline={props.offline}
            motion={motion.bind}
            renderBackground={
                rich?.appearance?.nameplate
                    ? (textRef) => (
                          <ProfileNameplate
                              nameplate={rich.appearance!.nameplate!}
                              live={motion.live}
                              textRef={textRef}
                          />
                      )
                    : undefined
            }
            subtitleJsx={
                rich?.status || voiceChannel ? (
                    <div className="mx_MemberTileView_status" title={rich?.status?.text ?? voiceChannel}>
                        {voiceChannel && (
                            <VolumeOnIcon
                                className="mx_MemberTileView_voice"
                                width="14px"
                                height="14px"
                                aria-hidden="true"
                            />
                        )}
                        {rich?.status ? (
                            <>
                                <span aria-hidden="true">{rich.status.emoji}</span> {rich.status.text}
                            </>
                        ) : (
                            _t("member_list|in_voice_channel", { channel: voiceChannel })
                        )}
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
