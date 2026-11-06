/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    BaseViewModel,
    type DiscoverCategory,
    type DiscoverEntry,
    type DiscoverSection,
    type DiscoverServer,
    type DiscoverViewModel as DiscoverViewModelInterface,
    type DiscoverViewSnapshot,
} from "@element-hq/web-shared-components";
import {
    JoinRule,
    RoomEvent,
    RoomType,
    type IPublicRoomsChunkRoom,
    type IRoomDirectoryOptions,
    type MatrixClient,
} from "matrix-js-sdk/src/matrix";
import { KnownMembership } from "matrix-js-sdk/src/types";
import { logger } from "matrix-js-sdk/src/logger";

import defaultDispatcher, { type MatrixDispatcher } from "../../dispatcher/dispatcher";
import { Action } from "../../dispatcher/actions";
import { type ActionPayload } from "../../dispatcher/payloads";
import { type ViewRoomPayload } from "../../dispatcher/payloads/ViewRoomPayload";
import { type ViewDiscoverPayload } from "../../dispatcher/payloads/ViewDiscoverPayload";
import { mediaFromMxc } from "../../customisations/Media";
import SdkConfig from "../../SdkConfig";
import SettingsStore from "../../settings/SettingsStore";
import { SettingLevel } from "../../settings/SettingLevel";
import { cheapNsfwFilter } from "../../hooks/usePublicRoomDirectory";
import { matchesCategory } from "./discoverCategories";
import type SpaceStore from "../../stores/spaces/SpaceStore";

/** Shared with the room directory in search, so both remember the same directory. */
export const LAST_SERVER_KEY = "mx_last_room_directory_server";
/** Communities requested per directory page. */
export const PAGE_SIZE = 60;
/** Most pages one request fetches while a category tab has too few matches to fill the grid. */
const MAX_CATEGORY_PAGES = 4;
/** A category tab keeps fetching until it can show at least this many new communities. */
const CATEGORY_TARGET = 24;
const SEARCH_DEBOUNCE_MS = 300;
const AVATAR_SIZE = 96;
const TOPIC_LIMIT = 280;

interface Props {
    client: MatrixClient;
    /** Opens the dialog for another directory and resolves with the server name, if one was chosen. */
    promptForServer: () => Promise<string | undefined>;
    /** Opens a joined Space the way the Space bar does. */
    spaceStore: Pick<SpaceStore, "setActiveSpace">;
    dispatcher?: MatrixDispatcher;
}

