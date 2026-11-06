/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
    JoinRule,
    Room,
    RoomEvent,
    RoomType,
    type IPublicRoomsChunkRoom,
    type MatrixClient,
} from "matrix-js-sdk/src/matrix";
import { stubClient } from "test-utils";

import { DiscoverViewModel, LAST_SERVER_KEY, PAGE_SIZE, plainTopic } from "./DiscoverViewModel";
import { MatrixDispatcher } from "../../dispatcher/dispatcher";
import { Action } from "../../dispatcher/actions";
import SettingsStore from "../../settings/SettingsStore";
import SdkConfig from "../../SdkConfig";

/** The SDK does not export its directory response type. */
type IPublicRoomsResponse = Awaited<ReturnType<MatrixClient["publicRooms"]>>;

function row(id: string, overrides: Partial<IPublicRoomsChunkRoom> = {}): IPublicRoomsChunkRoom {
    return {
        room_id: `!${id}:example.org`,
        name: id,
        num_joined_members: 10,
        world_readable: false,
        guest_can_join: false,
        join_rule: JoinRule.Public,
        room_type: RoomType.Space,
        ...overrides,
    };
}

function page(chunk: IPublicRoomsChunkRoom[], next_batch?: string): IPublicRoomsResponse {
    return { chunk, next_batch, total_room_count_estimate: chunk.length };
}

