/*
Copyright 2024 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { type PresenceState } from "./PresenceState";
import { type PresenceSource } from "../../presence/mergedPresence";

export type RoomMember = {
    roomId: string;
    userId: string;
    displayUserId: string;
    name: string;
    rawDisplayName?: string;
    disambiguate: boolean;
    avatarThumbnailUrl?: string;
    powerLevel: number;
    lastModifiedTime: number;
    presenceState?: PresenceState;
    /** Where `presenceState` came from. Unset means the homeserver. */
    presenceSource?: PresenceSource;
    /** Tooltip wording for `presenceState` when the standard name would overstate what is known. */
    presenceLabel?: string;
    isInvite: boolean;
};
