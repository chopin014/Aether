/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    EventType,
    KnownMembership,
    type MatrixClient,
    MatrixEvent,
    PendingEventOrdering,
    Room,
    RoomType,
} from "matrix-js-sdk/src/matrix";

import SettingsStore from "../../settings/SettingsStore";
import { SettingLevel } from "../../settings/SettingLevel";
import { EMPTY_LAYOUT_READER, getLayoutChildren, projectLayout } from "../../stores/space-layout/SpaceLayout";
import { SpaceLayoutStore } from "../../stores/space-layout/SpaceLayoutStore";
import { type ServerChannel } from "../../utils/servers/serverChannels";
import { type ServerFolder } from "./ServerFolderItemViewModel";

/** What the open server's list needs to know about the servers nested in it. */
export interface ServerFolderSource {
    client: MatrixClient;
    /** Whether a room is in a server, counting the rooms of the servers nested in it. */
    isRoomInSpace: (spaceId: string, roomId: string) => boolean;
    /** The channels of a server the user was not in when last looked up. Asking may look them up. */
    getChannels: (spaceId: string) => ServerChannel[];
    /** The servers nested in a server that the user was not in when last looked up. Asking may look them up. */
    getSubservers: (spaceId: string) => ServerChannel[];
    /** Whether a folder of the open server shows its channels. */
    isExpanded: (folderId: string) => boolean;
}

/** A server nested in the open one, drawn as a folder, and what it holds. */
export interface FolderPlan {
    folder: ServerFolder;
    /** The servers to join through, for a server the user is not in yet. */
    via: string[];
    /** Whether the user is in the nested server. */
    joined: boolean;
    /** The server's own room, or an empty one standing in for it, placed by the open server's layout. */
    room: Room;
    /** Whether its channels can show beneath it: only for servers directly in the open one. */
    canExpand: boolean;
    /**
     * What shows beneath the folder, in its server's order: its channels, joined or not, and the servers nested in
     * it, which only open on their own. Empty while the folder is closed and for a folder nested deeper.
     */
    contents: Room[];
    /** The rooms the user is in anywhere inside the server, whose news the folder shows. */
    joinedRooms: Room[];
}

/** How the open server's channel list arranges the servers nested in it. */
export interface FolderLayout {
    /** The folders directly in the open server, in no particular order; its layout places them. */
    folders: FolderPlan[];
    /** Every folder drawn, those nested inside others included, by room id. */
    byId: Map<string, FolderPlan>;
    /** The rooms that only show inside folders, left out of the open server's own list. */
    insideFolders: Set<string>;
    /**
     * The channels inside folders that the user is not in, by room id, with the server to join before them when the
     * user is not in that server either.
     */
    unjoined: Map<string, { channel: ServerChannel; room: Room; serverToJoin?: { roomId: string; via: string[] } }>;
}

/** The setting tag a folder's open or closed state is kept under. */
function folderTag(folderId: string): string {
    return `desktop.folder.${folderId}`;
}

/** Whether a folder of a server shows its channels. Folders start closed. */
export function isFolderExpanded(spaceId: string, folderId: string): boolean {
    return SettingsStore.getValue("RoomList.SectionExpansionState")[spaceId]?.[folderTag(folderId)] ?? false;
}

/** Remember on this device whether a folder of a server shows its channels. */
export async function setFolderExpanded(spaceId: string, folderId: string, expanded: boolean): Promise<void> {
    const state = SettingsStore.getValue("RoomList.SectionExpansionState");
    await SettingsStore.setValue("RoomList.SectionExpansionState", null, SettingLevel.DEVICE, {
        ...state,
        [spaceId]: { ...state[spaceId], [folderTag(folderId)]: expanded },
    });
}

/**
 * An empty room standing in for a channel or server the user is not in, so a server's layout can place it. Its
 * creation event carries the room type, which decides its built-in category, and the time it was added to the
 * server, close to when it was made for most channels, which orders the channels nobody placed.
 */
export function standInRoom(client: MatrixClient, channel: ServerChannel): Room {
    // Detached, as the room list reads its pending events, like any room's, to show an unsent message.
    const room = new Room(channel.roomId, client, client.getSafeUserId(), {
        pendingEventOrdering: PendingEventOrdering.Detached,
    });
    room.name = channel.name;
    room.currentState.setStateEvents([
        new MatrixEvent({
            type: EventType.RoomCreate,
            state_key: "",
            room_id: channel.roomId,
            origin_server_ts: channel.addedAt,
            content: channel.roomType ? { type: channel.roomType } : {},
        }),
    ]);
    return room;
}

/** The rooms a server lists as its own, by room id. */
function childIds(space: Room): Set<string> {
    return new Set(getLayoutChildren(space).map((child) => child.roomId));
}

function joinedSpace(client: MatrixClient, roomId: string): Room | null {
    const room = client.getRoom(roomId);
    return room?.isSpaceRoom() && room.getMyMembership() === KnownMembership.Join ? room : null;
}

