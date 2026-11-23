/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type ActionPayload } from "../payloads";
import { type Action } from "../actions";

/** Leave the user's calls and join the call of a voice channel a moderator moved them to. */
export interface FollowVoiceMovePayload extends ActionPayload {
    action: Action.FollowVoiceMove;

    /** The voice channel the user was moved to. The user has joined it. */
    room_id: string;
}