/** Reduces Markdown links to their text and collapses whitespace so topics fit a card. */
export function plainTopic(topic: string | undefined): string | undefined {
    if (!topic) return undefined;
    const text = topic
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/[*_`#>]+/g, "")
        .replace(/\s+/g, " ")
        .trim();
    if (!text) return undefined;
    return text.length > TOPIC_LIMIT ? `${text.slice(0, TOPIC_LIMIT).trimEnd()}…` : text;
}

/**
 * Backs the Discover page: lists public Spaces or rooms from a Matrix room directory, filters them into topic tabs
 * and opens the chosen community's preview.
 */
export class DiscoverViewModel
    extends BaseViewModel<DiscoverViewSnapshot, Props>
    implements DiscoverViewModelInterface
{
    private readonly dispatcher: MatrixDispatcher;
    /** Directory rows for the current server, section and search, in directory order. */
    private rows: IPublicRoomsChunkRoom[] = [];
    private nextBatch?: string;
    /** Increases on every new listing so responses for an older one are dropped. */
    private generation = 0;
    private started = false;
    private searchTimer?: number;
    private roomTypeFilterSupported?: Promise<boolean>;

    public constructor(props: Props) {
        const servers = DiscoverViewModel.directoryServers(props.client);
        const saved = localStorage.getItem(LAST_SERVER_KEY);
        const server = servers.some(({ name }) => name === saved) ? saved! : servers[0].name;
        super(props, {
            section: "spaces",
            category: "home",
            query: "",
            server,
            servers,
            entries: [],
            status: "loading",
            loadingMore: false,
            hasMore: false,
        });
        this.dispatcher = props.dispatcher ?? defaultDispatcher;
        const token = this.dispatcher.register(this.onAction);
        this.disposables.track(() => this.dispatcher.unregister(token));
        this.disposables.trackListener(props.client, RoomEvent.MyMembership, this.refreshEntries);
        this.disposables.track(() => window.clearTimeout(this.searchTimer));
    }

    /** The user's homeserver, then configured directories, then ones the user added. */
    private static directoryServers(client: MatrixClient): DiscoverServer[] {
        const homeServer = client.getDomain() ?? "";
        const configured: string[] = SdkConfig.getObject("room_directory")?.get("servers") ?? [];
        const added: string[] = SettingsStore.getValue("room_directory_servers") ?? [];
        const others = [...new Set([...configured, ...added])].filter((name) => name && name !== homeServer).sort();
        return [{ name: homeServer, isHome: true }, ...others.map((name) => ({ name, isHome: false }))];
    }

    /** Loads the directory on the first visit. Later visits keep the listing the user left. */
    public start(): void {
        if (!this.started) this.reload();
    }

    private onAction = (payload: ActionPayload): void => {
        if (payload.action !== Action.ViewDiscover) return;
        const { section, query } = payload as ViewDiscoverPayload;
        const changed =
            (section !== undefined && section !== this.snapshot.current.section) ||
            (query !== undefined && query !== this.snapshot.current.query);
        if (section) this.snapshot.merge({ section });
        if (query !== undefined) this.snapshot.merge({ query });
        if (changed || !this.started) this.reload();
    };

    public setSection = (section: DiscoverSection): void => {
        if (section === this.snapshot.current.section) return;
        this.snapshot.merge({ section });
        this.reload();
    };

    public setCategory = (category: DiscoverCategory): void => {
        if (category === this.snapshot.current.category) return;
        this.snapshot.merge({ category });
        // Categories filter the rows already fetched, fetching more only if too few match.
        this.publish();
        const { status, loadingMore, entries } = this.snapshot.current;
        // A listing still loading reads the new tab when its page arrives.
        if (status === "ready" && !loadingMore && entries.length < CATEGORY_TARGET && this.nextBatch) {
            void this.fetchMore();
        }
    };

    public setQuery = (query: string): void => {
        this.snapshot.merge({ query });
        window.clearTimeout(this.searchTimer);
        this.searchTimer = window.setTimeout(() => this.reload(), SEARCH_DEBOUNCE_MS);
    };

    public setServer = (server: string): void => {
        if (server === this.snapshot.current.server) return;
        localStorage.setItem(LAST_SERVER_KEY, server);
        this.snapshot.merge({ server });
        this.reload();
    };

    public addServer = (): void => {
        void this.props.promptForServer().then((server) => {
            if (!server || this.isDisposed) return;
            const added: string[] = SettingsStore.getValue("room_directory_servers") ?? [];
            if (!added.includes(server)) {
                void SettingsStore.setValue("room_directory_servers", null, SettingLevel.ACCOUNT, [...added, server]);
            }
            const servers = DiscoverViewModel.directoryServers(this.props.client);
            if (!servers.some(({ name }) => name === server)) servers.push({ name: server, isHome: false });
            this.snapshot.merge({ servers });
            this.setServer(server);
        });
    };

    public loadMore = (): void => {
        const { status, loadingMore } = this.snapshot.current;
        if (status !== "ready" || loadingMore || !this.nextBatch) return;
        void this.fetchMore();
    };

    public retry = (): void => this.reload();

    public open = (roomId: string): void => {
        const row = this.rows.find((candidate) => candidate.room_id === roomId);
        if (!row) return;
        const { server } = this.snapshot.current;
        const aliasServer = row.canonical_alias?.split(":").slice(1).join(":");
        const joined = this.props.client.getRoom(roomId)?.getMyMembership() === KnownMembership.Join;
        if (joined && row.room_type === RoomType.Space) {
            // A joined server opens on its channels, as it does from the Space bar.
            this.props.spaceStore.setActiveSpace(roomId, true, true);
            return;
        }
        this.dispatcher.dispatch<ViewRoomPayload>({
            action: Action.ViewRoom,
            room_id: roomId,
            via_servers: [...new Set([server, aliasServer].filter((name): name is string => !!name))],
            should_peek: !joined && row.world_readable,
            oob_data: { name: row.name, avatarUrl: row.avatar_url, roomType: row.room_type },
            metricsTrigger: "RoomDirectory",
        });
        if (!joined && row.join_rule === JoinRule.Knock && SettingsStore.getValue("feature_ask_to_join")) {
            this.dispatcher.dispatch({ action: Action.PromptAskToJoin });
        }
    };

    /** Starts a new listing for the current server, section and search. */
    private reload(): void {
        window.clearTimeout(this.searchTimer);
        this.started = true;
        this.generation++;
        this.rows = [];
        this.nextBatch = undefined;
        this.snapshot.merge({ entries: [], status: "loading", loadingMore: false, hasMore: false });
        void this.fetch(this.generation, true);
    }

    private async fetchMore(): Promise<void> {
        this.snapshot.merge({ loadingMore: true });
        await this.fetch(this.generation, false);
    }

    /**
     * Fetches directory pages for the current listing. A category tab keeps paging until it has enough matches,
     * so a narrow topic is not left with an empty grid.
     */
    private async fetch(generation: number, first: boolean): Promise<void> {
        const startCount = first ? 0 : this.snapshot.current.entries.length;
        try {
            for (let page = 1; ; page++) {
                const response = await this.props.client.publicRooms(await this.requestOptions());
                if (generation !== this.generation || this.isDisposed) return;
                this.appendRows(response.chunk);
                this.nextBatch = response.next_batch || undefined;
                // The tab may have changed while this page loaded, so read it again.
                const { category } = this.snapshot.current;
                if (!this.nextBatch || category === "home" || page >= MAX_CATEGORY_PAGES) break;
                if (this.matchingRows().length - startCount >= CATEGORY_TARGET) break;
            }
            this.publish("ready");
        } catch (error) {
            if (generation !== this.generation || this.isDisposed) return;
            logger.warn("Could not load the public directory", error);
            this.snapshot.merge(first ? { status: "error", loadingMore: false } : { loadingMore: false });
        }
    }

    private async requestOptions(): Promise<IRoomDirectoryOptions> {
        const { client } = this.props;
        const { server, section, query } = this.snapshot.current;
        const options: IRoomDirectoryOptions = { limit: PAGE_SIZE };
        if (server !== client.getDomain()) options.server = server;
        if (this.nextBatch) options.since = this.nextBatch;
        this.roomTypeFilterSupported ??= Promise.all([
            client.isVersionSupported("v1.4"),
            client.doesServerSupportUnstableFeature("org.matrix.msc3827.stable"),
        ]).then(
            ([stable, unstable]) => stable || unstable,
            () => false,
        );
        const roomTypes = (await this.roomTypeFilterSupported)
            ? section === "spaces"
                ? [RoomType.Space]
                : [null]
            : undefined;
        const term = query.trim();
        if (term || roomTypes) options.filter = { generic_search_term: term || undefined, room_types: roomTypes };
        return options;
    }

    private appendRows(chunk: IPublicRoomsChunkRoom[]): void {
        const wantSpaces = this.snapshot.current.section === "spaces";
        const showNsfw = SettingsStore.getValue("SpotlightSearch.showNsfwPublicRooms");
        const seen = new Set(this.rows.map((row) => row.room_id));
        for (const row of chunk) {
            // Directories that ignore the type filter still only show the requested kind.
            if ((row.room_type === RoomType.Space) !== wantSpaces) continue;
            if (!showNsfw && !cheapNsfwFilter(row)) continue;
            if (seen.has(row.room_id)) continue;
            seen.add(row.room_id);
            this.rows.push(row);
        }
    }

    private matchingRows(): IPublicRoomsChunkRoom[] {
        const { category } = this.snapshot.current;
        return this.rows.filter((row) => matchesCategory(category, this.displayName(row), row.topic));
    }

    private displayName(row: IPublicRoomsChunkRoom): string {
        return row.name || row.canonical_alias || row.aliases?.[0] || row.room_id;
    }

    private toEntry(row: IPublicRoomsChunkRoom): DiscoverEntry {
        const { client } = this.props;
        return {
            roomId: row.room_id,
            name: this.displayName(row),
            topic: plainTopic(row.topic),
            avatarUrl: row.avatar_url
                ? (mediaFromMxc(row.avatar_url, client).getThumbnailOfSourceHttp(AVATAR_SIZE, AVATAR_SIZE, "crop") ??
                  undefined)
                : undefined,
            memberCount: row.num_joined_members,
            joined: client.getRoom(row.room_id)?.getMyMembership() === KnownMembership.Join,
        };
    }

    /** Shows the rows matching the current tab, finishing the listing's loading state when `status` is given. */
    private publish(status?: DiscoverViewSnapshot["status"]): void {
        this.snapshot.merge({
            entries: this.matchingRows().map((row) => this.toEntry(row)),
            hasMore: !!this.nextBatch,
            ...(status ? { status, loadingMore: false } : {}),
        });
    }

    /** Joining or leaving from the preview updates the cards' joined badges. */
    private refreshEntries = (): void => {
        if (this.snapshot.current.status === "ready") this.publish();
    };
}
