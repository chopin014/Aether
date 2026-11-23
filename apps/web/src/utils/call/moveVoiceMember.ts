/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type MatrixClient, type Room } from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";

import defaultDispatcher from "../../dispatcher/dispatcher";
import { Action } from "../../dispatcher/actions";
import { type FollowVoiceMovePayload } from "../../dispatcher/payloads/FollowVoiceMovePayload";
import Modal from "../../Modal";
import ErrorDialog from "../../components/views/dialogs/ErrorDialog";
import QuestionDialog from "../../components/views/dialogs/QuestionDialog";
import { CallStore } from "../../stores/CallStore";
import { _t } from "../../languageHandler";
import {
    mayMoveVoiceMembers,
    requestVoiceDisconnect,
    requestVoiceMove,
    voiceMoveDestinations,
    waitForCallMember,
} from "./voiceMove";

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

/** Whether `userId` may remove `targetId` from a room, as Matrix allows: with the kick level and above them. */
function mayKick(room: Room, userId: string, targetId: string): boolean {
    const level = room.getMember(userId)?.powerLevel ?? 0;
    const targetLevel = room.getMember(targetId)?.powerLevel ?? 0;
    return room.currentState.hasSufficientPowerLevelFor("kick", level) && level > targetLevel;
}

/**
 * Disconnects someone from a voice channel's call, as Discord's "Disconnect" does. The user must be allowed to move
 * people in the channel. The user's own call is left here; anyone else's app is asked to leave. When it does not,
 * someone who may also remove people from the channel is offered that instead: it ends the person's call on any app,
 * and they can join the channel again.
 */
export async function disconnectVoiceMember(client: MatrixClient, roomId: string, userId: string): Promise<void> {
    const me = client.getSafeUserId();
    const room = client.getRoom(roomId);
    if (!room || !mayMoveVoiceMembers(room, me)) return;
    if (!client.matrixRTC.getRoomSession(room).memberships.some((membership) => membership.userId === userId)) return;

    if (userId === me) {
        await CallStore.instance.getCall(roomId)?.disconnect();
        return;
    }

    const name = room.getMember(userId)?.name ?? userId;
    try {
        await requestVoiceDisconnect(client, roomId, userId);
    } catch (error) {
        logger.warn(`Could not disconnect ${userId} from ${roomId}`, error);
        Modal.createDialog(ErrorDialog, {
            title: _t("desktop|voice_move|disconnect_failed_title", { name }),
            description: error instanceof Error ? error.message : String(error),
        });
        return;
    }
    if (await waitForCallMember(client, room, userId, false, VOICE_MOVE_FOLLOW_TIMEOUT_MS)) return;

    if (!mayKick(room, me, userId)) {
        Modal.createDialog(ErrorDialog, {
            title: _t("desktop|voice_move|disconnect_failed_title", { name }),
            description: _t("desktop|voice_move|not_disconnected", { name }),
        });
        return;
    }
    const { finished } = Modal.createDialog(QuestionDialog, {
        title: _t("desktop|voice_move|remove_title", { name }),
        description: _t("desktop|voice_move|remove_description", { name }),
        button: _t("desktop|voice_move|remove_button"),
        danger: true,
    });
    const [confirmed] = await finished;
    if (!confirmed) return;
    try {
        await client.kick(roomId, userId);
    } catch (error) {
        logger.warn(`Could not remove ${userId} from ${roomId}`, error);
        Modal.createDialog(ErrorDialog, {
            title: _t("desktop|voice_move|disconnect_failed_title", { name }),
            description: error instanceof Error ? error.message : String(error),
        });
    }
}
