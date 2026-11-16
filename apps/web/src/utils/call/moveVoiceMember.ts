/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type MatrixClient } from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";

import defaultDispatcher from "../../dispatcher/dispatcher";
import { Action } from "../../dispatcher/actions";
import { type FollowVoiceMovePayload } from "../../dispatcher/payloads/FollowVoiceMovePayload";
import Modal from "../../Modal";
import ErrorDialog from "../../components/views/dialogs/ErrorDialog";
import { _t } from "../../languageHandler";
import { mayMoveVoiceMembers, requestVoiceMove, voiceMoveDestinations, waitForCallMember } from "./voiceMove";

/**
 * How long the moved person's app has to join the other channel's call before the user is told it did not. Joining a
 * call takes a few seconds; this leaves room for a slow connection.
 */
export const VOICE_MOVE_FOLLOW_TIMEOUT_MS = 20_000;

/**
 * Moves someone in a voice channel's call to another voice channel of the same server, as dragging them there does in
 * Discord. The user must be allowed to move people in the channel. The user's own move happens here; anyone else's
 * app is asked to move, and the user is told when it does not.
 */
export async function moveVoiceMember(
    client: MatrixClient,
    fromRoomId: string,
    userId: string,
    toRoomId: string,
): Promise<void> {
    const me = client.getSafeUserId();
    const from = client.getRoom(fromRoomId);
    const to = client.getRoom(toRoomId);
    if (!from || !to || fromRoomId === toRoomId || !mayMoveVoiceMembers(from, me)) return;
    if (!voiceMoveDestinations(client, from).some((room) => room.roomId === toRoomId)) return;
    if (!client.matrixRTC.getRoomSession(from).memberships.some((membership) => membership.userId === userId)) return;

    if (userId === me) {
        defaultDispatcher.dispatch<FollowVoiceMovePayload>({ action: Action.FollowVoiceMove, room_id: toRoomId });
        return;
    }

    const name = from.getMember(userId)?.name ?? userId;
    try {
        await requestVoiceMove(client, fromRoomId, userId, toRoomId);
    } catch (error) {
        logger.warn(`Could not move ${userId} to ${toRoomId}`, error);
        Modal.createDialog(ErrorDialog, {
            title: _t("desktop|voice_move|failed_title", { name }),
            description: error instanceof Error ? error.message : String(error),
        });
        return;
    }
    if (!(await waitForCallMember(client, to, userId, true, VOICE_MOVE_FOLLOW_TIMEOUT_MS))) {
        Modal.createDialog(ErrorDialog, {
            title: _t("desktop|voice_move|failed_title", { name }),
            description: _t("desktop|voice_move|not_followed", { name }),
        });
    }
}