/**
 * Work out the folders of the open server's channel list: one for each server directly in it, holding that server's
 * channels, and inside it a folder for each server nested one level further, which opens on its own. A room the open
 * server lists itself stays in its own list even when a nested server lists it too.
 * @param space - The open server.
 * @param listed - The channels the user is in that the open server's list has, its nested servers' included.
 * @param known - Every room the list has already, which a folder never lists again as one to join.
 * @param previous - The last layout, whose empty rooms are kept while their channel is the same.
 */
export function planFolders(
    source: ServerFolderSource,
    space: Room,
    listed: Room[],
    known: Set<string>,
    previous?: FolderLayout,
): FolderLayout {
    const { client } = source;
    const layout: FolderLayout = { folders: [], byId: new Map(), insideFolders: new Set(), unjoined: new Map() };
    const own = childIds(space);
    const reuse = (channel: ServerChannel): Room => {
        const known = previous?.byId.get(channel.roomId)?.room ?? previous?.unjoined.get(channel.roomId)?.room;
        return known && known.name === channel.name ? known : standInRoom(client, channel);
    };

    // The open server's own nested servers, joined or not, in the order its children are listed.
    const unjoinedServers = new Map(source.getSubservers(space.roomId).map((server) => [server.roomId, server]));
    for (const id of own) {
        if (id === space.roomId) continue;
        const joined = joinedSpace(client, id);
        const unjoined = unjoinedServers.get(id);
        if (!joined && !unjoined) continue;
        const plan = folderPlan(id, joined, unjoined, true);
        if (!plan) continue;
        layout.folders.push(plan);
        layout.byId.set(id, plan);
    }

    // Each joined room that isn't the open server's own goes in the first folder whose server holds it.
    for (const room of listed) {
        if (own.has(room.roomId) || layout.byId.has(room.roomId)) continue;
        const holder = layout.folders.find(
            (plan) => plan.joined && source.isRoomInSpace(plan.folder.roomId, room.roomId),
        );
        if (!holder) continue;
        holder.joinedRooms.push(room);
        layout.insideFolders.add(room.roomId);
    }

    for (const plan of layout.folders) {
        if (!source.isExpanded(plan.folder.roomId)) continue;
        plan.contents = folderContents(plan);
    }
    return layout;

    function folderPlan(
        roomId: string,
        joined: Room | null,
        unjoined: ServerChannel | undefined,
        canExpand: boolean,
    ): FolderPlan | undefined {
        const name = joined?.name ?? unjoined?.name;
        if (!name) return undefined;
        const folder: ServerFolder = {
            roomId,
            name,
            avatarUrl: joined ? (joined.getMxcAvatarUrl() ?? undefined) : unjoined?.avatarUrl,
        };
        const room = joined ?? reuse({ ...unjoined!, roomType: RoomType.Space });
        return { folder, via: unjoined?.via ?? [], joined: !!joined, room, canExpand, contents: [], joinedRooms: [] };
    }

    /** The channels and nested servers of a folder's server, arranged by that server's own layout. */
    function folderContents(plan: FolderPlan): Room[] {
        const server = plan.joined ? plan.room : null;
        const serverChildren = server ? childIds(server) : undefined;
        const rooms: Room[] = [];
        const placed = new Set<string>();
        const add = (room: Room): void => {
            // The open server's own rooms, and the folders, are listed once, where the open server puts them.
            if (placed.has(room.roomId) || own.has(room.roomId) || room.roomId === space.roomId) return;
            placed.add(room.roomId);
            rooms.push(room);
        };

        for (const room of plan.joinedRooms) if (serverChildren?.has(room.roomId)) add(room);

        const serverToJoin = plan.joined ? undefined : { roomId: plan.folder.roomId, via: plan.via };
        for (const channel of source.getChannels(plan.folder.roomId)) {
            if (known.has(channel.roomId) || placed.has(channel.roomId)) continue;
            const room = reuse(channel);
            layout.unjoined.set(channel.roomId, { channel, room, serverToJoin });
            add(room);
        }

        // Servers nested one level further show as folders that open on their own.
        const deeper = new Map(source.getSubservers(plan.folder.roomId).map((s) => [s.roomId, s]));
        const deeperIds = new Set([...(serverChildren ?? []), ...deeper.keys()]);
        for (const id of deeperIds) {
            if (layout.byId.has(id) || id === plan.folder.roomId) continue;
            const joined = joinedSpace(client, id);
            if (!joined && !deeper.has(id)) continue;
            const nested = folderPlan(id, joined, deeper.get(id), false);
            if (!nested) continue;
            nested.joinedRooms = plan.joinedRooms.filter((room) => joined && source.isRoomInSpace(id, room.roomId));
            layout.byId.set(id, nested);
            add(nested.room);
        }

        const reader = server ? SpaceLayoutStore.instance.reader(server) : EMPTY_LAYOUT_READER;
        const arranged = projectLayout(reader, server, rooms);
        return [...arranged.uncategorized, ...arranged.categories.flatMap((category) => category.rooms)];
    }
}
