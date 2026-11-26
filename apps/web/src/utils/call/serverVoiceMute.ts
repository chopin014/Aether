/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    ClientEvent,
    EventType,
    RoomEvent,
    RoomStateEvent,
    type MatrixClient,
    type MatrixEvent,
    type Room,
} from "matrix-js-sdk/src/matrix";
import { KnownMembership } from "matrix-js-sdk/src/types";

/**
 * The server (Space) state event in which a moderator mutes or deafens someone in all of the server's voice channels,
 * as Discord's server mute and server deafen do. Its state key is {@link serverVoiceMuteStateKey}, and its content is
 * {@link ServerVoiceMuteContent}; empty content lifts both.
 *
 * The event type has a power level of its own in the server, so the homeserver refuses it from anyone without the
 * power to mute people. Only Aether honours it: the person's own app keeps their microphone off (and their call
 * silent, when deafened), and every other Aether in the call stops playing them.
 */
export const SERVER_VOICE_MUTE_EVENT_TYPE = "io.aether.voice.server_mute";

/** The content of a {@link SERVER_VOICE_MUTE_EVENT_TYPE} event. */
export interface ServerVoiceMuteContent {
    /** Whether the person may not speak in the server's voice channels. */
    muted?: boolean;
    /** Whether the person may not hear the server's voice channels. Being deafened also mutes them. */
    deafened?: boolean;
}

/** Whether someone is muted or deafened by a moderator. */
export interface ServerVoiceMute {
    muted: boolean;
    deafened: boolean;
}

const NOT_MUTED: ServerVoiceMute = { muted: false, deafened: false };

/**
 * The state key of the record about one person. It must not start with their user ID: the homeserver only takes state
 * keys starting with "@" from that very user.
 */
export function serverVoiceMuteStateKey(userId: string): string {
    return `u:${userId}`;
}

/** The servers the user is in that hold `roomId` among their channels. */
function serversHolding(client: MatrixClient, roomId: string): Room[] {
    return client.getRooms().filter((server) => {
        if (!server.isSpaceRoom() || server.getMyMembership() !== KnownMembership.Join) return false;
        const via = server.currentState.getStateEvents(EventType.SpaceChild, roomId)?.getContent().via;
        // A child without servers to join it through has been taken out of the server.
        return Array.isArray(via) && via.length > 0;
    });
}

/** What one server's record says about someone. */
function readRecord(server: Room, userId: string): ServerVoiceMute {
    const content = server.currentState
        .getStateEvents(SERVER_VOICE_MUTE_EVENT_TYPE, serverVoiceMuteStateKey(userId))
        ?.getContent<ServerVoiceMuteContent>();
    const deafened = content?.deafened === true;
    return { muted: deafened || content?.muted === true, deafened };
}

/**
 * Whether a moderator muted or deafened someone in a voice channel's call: any server holding the channel can.
 */
export function getServerVoiceMute(client: MatrixClient, roomId: string, userId: string): ServerVoiceMute {
    let result = NOT_MUTED;
    for (const server of serversHolding(client, roomId)) {
        const record = readRecord(server, userId);
        result = { muted: result.muted || record.muted, deafened: result.deafened || record.deafened };
    }
    return result;
}

/**
 * The server in which `userId` may mute or deafen the people in `roomId`'s call, or undefined when they may not. The
 * homeserver checks the same power level when the record is sent.
 */
export function serverForVoiceMute(client: MatrixClient, roomId: string, userId: string): Room | undefined {
    if (!client.getRoom(roomId)?.isCallRoom()) return undefined;
    return serversHolding(client, roomId).find((server) =>
        server.currentState.maySendStateEvent(SERVER_VOICE_MUTE_EVENT_TYPE, userId),
    );
}

/**
 * Mutes, deafens, unmutes or undeafens someone in every voice channel of the server holding `roomId`. Lifting a mute
 * from someone who is deafened lifts both, as Discord's deafen includes the mute.
 *
 * @returns once the homeserver accepted the change.
 */
export async function setServerVoiceMute(
    client: MatrixClient,
    roomId: string,
    userId: string,
    change: Partial<ServerVoiceMute>,
): Promise<void> {
    const server = serverForVoiceMute(client, roomId, client.getSafeUserId());
    if (!server) throw new Error("Not allowed to mute people in this channel");
    const current = readRecord(server, userId);
    let next: ServerVoiceMute = { ...current, ...change };
    if (change.deafened === true) next = { muted: true, deafened: true };
    if (change.muted === false) next = { muted: false, deafened: false };
    const content: ServerVoiceMuteContent = {};
    if (next.muted) content.muted = true;
    if (next.deafened) content.deafened = true;
    await client.sendStateEvent(server.roomId, SERVER_VOICE_MUTE_EVENT_TYPE, content, serverVoiceMuteStateKey(userId));
}

/** Everyone listening for changes to moderators' mutes, for each client. One client listener serves them all. */
const listeners = new WeakMap<MatrixClient, Set<() => void>>();

/**
 * Calls `listener` whenever a moderator mutes, deafens, unmutes or undeafens someone, a server's channels change, or
 * the user joins or leaves a server, all of which can change who is muted where. A newly joined server's records can
 * arrive before the server counts as joined, so joining is a change too.
 *
 * @returns a function that stops listening.
 */
export function onServerVoiceMutesChanged(client: MatrixClient, listener: () => void): () => void {
    let set = listeners.get(client);
    if (!set) {
        const callbacks = new Set<() => void>();
        set = callbacks;
        listeners.set(client, set);
        const notify = (): void => {
            for (const callback of callbacks) callback();
        };
        client.on(RoomStateEvent.Events, (event: MatrixEvent) => {
            const type = event.getType();
            if (type !== SERVER_VOICE_MUTE_EVENT_TYPE && type !== EventType.SpaceChild) return;
            notify();
        });
        client.on(RoomEvent.MyMembership, (room: Room) => {
            if (room.isSpaceRoom()) notify();
        });
        client.on(ClientEvent.Room, (room: Room) => {
            if (room.isSpaceRoom()) notify();
        });
    }
    set.add(listener);
    return () => set.delete(listener);
}
