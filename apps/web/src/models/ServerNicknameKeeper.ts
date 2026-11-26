/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    ClientEvent,
    EventType,
    MatrixError,
    RoomEvent,
    RoomStateEvent,
    type MatrixClient,
    type MatrixEvent,
    type Room,
} from "matrix-js-sdk/src/matrix";
import { KnownMembership, type RoomMemberEventContent } from "matrix-js-sdk/src/types";
import { logger as rootLogger } from "matrix-js-sdk/src/logger";

import {
    desiredNickname,
    MEMBER_NICK_EVENT_TYPE,
    readServerNicknames,
    roomsOfServer,
    serverOfRoom,
    SERVER_NICKNAMES_EVENT_TYPE,
    updateServerNicknames,
} from "../utils/serverNickname";

const logger = rootLogger.getChild("ServerNicknameKeeper");

/** How long to let changes settle before writing names, so that a burst of sync updates writes once. */
export const SERVER_NICKNAME_SETTLE_MS = 500;

/** How many times to wait and try again when the homeserver says the user is sending too fast. */
const RATE_LIMIT_RETRIES = 3;

/**
 * Keeps the user's name in each server's rooms as their server nickname, as Discord's per-server nicknames are: the one
 * a moderator gave them, or else the one they chose. Matrix shows the name in each room's membership, so this writes it
 * there, in the server itself and every channel the user is in, where every app shows it. It writes it again when the
 * homeserver replaces it (changing the user's global name does), and when they join another channel.
 *
 * When a nickname ends, the rooms still showing it get the user's own name back.
 */
export class ServerNicknameKeeper {
    private static internalInstance?: ServerNicknameKeeper;

    public static get instance(): ServerNicknameKeeper {
        ServerNicknameKeeper.internalInstance ??= new ServerNicknameKeeper();
        return ServerNicknameKeeper.internalInstance;
    }

    private client?: MatrixClient;
    private timer?: number;
    /** The servers waiting to be brought up to date. */
    private readonly pending = new Set<string>();
    /** The update running now, so that only one writes at a time. */
    private running: Promise<void> = Promise.resolve();

    public start(client: MatrixClient): void {
        this.stop();
        this.client = client;
        client.on(RoomStateEvent.Events, this.onStateEvent);
        client.on(ClientEvent.AccountData, this.onAccountData);
        client.on(ClientEvent.Room, this.onServerChanged);
        client.on(RoomEvent.MyMembership, this.onServerChanged);
        this.scheduleAll();
    }

    public stop(): void {
        this.client?.off(RoomStateEvent.Events, this.onStateEvent);
        this.client?.off(ClientEvent.AccountData, this.onAccountData);
        this.client?.off(ClientEvent.Room, this.onServerChanged);
        this.client?.off(RoomEvent.MyMembership, this.onServerChanged);
        this.client = undefined;
        window.clearTimeout(this.timer);
        this.pending.clear();
    }

    private readonly onStateEvent = (event: MatrixEvent): void => {
        const client = this.client;
        const room = client?.getRoom(event.getRoomId());
        if (!client || !room) return;
        const type = event.getType();
        if (type === MEMBER_NICK_EVENT_TYPE || type === EventType.SpaceChild || type === EventType.RoomPowerLevels) {
            this.schedule(room.roomId);
            if (!room.isSpaceRoom()) this.scheduleServerOf(room);
        } else if (type === EventType.RoomMember && event.getStateKey() === client.getSafeUserId()) {
            // The homeserver replaced the name, or the user joined another of the server's channels.
            this.scheduleServerOf(room);
        }
    };

    /**
     * A server was added or joined. Its records can arrive before the room is stored, when there was no room yet to
     * schedule them for.
     */
    private readonly onServerChanged = (room: Room): void => {
        if (room.isSpaceRoom()) this.schedule(room.roomId);
    };

    private readonly onAccountData = (event: MatrixEvent): void => {
        if (event.getType() === SERVER_NICKNAMES_EVENT_TYPE) this.scheduleAll();
    };

    private scheduleServerOf(room: Room): void {
        const server = this.client && serverOfRoom(this.client, room);
        if (server) this.schedule(server.roomId);
    }

    private scheduleAll(): void {
        const client = this.client;
        if (!client) return;
        for (const room of client.getRooms()) {
            if (room.isSpaceRoom() && room.getMyMembership() === KnownMembership.Join) this.schedule(room.roomId);
        }
        // A server the user left may still have a name to forget.
        for (const serverId of Object.keys(readServerNicknames(client).shown)) this.schedule(serverId);
    }

    private schedule(serverId: string): void {
        this.pending.add(serverId);
        window.clearTimeout(this.timer);
        this.timer = window.setTimeout(this.flush, SERVER_NICKNAME_SETTLE_MS);
    }

    private readonly flush = (): void => {
        const serverIds = [...this.pending];
        this.pending.clear();
        this.running = this.running
            .then(async () => {
                for (const serverId of serverIds) await this.update(serverId);
            })
            .catch((error) => logger.warn("Could not keep server nicknames", error));
    };

    /** Waits for the names being written now; for tests. */
    public settled(): Promise<void> {
        return this.running;
    }

    /** Writes the name the user should have in one server into its rooms. */
    private async update(serverId: string): Promise<void> {
        const client = this.client;
        if (!client) return;
        const server = client.getRoom(serverId);
        const joined = !!server?.isSpaceRoom() && server.getMyMembership() === KnownMembership.Join;
        const wanted = joined && server ? desiredNickname(client, server) : undefined;
        const shown = readServerNicknames(client).shown[serverId];

        if (wanted !== undefined && server) {
            for (const room of roomsOfServer(client, server)) await this.writeName(room, wanted);
        } else if (shown !== undefined && server && joined) {
            // The nickname ended: rooms still showing it get the user's own name back.
            const own = (await client.getProfileInfo(client.getSafeUserId()).catch(() => undefined))?.displayname;
            for (const room of roomsOfServer(client, server)) {
                if (room.getMember(client.getSafeUserId())?.rawDisplayName === shown) {
                    await this.writeName(room, own ?? client.getSafeUserId());
                }
            }
        }

        if (wanted !== shown && this.client === client) {
            await updateServerNicknames(client, (content) => {
                if (wanted === undefined) delete content.shown[serverId];
                else content.shown[serverId] = wanted;
            });
        }
    }

    /** Sets the user's name in one room, unless it is already that. */
    private async writeName(room: Room, name: string): Promise<void> {
        const client = this.client;
        if (!client) return;
        const me = client.getSafeUserId();
        const content = room.currentState
            .getStateEvents(EventType.RoomMember, me)
            ?.getContent<RoomMemberEventContent>();
        if (content?.membership !== KnownMembership.Join || content.displayname === name) return;
        for (let attempt = 0; ; attempt++) {
            try {
                await client.sendStateEvent(room.roomId, EventType.RoomMember, { ...content, displayname: name }, me);
                return;
            } catch (error) {
                if (!(error instanceof MatrixError) || !error.isRateLimitError() || attempt >= RATE_LIMIT_RETRIES) {
                    logger.warn(`Could not set the nickname in ${room.roomId}`, error);
                    return;
                }
                await new Promise((resolve) => window.setTimeout(resolve, error.getRetryAfterMs() ?? 1000));
            }
        }
    }
}