/** Lets the model's awaited directory requests settle. */
async function settle(): Promise<void> {
    for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("DiscoverViewModel", () => {
    let client: MatrixClient;
    let dispatcher: MatrixDispatcher;
    let promptForServer: ReturnType<typeof vi.fn<() => Promise<string | undefined>>>;
    let vm: DiscoverViewModel;
    let spaceStore: { setActiveSpace: Mock<(space: string, contextSwitch?: boolean, reopen?: boolean) => void> };
    let settings: Record<string, unknown>;

    beforeEach(() => {
        localStorage.clear();
        client = stubClient();
        client.publicRooms = vi.fn().mockResolvedValue(page([row("games"), row("music")]));
        vi.mocked(client.isVersionSupported).mockResolvedValue(true);
        vi.mocked(client.getRoom).mockReturnValue(null);
        settings = { "room_directory_servers": ["added.example"], "SpotlightSearch.showNsfwPublicRooms": false };
        vi.spyOn(SettingsStore, "getValue").mockImplementation(
            ((name: string) => settings[name]) as typeof SettingsStore.getValue,
        );
        vi.spyOn(SettingsStore, "setValue").mockResolvedValue(undefined);
        SdkConfig.put({ room_directory: { servers: ["configured.example", "matrix.org"] } });
        dispatcher = new MatrixDispatcher();
        promptForServer = vi.fn<() => Promise<string | undefined>>();
        spaceStore = { setActiveSpace: vi.fn() };
        vm = new DiscoverViewModel({ client, dispatcher, promptForServer, spaceStore });
    });

    afterEach(() => {
        vm.dispose();
        vi.restoreAllMocks();
        vi.useRealTimers();
        SdkConfig.reset();
    });

    it("lists the homeserver first, then configured and added directories, and loads nothing until shown", () => {
        expect(vm.getSnapshot().servers).toEqual([
            { name: "matrix.org", isHome: true },
            { name: "added.example", isHome: false },
            { name: "configured.example", isHome: false },
        ]);
        expect(vm.getSnapshot().server).toBe("matrix.org");
        expect(client.publicRooms).not.toHaveBeenCalled();
    });

    it("loads public Spaces from the homeserver directory on the first visit only", async () => {
        vm.start();
        expect(vm.getSnapshot().status).toBe("loading");
        await settle();
        expect(client.publicRooms).toHaveBeenCalledWith({
            limit: PAGE_SIZE,
            filter: { generic_search_term: undefined, room_types: [RoomType.Space] },
        });
        expect(vm.getSnapshot()).toMatchObject({
            status: "ready",
            hasMore: false,
            entries: [
                { roomId: "!games:example.org", name: "games", memberCount: 10, joined: false },
                { roomId: "!music:example.org", name: "music" },
            ],
        });
        vm.start();
        expect(client.publicRooms).toHaveBeenCalledTimes(1);
    });

    it("keeps only the requested kind and hides NSFW and repeated rows", async () => {
        vi.mocked(client.publicRooms).mockResolvedValue(
            page([row("space"), row("room", { room_type: undefined }), row("adult", { topic: "NSFW" }), row("space")]),
        );
        vm.start();
        await settle();
        expect(vm.getSnapshot().entries.map((entry) => entry.name)).toEqual(["space"]);

        vm.setSection("rooms");
        await settle();
        expect(vi.mocked(client.publicRooms).mock.lastCall?.[0]?.filter?.room_types).toEqual([null]);
        expect(vm.getSnapshot().entries.map((entry) => entry.name)).toEqual(["room"]);
    });

    it("leaves out the type filter on servers that do not support it", async () => {
        vi.mocked(client.isVersionSupported).mockResolvedValue(false);
        vi.mocked(client.doesServerSupportUnstableFeature).mockResolvedValue(false);
        vm.start();
        await settle();
        expect(client.publicRooms).toHaveBeenCalledWith({ limit: PAGE_SIZE });
    });

    it("shows avatars as thumbnails, plain topics and joined state", async () => {
        vi.mocked(client.publicRooms).mockResolvedValue(
            page([row("games", { avatar_url: "mxc://example.org/avatar", topic: "See [rules](https://x)" })]),
        );
        const joined = new Room("!games:example.org", client, client.getSafeUserId());
        vi.spyOn(joined, "getMyMembership").mockReturnValue("join");
        vi.mocked(client.getRoom).mockReturnValue(joined);
        vm.start();
        await settle();
        expect(vm.getSnapshot().entries[0]).toMatchObject({
            avatarUrl: expect.stringContaining("example.org/avatar"),
            topic: "See rules",
            joined: true,
        });

        vi.spyOn(joined, "getMyMembership").mockReturnValue("leave");
        client.emit(RoomEvent.MyMembership, joined, "leave");
        expect(vm.getSnapshot().entries[0].joined).toBe(false);
    });

    it("searches after the user stops typing", async () => {
        vi.useFakeTimers();
        vm.start();
        await settle();
        vm.setQuery("me");
        vm.setQuery("metal ");
        expect(vm.getSnapshot().query).toBe("metal ");
        expect(client.publicRooms).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(300);
        await settle();
        expect(client.publicRooms).toHaveBeenCalledTimes(2);
        expect(vi.mocked(client.publicRooms).mock.lastCall?.[0]?.filter?.generic_search_term).toBe("metal");
    });

    it("pages through the directory and stops when it runs out", async () => {
        vi.mocked(client.publicRooms)
            .mockResolvedValueOnce(page([row("a")], "next"))
            .mockResolvedValueOnce(page([row("b")]));
        vm.start();
        await settle();
        expect(vm.getSnapshot()).toMatchObject({ hasMore: true, entries: [{ name: "a" }] });
        vm.loadMore();
        expect(vm.getSnapshot().loadingMore).toBe(true);
        vm.loadMore();
        await settle();
        expect(client.publicRooms).toHaveBeenCalledTimes(2);
        expect(vi.mocked(client.publicRooms).mock.lastCall?.[0]?.since).toBe("next");
        expect(vm.getSnapshot()).toMatchObject({ hasMore: false, loadingMore: false });
        expect(vm.getSnapshot().entries.map((entry) => entry.name)).toEqual(["a", "b"]);
        vm.loadMore();
        expect(client.publicRooms).toHaveBeenCalledTimes(2);
    });

    it("filters by category and fetches further pages to fill a narrow one", async () => {
        vi.mocked(client.publicRooms)
            .mockResolvedValueOnce(page([row("Linux Users"), row("Cooking")], "p2"))
            .mockResolvedValueOnce(page([row("Rust programming")], "p3"))
            .mockResolvedValueOnce(page([row("Garden")]));
        vm.start();
        await settle();
        vm.setCategory("tech");
        expect(vm.getSnapshot().entries.map((entry) => entry.name)).toEqual(["Linux Users"]);
        await settle();
        expect(client.publicRooms).toHaveBeenCalledTimes(3);
        expect(vm.getSnapshot().entries.map((entry) => entry.name)).toEqual(["Linux Users", "Rust programming"]);
        vm.setCategory("home");
        expect(vm.getSnapshot().entries).toHaveLength(4);
    });

    it("switches directory, remembers it and browses it remotely", async () => {
        vm.start();
        await settle();
        vm.setServer("configured.example");
        await settle();
        expect(localStorage.getItem(LAST_SERVER_KEY)).toBe("configured.example");
        expect(vi.mocked(client.publicRooms).mock.lastCall?.[0]?.server).toBe("configured.example");

        const next = new DiscoverViewModel({ client, dispatcher, promptForServer, spaceStore });
        expect(next.getSnapshot().server).toBe("configured.example");
        next.dispose();
    });

    it("adds a server the user names and browses it", async () => {
        promptForServer.mockResolvedValue("new.example");
        vm.addServer();
        await settle();
        expect(SettingsStore.setValue).toHaveBeenCalledWith("room_directory_servers", null, "account", [
            "added.example",
            "new.example",
        ]);
        expect(vm.getSnapshot().server).toBe("new.example");
        expect(vm.getSnapshot().servers).toContainEqual({ name: "new.example", isHome: false });
    });

    it("reports a failed listing and retries", async () => {
        vi.mocked(client.publicRooms).mockRejectedValueOnce(new Error("offline"));
        vm.start();
        await settle();
        expect(vm.getSnapshot().status).toBe("error");
        vm.retry();
        await settle();
        expect(vm.getSnapshot().status).toBe("ready");
    });

    it("drops responses for a listing the user has already left", async () => {
        let resolveFirst!: (response: IPublicRoomsResponse) => void;
        vi.mocked(client.publicRooms)
            .mockReturnValueOnce(new Promise((resolve) => (resolveFirst = resolve)))
            .mockResolvedValueOnce(page([row("room", { room_type: undefined })]));
        vm.start();
        await settle();
        vm.setSection("rooms");
        await settle();
        resolveFirst(page([row("stale")]));
        await settle();
        expect(vm.getSnapshot().entries.map((entry) => entry.name)).toEqual(["room"]);
    });

    it("opens a request for a section and search", async () => {
        dispatcher.dispatch({ action: Action.ViewDiscover, section: "rooms", query: "linux" }, true);
        expect(vm.getSnapshot()).toMatchObject({ section: "rooms", query: "linux", status: "loading" });
        await settle();
        expect(vi.mocked(client.publicRooms).mock.lastCall?.[0]?.filter?.generic_search_term).toBe("linux");

        // Opening Discover again keeps the listing the user left.
        dispatcher.dispatch({ action: Action.ViewDiscover }, true);
        expect(client.publicRooms).toHaveBeenCalledTimes(1);
    });

    it("previews a community through the directory server without joining", async () => {
        vi.mocked(client.publicRooms).mockResolvedValue(
            page([row("games", { world_readable: true, canonical_alias: "#games:alias.example" })]),
        );
        const dispatch = vi.spyOn(dispatcher, "dispatch");
        vm.start();
        await settle();
        vm.open("!games:example.org");
        expect(dispatch).toHaveBeenCalledWith({
            action: Action.ViewRoom,
            room_id: "!games:example.org",
            via_servers: ["matrix.org", "alias.example"],
            should_peek: true,
            oob_data: { name: "games", avatarUrl: undefined, roomType: RoomType.Space },
            metricsTrigger: "RoomDirectory",
        });
        expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ auto_join: true }));
    });

    it("opens a joined server on its channels, as the Space bar does", async () => {
        const joined = new Room("!games:example.org", client, client.getSafeUserId());
        vi.spyOn(joined, "getMyMembership").mockReturnValue("join");
        vi.mocked(client.getRoom).mockReturnValue(joined);
        const dispatch = vi.spyOn(dispatcher, "dispatch");
        vm.start();
        await settle();
        vm.open("!games:example.org");
        expect(spaceStore.setActiveSpace).toHaveBeenCalledWith("!games:example.org", true, true);
        expect(dispatch).not.toHaveBeenCalled();
    });

    it("asks to join a knock community when the feature is on", async () => {
        settings.feature_ask_to_join = true;
        vi.mocked(client.publicRooms).mockResolvedValue(page([row("club", { join_rule: JoinRule.Knock })]));
        const dispatch = vi.spyOn(dispatcher, "dispatch");
        vm.start();
        await settle();
        vm.open("!club:example.org");
        expect(dispatch).toHaveBeenCalledWith({ action: Action.PromptAskToJoin });
    });
});

describe("plainTopic", () => {
    it("reduces Markdown, collapses whitespace and shortens long topics", () => {
        expect(plainTopic(undefined)).toBeUndefined();
        expect(plainTopic("  **Hi**\n\n[site](https://example.org) ")).toBe("Hi site");
        expect(plainTopic("***")).toBeUndefined();
        expect(plainTopic("a".repeat(300))).toBe(`${"a".repeat(280)}…`);
    });
});
