/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { type JSX } from "react";
import { type RoomMember } from "matrix-js-sdk/src/matrix";
import { ProfileDecoration } from "@element-hq/web-shared-components";

import MemberAvatar from "../../avatars/MemberAvatar";
import { useRichRowProfile } from "../../../../profile/useRichProfile";
import { type EventTileSenderSnapshot } from "../../../../viewmodels/room/timeline/event-tile/EventTileViewModel";

const MIN_DECORATED_AVATAR_PX = 24;

/**
 * Props for the {@link EventTileAvatarAdapter} component.
 */
interface EventTileAvatarAdapterProps {
    /** Room member whose avatar is being rendered. */
    avatarMember: RoomMember | null;
    /** Snapshot of the sender identity state for this tile. */
    senderSnapshot: EventTileSenderSnapshot;
}

/**
 * Renders the sender avatar for an event tile.
 */
export function EventTileAvatarAdapter({
    avatarMember,
    senderSnapshot,
}: Readonly<EventTileAvatarAdapterProps>): JSX.Element | null {
    const { avatarSize } = senderSnapshot.profileState;
    const decoration = useRichRowProfile(avatarMember?.userId)?.appearance?.decoration;

    if (!avatarMember || avatarSize === null) {
        return null;
    }

    const avatar = (
        <MemberAvatar
            member={avatarMember}
            size={avatarSize}
            viewUserOnClick={senderSnapshot.viewUserOnClick}
            forceHistorical={senderSnapshot.forceHistoricalAvatar}
        />
    );
    // The tiny avatars beside state events like "Robin joined the room" have no room for a frame.
    return decoration && Number.parseInt(avatarSize, 10) >= MIN_DECORATED_AVATAR_PX ? (
        <span className="mx_EventTileAvatar_decorated">
            {avatar}
            <ProfileDecoration id={decoration} />
        </span>
    ) : (
        avatar
    );
}
