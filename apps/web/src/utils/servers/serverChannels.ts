/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { sortBy } from "lodash";
import { logger } from "matrix-js-sdk/src/logger";
import {
    type HierarchyRoom,
    KnownMembership,
    type MatrixClient,
    MatrixError,
    RoomType,
} from "matrix-js-sdk/src/matrix";

import { getChildOrder } from "../../stores/spaces/childOrder";

/** A channel of a server that the user has not joined yet. */
export interface ServerChannel {
    roomId: string;
    name: string;
    kind: "text" | "voice";
    topic?: string;
    memberCount: number;
    /** Whether the server's admins suggest this channel to newcomers. */
    suggested: boolean;
    /** Servers that can be asked to join the channel through. */
    via: string[];
    /** The mxc:// URL of the channel's icon, if it has one. */
    avatarUrl?: string;
    /** The Matrix room type, such as a call room's. */
    roomType?: string;
    /** When the channel was added to the server. */
    addedAt?: number;
}

/** Stop after this many hierarchy pages; channels past them can still be joined from the server's overview. */
const MAX_PAGES = 5;
const PAGE_SIZE = 50;

/** The join rule fields a hierarchy entry carries; the SDK types only list some of them. */
type HierarchyEntry = Omit<HierarchyRoom, "join_rule"> & { join_rule?: string; allowed_room_ids?: string[] };

/** Whether the user can join a channel without an invite. */
function isJoinable(entry: HierarchyEntry, spaceId: string): boolean {
    switch (entry.join_rule) {
        case undefined:
        case "public":
            return true;
        case "restricted":
        case "knock_restricted":
            // Older servers leave out who is allowed; trying the join is then the only way to find out.
            return !entry.allowed_room_ids || entry.allowed_room_ids.includes(spaceId);
        default:
            return false;
    }
}

/**
 * List the channels directly inside a server that the user could join but has not, in the server's own order.
 * Nested servers are left out: they are joined on their own.
 */
export async function listJoinableChannels(client: MatrixClient, spaceId: string): Promise<ServerChannel[]> {
    const entries = new Map<string, HierarchyEntry>();
    let from: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
        const response = await client.getRoomHierarchy(spaceId, PAGE_SIZE, 1, false, from);
        for (const room of response.rooms) entries.set(room.room_id, room);
        from = response.next_batch;
        if (!from) break;
    }

    const root = entries.get(spaceId);
    if (!root) return [];
    const children = sortBy(root.children_state, (event) =>
        getChildOrder(event.content.order, event.origin_server_ts, event.state_key),
    );

    const channels: ServerChannel[] = [];
    for (const child of children) {
        const entry = entries.get(child.state_key);
        if (!entry || entry.room_type === RoomType.Space || !isJoinable(entry, spaceId)) continue;
        if (client.getRoom(entry.room_id)?.getMyMembership() === KnownMembership.Join) continue;
        const isVoice = entry.room_type === RoomType.UnstableCall || entry.room_type === RoomType.ElementVideo;
        channels.push({
            roomId: entry.room_id,
            name: entry.name || entry.canonical_alias || entry.room_id,
            kind: isVoice ? "voice" : "text",
            topic: entry.topic,
            memberCount: entry.num_joined_members,
            suggested: !!child.content.suggested,
            via: Array.isArray(child.content.via) ? child.content.via : [],
            avatarUrl: entry.avatar_url,
            roomType: entry.room_type,
            addedAt: child.origin_server_ts,
        });
    }
    return channels;
}

/** How long to wait when the homeserver refuses a join for coming too soon but doesn't say how long. */
const DEFAULT_RATE_LIMIT_WAIT_MS = 5_000;

/**
 * Holds joins back while the homeserver refuses them for coming too quickly. Synapse lets a user join 10 rooms at
 * once by default, then one every 10 seconds, so a join past that has to wait rather than fail.
 */
export class JoinRateLimit {
    private resumeAt = 0;

    /** Whether the homeserver is still refusing joins for now. */
    public get holding(): boolean {
        return this.resumeAt > Date.now();
    }

    /** Wait until the homeserver accepts joins again. */
    public async wait(): Promise<void> {
        for (let delay = this.resumeAt - Date.now(); delay > 0; delay = this.resumeAt - Date.now()) {
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
    }

    /** Whether a join failed only for coming too soon; later joins then wait for the time the homeserver asked. */
    public hold(error: unknown): boolean {
        if (!(error instanceof MatrixError) || error.httpStatus !== 429) return false;
        const wait = error.getRetryAfterMs() ?? DEFAULT_RATE_LIMIT_WAIT_MS;
        this.resumeAt = Math.max(this.resumeAt, Date.now() + wait);
        return true;
    }
}

/** Shared by every join of channels, as the homeserver counts them all against the same allowance. */
export const joinRateLimit = new JoinRateLimit();

/** How joining a set of channels went. */
export interface JoinChannelsResult {
    joined: string[];
    failed: ServerChannel[];
}

export interface JoinChannelsOptions {
    /** Joins sent at once. */
    concurrency?: number;
    /** Called once, when the homeserver first makes the rest of the joins wait. */
    onRateLimited?: () => void;
}

/**
 * Join channels a few at a time so a large selection does not flood the homeserver. A join refused for coming too
 * soon waits and tries again, so a large selection takes a while but every channel still gets joined.
 */
export async function joinChannels(
    client: MatrixClient,
    channels: ServerChannel[],
    { concurrency = 4, onRateLimited }: JoinChannelsOptions = {},
): Promise<JoinChannelsResult> {
    const result: JoinChannelsResult = { joined: [], failed: [] };
    const queue = [...channels];
    let rateLimited = false;
    const worker = async (): Promise<void> => {
        for (let channel = queue.shift(); channel; channel = queue.shift()) {
            await joinRateLimit.wait();
            try {
                await client.joinRoom(channel.roomId, { viaServers: channel.via });
                result.joined.push(channel.roomId);
            } catch (error) {
                if (joinRateLimit.hold(error)) {
                    // Put it back first in line, so channels still join in the server's order.
                    queue.unshift(channel);
                    if (!rateLimited) onRateLimited?.();
                    rateLimited = true;
                    continue;
                }
                logger.warn(`Could not join channel ${channel.roomId}`, error);
                result.failed.push(channel);
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, channels.length) }, worker));
    // Keep the server's order rather than the order the joins finished in.
    const order = new Map(channels.map((channel, index) => [channel.roomId, index]));
    result.joined.sort((a, b) => order.get(a)! - order.get(b)!);
    return result;
}

/**
 * Join channels and report how it went, or report nothing once the homeserver starts holding the joins back: each
 * then waits several seconds, so the caller moves on while the rest are joined in the background.
 */
export async function joinChannelsUntilHeldBack(
    client: MatrixClient,
    channels: ServerChannel[],
    join: typeof joinChannels = joinChannels,
): Promise<JoinChannelsResult | undefined> {
    const { promise: heldBack, resolve: onRateLimited } = Promise.withResolvers<undefined>();
    return Promise.race([join(client, channels, { onRateLimited: () => onRateLimited(undefined) }), heldBack]);
}
