/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { EventType, type MatrixClient, type Room } from "matrix-js-sdk/src/matrix";
import { KnownMembership } from "matrix-js-sdk/src/types";

/**
 * The server (Space) state event in which a moderator gives someone a nickname in the server, as Discord's "Change
 * Nickname" does for others. Its state key is {@link memberNickStateKey} and its content {@link MemberNickContent};
 * empty content resets it.
 *
 * Matrix only lets people change their own name in a room, so the person's own Aether carries the nickname out: it
 * writes it into their membership in every room of the server, where every app shows it.
 */
export const MEMBER_NICK_EVENT_TYPE = "io.aether.member.nick";

/** The content of a {@link MEMBER_NICK_EVENT_TYPE} event. */
export interface MemberNickContent {
    /** The nickname the moderator gave. Absent or empty: none. */
    nick?: string;
}

/**
 * The account data in which the user keeps the nicknames they chose for themselves in each server, and the names their
 * Aether last wrote into each server, so that a nickname that ends is replaced by their own name again.
 */
export const SERVER_NICKNAMES_EVENT_TYPE = "io.aether.server_nicknames";

/** The content of the {@link SERVER_NICKNAMES_EVENT_TYPE} account data, both keyed by the server's room ID. */
export interface ServerNicknamesContent {
    /** The nicknames the user chose. */
    own?: Record<string, string>;
    /** The names Aether wrote into the server's rooms. */
    shown?: Record<string, string>;
}

/** The longest nickname, as in Discord. */
export const NICKNAME_MAX_LENGTH = 32;

/**
 * The state key of the moderator's nickname for one person. It must not start with their user ID: the homeserver only
 * takes state keys starting with "@" from that very user.
 */
export function memberNickStateKey(userId: string): string {
    return `u:${userId}`;
}

/** The server a room belongs to: the room itself when it is a server, or the first server the user is in holding it. */
export function serverOfRoom(client: MatrixClient, room: Room): Room | undefined {
    if (room.isSpaceRoom()) return room.getMyMembership() === KnownMembership.Join ? room : undefined;
    return client.getRooms().find((server) => {
        if (!server.isSpaceRoom() || server.getMyMembership() !== KnownMembership.Join) return false;
        const via = server.currentState.getStateEvents(EventType.SpaceChild, room.roomId)?.getContent().via;
        return Array.isArray(via) && via.length > 0;
    });
}

/** The rooms of a server the user is in: the server itself and its channels. */
export function roomsOfServer(client: MatrixClient, server: Room): Room[] {
    const channels = server.currentState
        .getStateEvents(EventType.SpaceChild)
        .filter((child) => {
            const via = child.getContent().via;
            return Array.isArray(via) && via.length > 0;
        })
        .map((child) => client.getRoom(child.getStateKey()))
        .filter((room): room is Room => room?.getMyMembership() === KnownMembership.Join && !room.isSpaceRoom());
    return [server, ...channels];
}

function levelOf(server: Room, userId: string): number {
    return server.getMember(userId)?.powerLevel ?? 0;
}

/**
 * Whether `userId` may change `targetId`'s nickname in a server. Anyone may change their own. Changing someone else's
 * takes the server's power level for {@link MEMBER_NICK_EVENT_TYPE}, which the homeserver checks too, and a level above
 * theirs, as Discord only lets people manage nicknames below their highest role.
 */
export function mayChangeNickname(server: Room, userId: string, targetId: string): boolean {
    if (userId === targetId) return true;
    return (
        server.currentState.maySendStateEvent(MEMBER_NICK_EVENT_TYPE, userId) &&
        levelOf(server, userId) > levelOf(server, targetId)
    );
}

/**
 * The nickname a moderator gave someone in a server, or undefined. A record from someone who has since lost the power to
 * give it, or who is not above the person, is ignored.
 */
export function moderatorNickname(server: Room, userId: string): string | undefined {
    const event = server.currentState.getStateEvents(MEMBER_NICK_EVENT_TYPE, memberNickStateKey(userId));
    const nick = event?.getContent<MemberNickContent>().nick;
    const sender = event?.getSender();
    if (typeof nick !== "string" || !nick.trim() || !sender || sender === userId) return undefined;
    return mayChangeNickname(server, sender, userId) ? nick.trim().slice(0, NICKNAME_MAX_LENGTH) : undefined;
}

/** What the user keeps in {@link SERVER_NICKNAMES_EVENT_TYPE}, read defensively. */
export function readServerNicknames(client: MatrixClient): Required<ServerNicknamesContent> {
    const content = client.getAccountData(SERVER_NICKNAMES_EVENT_TYPE)?.getContent<ServerNicknamesContent>();
    const strings = (value: unknown): Record<string, string> =>
        value && typeof value === "object"
            ? Object.fromEntries(
                  Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
              )
            : {};
    return { own: strings(content?.own), shown: strings(content?.shown) };
}

/** Changes the user's account data, keeping whatever else it holds. */
export async function updateServerNicknames(
    client: MatrixClient,
    change: (content: Required<ServerNicknamesContent>) => void,
): Promise<void> {
    const content = readServerNicknames(client);
    change(content);
    await client.setAccountData(SERVER_NICKNAMES_EVENT_TYPE, content);
}

/**
 * The nickname the user should have in a server: the one a moderator gave them, or else the one they chose, or
 * undefined for their own name.
 */
export function desiredNickname(client: MatrixClient, server: Room): string | undefined {
    const me = client.getSafeUserId();
    return moderatorNickname(server, me) ?? readServerNicknames(client).own[server.roomId];
}

/**
 * Gives someone a nickname in a server, or resets it with an empty one. The user's own is kept in their account data,
 * which their Aether carries out; anyone else's is the moderator's record in the server.
 */
export async function setNickname(client: MatrixClient, server: Room, userId: string, nickname: string): Promise<void> {
    const nick = nickname.trim().slice(0, NICKNAME_MAX_LENGTH);
    if (userId === client.getSafeUserId()) {
        await updateServerNicknames(client, ({ own }) => {
            if (nick) own[server.roomId] = nick;
            else delete own[server.roomId];
        });
        return;
    }
    const content: MemberNickContent = nick ? { nick } : {};
    await client.sendStateEvent(server.roomId, MEMBER_NICK_EVENT_TYPE, content, memberNickStateKey(userId));
}

/** The nickname shown for someone in a server's dialog: the moderator's, or the user's own for themselves. */
export function currentNickname(client: MatrixClient, server: Room, userId: string): string {
    if (userId === client.getSafeUserId()) return desiredNickname(client, server) ?? "";
    return moderatorNickname(server, userId) ?? "";
}
