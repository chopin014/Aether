/*
Copyright 2025 New Vector Ltd.
SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { RoomMember, type User, UserEvent, ClientEvent } from "matrix-js-sdk/src/matrix";
import { useCallback, useContext, useReducer } from "react";

import { useTypedEventEmitter } from "../../../../hooks/useEventEmitter";
import { getKnownPresence } from "../../../../utils/knownPresence";
import { mediaFromMxc } from "../../../../customisations/Media";
import Modal from "../../../../Modal";
import ImageView from "../../../views/elements/ImageView";
import SdkConfig from "../../../../SdkConfig";
import MatrixClientContext from "../../../../contexts/MatrixClientContext";
import { type Member } from "../../../views/right_panel/UserInfo";
import { useUserTimezone } from "../../../../hooks/useUserTimezone";

export interface PresenceInfo {
    lastActiveAgo: number | undefined;
    currentlyActive: boolean | undefined;
    state: string | undefined;
}

export interface TimezoneInfo {
    timezone: string;
    friendly: string;
}

export interface UserInfoHeaderState {
    /**
     * callback function when selected user avatar is clicked in user info
     */
    onMemberAvatarClick: () => void;
    /**
     * Object containing information about the precense of the selected user
     */
    precenseInfo: PresenceInfo;
    /**
     * Boolean that show or hide the precense information
     */
    showPresence: boolean;
    /**
     *  Timezone object
     */
    timezoneInfo: TimezoneInfo | null;
    /**
     * Displayed identifier for the selected user
     */
    userIdentifier: string | null;
}
interface UserInfoHeaderViewModelProps {
    member: Member;
    roomId?: string;
}

/**
 * View model for the userInfoHeaderView
 * props
 * @see {@link UserInfoHeaderState} for more information about what this view model returns.
 */
export function useUserfoHeaderViewModel({ member, roomId }: UserInfoHeaderViewModelProps): UserInfoHeaderState {
    const cli = useContext(MatrixClientContext);

    const [, refreshPresence] = useReducer((value: number) => value + 1, 0);
    const user = member instanceof RoomMember ? (member.user ?? cli.getUser(member.userId)) : member;
    useTypedEventEmitter(user ?? undefined, UserEvent.LastPresenceTs, refreshPresence);
    useTypedEventEmitter(cli, UserEvent.LastPresenceTs, (_event, updatedUser) => {
        if (updatedUser.userId === member.userId) refreshPresence();
    });
    useTypedEventEmitter(cli, ClientEvent.Event, (event) => {
        if (event.getType() === "m.presence" && event.getSender() === member.userId) refreshPresence();
    });
    let showPresence = true;

    const precenseInfo: PresenceInfo = {
        lastActiveAgo: undefined,
        currentlyActive: undefined,
        state: undefined,
    };

    const enablePresenceByHsUrl = SdkConfig.get("enable_presence_by_hs_url");

    const timezoneInfo = useUserTimezone(cli, member.userId);

    const userIdentifier = member.userId;

    const onMemberAvatarClick = useCallback(() => {
        const avatarUrl = (member as RoomMember).getMxcAvatarUrl
            ? (member as RoomMember).getMxcAvatarUrl()
            : (member as User).avatarUrl;

        const httpUrl = mediaFromMxc(avatarUrl).srcHttp;
        if (!httpUrl) return;

        const params = {
            src: httpUrl,
            name: (member as RoomMember).name || (member as User).displayName,
        };

        Modal.createDialog(ImageView, params, "mx_Dialog_lightbox", undefined, true);
    }, [member]);

    if (getKnownPresence(user)) {
        precenseInfo.state = getKnownPresence(user);
        precenseInfo.lastActiveAgo = user?.lastActiveAgo;
        precenseInfo.currentlyActive = user?.currentlyActive;
    }

    if (enablePresenceByHsUrl && enablePresenceByHsUrl[cli.baseUrl] !== undefined) {
        showPresence = enablePresenceByHsUrl[cli.baseUrl];
    }

    return {
        onMemberAvatarClick,
        showPresence,
        precenseInfo,
        timezoneInfo,
        userIdentifier,
    };
}
