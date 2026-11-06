/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { sortBy } from "lodash";
import { logger } from "matrix-js-sdk/src/logger";
import { type HierarchyRoom, KnownMembership, type MatrixClient, RoomType } from "matrix-js-sdk/src/matrix";

import { getChildOrder } from "../../stores/spaces/SpaceStore";

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
        });
    }
    return channels;
}

/** How joining a set of channels went. */
export interface JoinChannelsResult {
    joined: string[];
    failed: ServerChannel[];
}

/** Join channels a few at a time so a large selection does not flood the homeserver. */
export async function joinChannels(
    client: MatrixClient,
    channels: ServerChannel[],
    concurrency = 4,
): Promise<JoinChannelsResult> {
    const result: JoinChannelsResult = { joined: [], failed: [] };
    const queue = [...channels];
    const worker = async (): Promise<void> => {
        for (let channel = queue.shift(); channel; channel = queue.shift()) {
            try {
                await client.joinRoom(channel.roomId, { viaServers: channel.via });
                result.joined.push(channel.roomId);
            } catch (error) {
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
