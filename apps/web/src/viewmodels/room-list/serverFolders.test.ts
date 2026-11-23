/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventType, KnownMembership, type MatrixClient, MatrixEvent, Room, RoomType } from "matrix-js-sdk/src/matrix";

import { isFolderExpanded, planFolders, setFolderExpanded, type ServerFolderSource } from "./serverFolders";
import { type ServerChannel } from "../../utils/servers/serverChannels";
import SettingsStore from "../../settings/SettingsStore";

const ME = "@me:example.org";
const ROOT = "!root:example.org";
const ADVOCACY = "!advocacy:example.org";
const ARCHIVE = "!archive:example.org";
const BRIDGES = "!bridges:example.org";

const channel = (roomId: string, extra: Partial<ServerChannel> = {}): ServerChannel => ({
    roomId,
    name: roomId.slice(1, roomId.indexOf(":")),
    kind: "text",
    memberCount: 2,
    suggested: false,
    via: ["example.org"],
    ...extra,
});

describe("planFolders", () => {
    let rooms: Map<string, Room>;
    let client: MatrixClient;
    let unjoinedChannels: Record<string, ServerChannel[]>;
    let unjoinedServers: Record<string, ServerChannel[]>;
    let expanded: Set<string>;
    let source: ServerFolderSource;

    /** A room the user is in, with the children it lists when it is a server. */
    const mkRoom = (roomId: string, { space = false, children = [] as string[] } = {}): Room => {
        const room = new Room(roomId, client, ME);
        room.name = roomId.slice(1, roomId.indexOf(":"));
        vi.spyOn(room, "getMyMembership").mockReturnValue(KnownMembership.Join);
        room.currentState.setStateEvents([
            new MatrixEvent({
                type: EventType.RoomCreate,
                state_key: "",
                room_id: roomId,
                content: space ? { type: RoomType.Space } : {},
            }),
            ...children.map(
                (child, index) =>
                    new MatrixEvent({
                        type: EventType.SpaceChild,
                        state_key: child,
                        room_id: roomId,
                        origin_server_ts: index,
                        content: { via: ["example.org"], order: String.fromCharCode(97 + index) },
                    }),
            ),
        ]);
        rooms.set(roomId, room);
        return room;
    };

    beforeEach(() => {
        rooms = new Map();
        client = {
            getRoom: (roomId: string) => rooms.get(roomId) ?? null,
            getSafeUserId: () => ME,
            getUserId: () => ME,
            supportsThreads: () => false,
            store: { getPendingEvents: async () => [] },
            // Stand-in rooms read their pending events back through the event mapper.
            getEventMapper: () => () => undefined,
        } as unknown as MatrixClient;
        unjoinedChannels = {};
        unjoinedServers = {};
        expanded = new Set();
        const tree: Record<string, string[]> = {
            [ADVOCACY]: ["!news:example.org", "!updates:example.org", ARCHIVE],
            [ARCHIVE]: ["!old:example.org"],
        };
        const inSpace = (spaceId: string, roomId: string): boolean =>
            (tree[spaceId] ?? []).some((child) => child === roomId || inSpace(child, roomId));
        source = {
            client,
            isRoomInSpace: inSpace,
            getChannels: (spaceId) => unjoinedChannels[spaceId] ?? [],
            getSubservers: (spaceId) => unjoinedServers[spaceId] ?? [],
            isExpanded: (folderId) => expanded.has(folderId),
        };
    });

    function setUp(): { root: Room; listed: Room[] } {
        const root = mkRoom(ROOT, { space: true, children: ["!general:example.org", ADVOCACY, BRIDGES] });
        mkRoom(ADVOCACY, { space: true, children: ["!news:example.org", "!updates:example.org", ARCHIVE] });
        mkRoom(ARCHIVE, { space: true, children: ["!old:example.org"] });
        const listed = [mkRoom("!general:example.org"), mkRoom("!news:example.org"), mkRoom("!old:example.org")];
        unjoinedServers[ROOT] = [
            channel(BRIDGES, { roomType: RoomType.Space, avatarUrl: "mxc://example.org/bridges" }),
        ];
        unjoinedChannels[ADVOCACY] = [channel("!updates:example.org")];
        unjoinedChannels[BRIDGES] = [channel("!irc:example.org")];
        return { root, listed };
    }

    it("makes a folder of each server in the open one, joined or not, and keeps their rooms out of its own list", () => {
        const { root, listed } = setUp();
        const layout = planFolders(source, root, listed, new Set(listed.map((room) => room.roomId)));

        expect(layout.folders.map((plan) => [plan.folder.name, plan.joined, plan.canExpand])).toEqual([
            ["advocacy", true, true],
            ["bridges", false, true],
        ]);
        expect(layout.byId.get(BRIDGES)?.folder.avatarUrl).toBe("mxc://example.org/bridges");
        // A server the user is not in stands in as an empty space room, which the layout places like a channel.
        const standIn = layout.byId.get(BRIDGES)!.room;
        expect(standIn.getType()).toBe(RoomType.Space);
        // The room list reads every room's pending events, which only a detached room keeps.
        expect(standIn.getPendingEvents()).toEqual([]);
        // The room directly in Advocacy and the one in its own nested server only show inside the folder.
        expect([...layout.insideFolders].sort()).toEqual(["!news:example.org", "!old:example.org"]);
        expect(layout.byId.get(ADVOCACY)?.joinedRooms.map((room) => room.roomId)).toEqual([
            "!news:example.org",
            "!old:example.org",
        ]);
        // Closed folders hold nothing yet, and don't look their channels up.
        expect(layout.byId.get(ADVOCACY)?.contents).toEqual([]);
    });

    it("lists an open folder's channels, joined or not, in its server's order, with deeper servers as folders", () => {
        const { root, listed } = setUp();
        expanded.add(ADVOCACY).add(BRIDGES);
        const layout = planFolders(source, root, listed, new Set(listed.map((room) => room.roomId)));

        expect(layout.byId.get(ADVOCACY)?.contents.map((room) => room.roomId)).toEqual([
            "!news:example.org",
            "!updates:example.org",
            ARCHIVE,
        ]);
        const archive = layout.byId.get(ARCHIVE);
        expect(archive?.canExpand).toBe(false);
        expect(archive?.joinedRooms.map((room) => room.roomId)).toEqual(["!old:example.org"]);

        expect(layout.byId.get(BRIDGES)?.contents.map((room) => room.roomId)).toEqual(["!irc:example.org"]);
        // A channel of a server the user is not in joins that server first.
        expect(layout.unjoined.get("!irc:example.org")?.serverToJoin).toEqual({
            roomId: BRIDGES,
            via: ["example.org"],
        });
        expect(layout.unjoined.get("!updates:example.org")?.serverToJoin).toBeUndefined();
    });

    it("leaves a room the open server lists itself in its own list, and lists nothing already listed again", () => {
        const { root, listed } = setUp();
        // Advocacy also lists the open server's own channel, and the user already has "updates".
        mkRoom(ADVOCACY, { space: true, children: ["!general:example.org", "!news:example.org"] });
        expanded.add(ADVOCACY);
        const known = new Set([...listed.map((room) => room.roomId), "!updates:example.org"]);
        const layout = planFolders(source, root, listed, known);

        expect(layout.insideFolders.has("!general:example.org")).toBe(false);
        expect(layout.byId.get(ADVOCACY)?.contents.map((room) => room.roomId)).toEqual(["!news:example.org"]);
    });

    it("keeps the empty rooms standing in for unjoined channels while they are the same", () => {
        const { root, listed } = setUp();
        expanded.add(BRIDGES);
        const known = new Set(listed.map((room) => room.roomId));
        const first = planFolders(source, root, listed, known);
        const second = planFolders(source, root, listed, known, first);
        expect(second.byId.get(BRIDGES)?.room).toBe(first.byId.get(BRIDGES)?.room);
        expect(second.unjoined.get("!irc:example.org")?.room).toBe(first.unjoined.get("!irc:example.org")?.room);
    });

    it("has no folders for a server without nested servers", () => {
        const root = mkRoom(ROOT, { space: true, children: ["!general:example.org"] });
        const layout = planFolders(source, root, [mkRoom("!general:example.org")], new Set());
        expect(layout.folders).toEqual([]);
        expect(layout.insideFolders.size).toBe(0);
    });
});

describe("folder open state", () => {
    it("starts closed and is remembered per server on this device", async () => {
        let state = {};
        vi.spyOn(SettingsStore, "getValue").mockImplementation(() => state);
        const set = vi.spyOn(SettingsStore, "setValue").mockImplementation(async (_name, _room, _level, value) => {
            state = value as object;
        });
        expect(isFolderExpanded(ROOT, ADVOCACY)).toBe(false);
        await setFolderExpanded(ROOT, ADVOCACY, true);
        expect(set).toHaveBeenCalled();
        expect(isFolderExpanded(ROOT, ADVOCACY)).toBe(true);
        expect(isFolderExpanded(BRIDGES, ADVOCACY)).toBe(false);
    });
});
