/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { EventType, type MatrixClient, type Room } from "matrix-js-sdk/src/matrix";
import { KnownMembership } from "matrix-js-sdk/src/types";
import { MatrixRTCSessionEvent } from "matrix-js-sdk/src/matrixrtc";
import { secureRandomString } from "matrix-js-sdk/src/randomstring";
import { logger } from "matrix-js-sdk/src/logger";

import { sortBy } from "lodash";

import { getChildOrder } from "../../stores/spaces/childOrder";

/**
 * The voice channel state event in which a moderator asks someone in the channel's call to go to another voice
 * channel of the same server, as dragging them does in Discord. Its state key is {@link voiceMoveStateKey}, and its
 * content is {@link VoiceMoveContent}.
 *
 * The event type has a power level of its own, so the homeserver refuses it from anyone without the power to move
 * people. Only Aether follows the request: the person's own app leaves the call and joins the other one.
 */
export const VOICE_MOVE_EVENT_TYPE = "io.aether.voice.move";

/** The content of a {@link VOICE_MOVE_EVENT_TYPE} event. */
export interface VoiceMoveContent {
    /** The voice channel to go to. Without one, the person leaves the call, as Discord's "Disconnect" does. */
    to?: string;
    /** Tells one request from another, so that each is followed once. */
    id: string;
}

/**
 * The state key of the request about one person. It must not start with their user ID: the homeserver only takes
 * state keys starting with "@" from that very user.
 */
export function voiceMoveStateKey(userId: string): string {
    return `u:${userId}`;
}

/**
 * Whether someone may move the people in a voice channel's call to another voice channel. The homeserver checks the
 * same power level when the request is sent, and the moved person's app checks it again.
 */
export function mayMoveVoiceMembers(room: Room, userId: string): boolean {
    return room.isCallRoom() && room.currentState.maySendStateEvent(VOICE_MOVE_EVENT_TYPE, userId);
}

/** The servers the user is in that hold `roomId` among their channels, with the servers to join it through. */
function serversHolding(client: MatrixClient, roomId: string): { server: Room; via: string[] }[] {
    const holding: { server: Room; via: string[] }[] = [];
    for (const server of client.getRooms()) {
        if (!server.isSpaceRoom() || server.getMyMembership() !== KnownMembership.Join) continue;
        const via = server.currentState.getStateEvents(EventType.SpaceChild, roomId)?.getContent().via;
        // A child without servers to join it through has been taken out of the server.
        if (Array.isArray(via) && via.length > 0 && via.every((name) => typeof name === "string")) {
            holding.push({ server, via });
        }
    }
    return holding;
}

/**
 * The servers to join a voice channel through when someone is moved there from `fromRoomId`, or undefined when no
 * server the user is in holds both channels. People are only ever moved within one server.
 */
export function voiceMoveDestinationVia(
    client: MatrixClient,
    fromRoomId: string,
    toRoomId: string,
): string[] | undefined {
    const holdingSource = new Set(serversHolding(client, fromRoomId).map(({ server }) => server.roomId));
    return serversHolding(client, toRoomId).find(({ server }) => holdingSource.has(server.roomId))?.via;
}

/**
 * The other voice channels of the servers holding `room` that the user is in, in the servers' own order: the places
 * the people in its call can be moved to.
 */
export function voiceMoveDestinations(client: MatrixClient, room: Room): Room[] {
    const destinations = new Map<string, { room: Room; order: ReturnType<typeof getChildOrder> }>();
    for (const { server } of serversHolding(client, room.roomId)) {
        for (const child of server.currentState.getStateEvents(EventType.SpaceChild)) {
            const roomId = child.getStateKey();
            const content = child.getContent();
            if (!roomId || roomId === room.roomId || destinations.has(roomId) || !Array.isArray(content.via)) continue;
            if (content.via.length === 0) continue;
            const channel = client.getRoom(roomId);
            if (!channel?.isCallRoom() || channel.getMyMembership() !== KnownMembership.Join) continue;
            destinations.set(roomId, { room: channel, order: getChildOrder(content.order, child.getTs(), roomId) });
        }
    }
    // Sorted as the servers sort their children: by `order`, then when they were added, then by room ID.
    const entries = [...destinations.values()];
    return sortBy(entries, [(e) => e.order[0], (e) => e.order[1], (e) => e.order[2]]).map(({ room }) => room);
}

