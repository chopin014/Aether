/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { KnownMembership } from "matrix-js-sdk/src/types";
import {
    ClientEvent,
    RoomStateEvent,
    type MatrixClient,
    type MatrixEvent,
    type ReceivedToDeviceMessage,
    type Room,
} from "matrix-js-sdk/src/matrix";
import { logger as rootLogger } from "matrix-js-sdk/src/logger";

import {
    type FastVoiceMoveContent,
    mayMoveVoiceMembers,
    VOICE_MOVE_EVENT_TYPE,
    voiceMoveDestinationVia,
    voiceMoveStateKey,
} from "../utils/call/voiceMove";

const logger = rootLogger.getChild("VoiceMoveFollower");

/**
 * How old a move request may be and still be followed. It is meant for whoever is in the call when it is sent; one
 * found later, such as when the app starts again, is stale.
 */
export const VOICE_MOVE_MAX_AGE_MS = 60_000;

/**
 * Follows the moves that moderators ask of this user ({@link VOICE_MOVE_EVENT_TYPE}): when this device is in the call
 * a request is about, it leaves the call and joins the voice channel the request names, as being dragged to another
 * channel does in Discord. A request that names no channel disconnects the user from the call, as Discord's
 * "Disconnect" does.
 *
 * A request arrives as a state event of the call's room, and also, when its sender is in the call too, as an Olm
 * encrypted to-device message through the call's media room, which comes first. Each request is followed once.
 */
export class VoiceMoveFollower {
    private disposed = false;
    /** Requests already followed or turned down, by id, so that seeing one again, either way, does nothing. */
    private readonly seen = new Set<string>();

    /**
     * @param isInCall - Whether this device is in, or joining, the call of a room.
     * @param follow - Leaves this device's calls and joins the call of the given voice channel.
     * @param disconnect - Leaves this device's call in the given voice channel.
     */
    public constructor(
        private readonly client: MatrixClient,
        private readonly isInCall: (roomId: string) => boolean,
        private readonly follow: (room: Room) => void | Promise<void>,
        private readonly disconnect: (room: Room) => void | Promise<void>,
    ) {
        client.on(RoomStateEvent.Events, this.onStateEvent);
        client.on(ClientEvent.ReceivedToDeviceMessage, this.onToDeviceMessage);
    }

    public dispose(): void {
        this.disposed = true;
        this.client.off(RoomStateEvent.Events, this.onStateEvent);
        this.client.off(ClientEvent.ReceivedToDeviceMessage, this.onToDeviceMessage);
    }

    private readonly onStateEvent = (event: MatrixEvent): void => {
        if (event.getType() !== VOICE_MOVE_EVENT_TYPE) return;
        if (event.getStateKey() !== voiceMoveStateKey(this.client.getSafeUserId())) return;
        const roomId = event.getRoomId();
        const sender = event.getSender();
        if (!roomId || !sender) return;
        const { to, id } = event.getContent();
        void this.receive(roomId, sender, to, id, event.getTs(), event.getLocalAge()).catch((error) =>
            logger.warn("Could not follow a move to another channel", error),
        );
    };

    /** A request through the call's media room: only an Olm-encrypted one, whose sender Olm authenticated. */
    private readonly onToDeviceMessage = ({ message, encryptionInfo }: ReceivedToDeviceMessage): void => {
        if (message.type !== VOICE_MOVE_EVENT_TYPE || !encryptionInfo || encryptionInfo.sender !== message.sender)
            return;
        const { room_id: roomId, to, id, ts } = message.content as Partial<FastVoiceMoveContent>;
        if (typeof roomId !== "string" || typeof ts !== "number") return;
        void this.receive(roomId, encryptionInfo.sender, to, id, ts, Math.abs(Date.now() - ts)).catch((error) =>
            logger.warn("Could not follow a move to another channel", error),
        );
    };

    /**
     * @param ts - When the request was sent.
     * @param age - How long ago that was.
     */
    private async receive(
        roomId: string,
        sender: string,
        to: unknown,
        id: unknown,
        ts: number,
        age: number,
    ): Promise<void> {
        const userId = this.client.getSafeUserId();
        if (this.disposed) return;
        // A request without a channel to go to disconnects.
        if ((to !== undefined && typeof to !== "string") || typeof id !== "string") return;
        if (this.seen.has(id)) return;
        this.seen.add(id);
        if (age > VOICE_MOVE_MAX_AGE_MS) return;

        const from = this.client.getRoom(roomId);
        if (!from || to === from.roomId || !this.isInCall(from.roomId)) return;
        // The homeserver only takes the request from someone allowed to move people; check it as well, in case the
        // room's permissions changed since.
        if (!mayMoveVoiceMembers(from, sender)) return;
        // A request sent before this device joined the call was meant for an earlier visit.
        const own = this.client.matrixRTC
            .getRoomSession(from)
            .memberships.find(
                (membership) => membership.userId === userId && membership.deviceId === this.client.getDeviceId(),
            );
        if (own && own.createdTs() > ts) return;

        if (to === undefined) {
            logger.info(`${sender} disconnected us from ${from.roomId}`);
            await this.disconnect(from);
            return;
        }
        const via = voiceMoveDestinationVia(this.client, from.roomId, to);
        if (!via) {
            logger.info(`Not following a move to ${to}: it is not a channel of the same server`);
            return;
        }
        let destination = this.client.getRoom(to);
        if (destination?.getMyMembership() !== KnownMembership.Join) {
            destination = await this.client.joinRoom(to, { viaServers: via });
        }
        if (this.disposed || !destination.isCallRoom() || !this.isInCall(from.roomId)) return;
        logger.info(`${sender} moved us from ${from.roomId} to ${destination.roomId}`);
        await this.follow(destination);
    }
}