/**
 * Asks someone in `fromRoomId`'s call to go to `toRoomId`.
 *
 * @returns once the homeserver has accepted the request; it rejects it when the sender may not move people.
 */
export async function requestVoiceMove(
    client: MatrixClient,
    fromRoomId: string,
    userId: string,
    toRoomId: string,
): Promise<void> {
    await sendVoiceMove(client, fromRoomId, userId, { to: toRoomId, id: secureRandomString(16) });
}

/**
 * Asks someone in `roomId`'s call to leave it, as Discord's "Disconnect" does: a move to no channel.
 *
 * @returns once the homeserver has accepted the request; it rejects it when the sender may not move people.
 */
export async function requestVoiceDisconnect(client: MatrixClient, roomId: string, userId: string): Promise<void> {
    await sendVoiceMove(client, roomId, userId, { id: secureRandomString(16) });
}

/**
 * The content of the {@link VOICE_MOVE_EVENT_TYPE} to-device message that carries a move through the call's media
 * room: the request, with the voice channel it is about and when it was sent.
 */
export interface FastVoiceMoveContent extends VoiceMoveContent {
    /** The voice channel whose call the person is asked to leave. */
    room_id: string;
    /** When the request was sent, by the sender's clock. */
    ts: number;
}

/**
 * Sends a move request. When the sender is in the call too, the request also goes straight to the person's devices
 * through the call's media room, Olm encrypted, and arrives in a few tens of milliseconds rather than after the
 * homeserver's round trip and the person's next sync. The state event still goes out: it is what the homeserver
 * checks the sender's power against, the record, and the way the request reaches the person in any other case.
 */
async function sendVoiceMove(
    client: MatrixClient,
    roomId: string,
    userId: string,
    content: VoiceMoveContent,
): Promise<void> {
    const room = client.getRoom(roomId);
    if (room) {
        const session = client.matrixRTC.getRoomSession(room);
        const devices = session.memberships
            .filter((membership) => membership.userId === userId)
            .map(({ userId, deviceId }) => ({ userId, deviceId }));
        const fast: FastVoiceMoveContent = { ...content, room_id: roomId, ts: Date.now() };
        session
            .aetherSendSealed(devices, VOICE_MOVE_EVENT_TYPE, { ...fast })
            .catch((error) => logger.warn("Could not send the move through the call's media room", error));
    }
    await client.sendStateEvent(roomId, VOICE_MOVE_EVENT_TYPE, content, voiceMoveStateKey(userId));
}

/**
 * Waits until someone is in a room's call, or no longer is, as the call's memberships show it.
 *
 * @param present - Whether to wait for them to be in the call, or for them to have left it.
 * @param timeoutMs - How long to wait at most.
 * @returns whether it happened in time.
 */
export function waitForCallMember(
    client: MatrixClient,
    room: Room,
    userId: string,
    present: boolean,
    timeoutMs: number,
): Promise<boolean> {
    const session = client.matrixRTC.getRoomSession(room);
    const isThere = (): boolean => session.memberships.some((membership) => membership.userId === userId) === present;
    if (isThere()) return Promise.resolve(true);
    return new Promise((resolve) => {
        const finish = (result: boolean): void => {
            clearTimeout(timer);
            session.off(MatrixRTCSessionEvent.MembershipsChanged, onChanged);
            resolve(result);
        };
        const onChanged = (): void => {
            if (isThere()) finish(true);
        };
        const timer = setTimeout(() => finish(false), timeoutMs);
        session.on(MatrixRTCSessionEvent.MembershipsChanged, onChanged);
    });
}
