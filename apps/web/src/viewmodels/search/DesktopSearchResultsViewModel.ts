/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    BaseViewModel,
    type DesktopSearchResultGroup,
    type DesktopSearchResultRow,
    type DesktopSearchResultsActions,
    type DesktopSearchResultsSnapshot,
    type DesktopSearchSort,
} from "@element-hq/web-shared-components";
import { EventType, type MatrixClient, type MatrixEvent, SearchOrderBy } from "matrix-js-sdk/src/matrix";

import eventSearch, { type EventSearchOptions, searchPagination } from "../../Searching";
import EventIndexPeg from "../../indexing/EventIndexPeg";
import { formatDate, formatFullDate } from "../../DateUtils";
import SettingsStore from "../../settings/SettingsStore";
import defaultDispatcher from "../../dispatcher/dispatcher";
import { Action } from "../../dispatcher/actions";
import { type ViewRoomPayload } from "../../dispatcher/payloads/ViewRoomPayload";
import { UserTab } from "../../components/views/dialogs/UserTab";
import { type ActiveDesktopSearch } from "../../stores/DesktopMessageSearchStore";
import { isApproximate, matchesFilters, toRoomEventFilter } from "../../utils/desktopSearch/filters";
import { highlightSegments, termsFromText } from "../../utils/desktopSearch/highlight";
import { BrowseSearchSource, type SearchSource, type SearchSourcePage, TextSearchSource } from "./searchSources";

const PAGE_TARGET = 10;
/** How many requests one page may take while client-side filters discard most results. */
const MAX_FETCHES = 6;

const ATTACHMENT_MSGTYPES = ["m.file", "m.image", "m.video", "m.audio"];

export interface DesktopSearchResultsDeps {
    search: TextSearchSourceDeps["search"];
    paginate: TextSearchSourceDeps["paginate"];
    hasEventIndex: () => boolean;
    createBrowseSource: (client: MatrixClient, roomIds: string[], signal: AbortSignal) => SearchSource;
}

type TextSearchSourceDeps = ConstructorParameters<typeof TextSearchSource>[0];

interface Props {
    client: MatrixClient;
    search: ActiveDesktopSearch;
    onClose: () => void;
    deps?: Partial<DesktopSearchResultsDeps>;
}

const defaultDeps = (query: ActiveDesktopSearch["query"]): DesktopSearchResultsDeps => ({
    search: eventSearch,
    paginate: searchPagination,
    hasEventIndex: () => EventIndexPeg.get() !== null,
    createBrowseSource: (client, roomIds, signal) =>
        new BrowseSearchSource(client, roomIds, toRoomEventFilter(query.filters, roomIds), PAGE_TARGET, signal),
});

/**
 * Runs one desktop message search and exposes its results. Text searches use Element's search engine; searches with
 * only filters page through room history. Filters the server cannot apply are checked here, and paging continues
 * until a page has enough matches or the results run out. A newer search or a sort change cancels the older one.
 */
export class DesktopSearchResultsViewModel
    extends BaseViewModel<DesktopSearchResultsSnapshot, Props>
    implements DesktopSearchResultsActions
{
    private readonly deps: DesktopSearchResultsDeps;
    private readonly events = new Map<string, MatrixEvent>();
    private hits: MatrixEvent[] = [];
    private seen = new Set<string>();
    private source?: SearchSource;
    private generation = 0;
    private abort?: AbortController;
    private count?: number;
    private highlights = new Set<string>();
    private exactCount = false;

    public constructor(props: Props) {
        super(props, {
            status: "loading",
            resultCount: 0,
            countIsLowerBound: false,
            sort: "recent",
            sorts: ["recent", "relevance"],
            groups: [],
            hasMore: false,
            loadingMore: false,
            approximate: isApproximate(props.search.query.filters),
            encryptedSkipped: false,
            decryptionFailed: false,
            activeId: null,
        });
        this.deps = { ...defaultDeps(props.search.query), ...props.deps };
        this.disposables.track(() => this.abort?.abort());
        void this.run("recent");
    }

    /** The event behind a result, so the host can render it with Element's media components. */
    public getEvent = (id: string): MatrixEvent | undefined => this.events.get(id);

    public setSort = (sort: DesktopSearchSort): void => {
        if (sort === this.getSnapshot().sort || !this.getSnapshot().sorts.includes(sort)) return;
        void this.run(sort);
    };

    public retry = (): void => {
        void this.run(this.getSnapshot().sort);
    };

    public loadMore = (): void => {
        const { status, hasMore, loadingMore } = this.getSnapshot();
        if (status !== "ready" || !hasMore || loadingMore || !this.source) return;
        this.snapshot.merge({ loadingMore: true });
        void this.fill(this.generation);
    };

    public openResult = (id: string): void => {
        const event = this.events.get(id);
        if (!event) return;
        defaultDispatcher.dispatch<ViewRoomPayload>({
            action: Action.ViewRoom,
            room_id: event.getRoomId()!,
            event_id: id,
            highlighted: true,
            scroll_into_view: true,
            metricsTrigger: undefined,
        });
        this.snapshot.merge({ activeId: id });
    };

    public close = (): void => this.props.onClose();

    public openSecuritySettings = (): void => {
        defaultDispatcher.dispatch({ action: Action.ViewUserSettings, initialTabId: UserTab.Security });
    };

    private async run(sort: DesktopSearchSort): Promise<void> {
        const { client, search } = this.props;
        const { query, scope } = search;
        const generation = ++this.generation;
        this.abort?.abort();
        const abort = (this.abort = new AbortController());
        this.hits = [];
        this.seen = new Set();
        this.events.clear();
        this.count = undefined;
        this.highlights = new Set(termsFromText(query.text));

        const text = query.text.trim();
        const browse = text === "";
        const encrypted = scope.roomIds.filter((roomId) => client.isRoomEncrypted(roomId));
        const index = this.deps.hasEventIndex();
        const plain = scope.roomIds.filter((roomId) => !encrypted.includes(roomId));
        const searchable = browse || index ? scope.roomIds : plain;
        // Synapse's estimate may include events excluded by sender or room filters.
        this.exactCount = !index && query.filters.length === 0;

        this.snapshot.merge({
            status: "loading",
            sort,
            sorts: browse ? ["recent"] : ["recent", "relevance"],
            groups: [],
            resultCount: 0,
            countIsLowerBound: false,
            hasMore: false,
            loadingMore: false,
            activeId: null,
            encryptedSkipped: !browse && !index && encrypted.length > 0,
            decryptionFailed: false,
        });

        if (searchable.length === 0) {
            this.source = undefined;
            this.snapshot.merge({ status: "ready" });
            return;
        }

        if (browse) {
            this.source = this.deps.createBrowseSource(client, searchable, abort.signal);
        } else {
            const serverRooms = index ? plain : searchable;
            const { senders, contains_url } = toRoomEventFilter(query.filters, serverRooms);
            const options: EventSearchOptions = {
                filter: { senders, contains_url },
                orderBy: sort === "relevance" ? SearchOrderBy.Rank : SearchOrderBy.Recent,
                roomIds: serverRooms.length > 0 ? serverRooms : undefined,
            };
            this.source = new TextSearchSource({
                client,
                term: text,
                roomId: searchable.length === 1 ? searchable[0] : undefined,
                options,
                signal: abort.signal,
                search: this.deps.search,
                paginate: this.deps.paginate,
            });
        }
        await this.fill(generation);
    }

    private isPinned = (roomId: string, eventId: string): boolean => {
        const pinned: unknown = this.props.client
            .getRoom(roomId)
            ?.currentState.getStateEvents(EventType.RoomPinnedEvents, "")
            ?.getContent().pinned;
        return Array.isArray(pinned) && pinned.includes(eventId);
    };

    /** Fetches pages until enough matches arrived, ignoring the answer if a newer search has started. */
    private async fill(generation: number): Promise<void> {
        const { filters } = this.props.search.query;
        const roomIds = this.props.search.scope.roomIds;
        let added = 0;
        let hasMore = false;
        // One request per page is enough unless filters applied here may discard most of what comes back.
        const maxFetches = isApproximate(filters) ? MAX_FETCHES : 1;
        try {
            for (let fetches = 0; fetches < maxFetches; fetches++) {
                const page: SearchSourcePage = await this.source!.next();
                if (generation !== this.generation) return;
                if (page.decryptionFailed) this.snapshot.merge({ decryptionFailed: true });
                for (const event of page.events) {
                    const id = event.getId();
                    if (!id || this.seen.has(id)) continue;
                    this.seen.add(id);
                    if (!matchesFilters(event, filters, roomIds, { isPinned: this.isPinned })) continue;
                    this.hits.push(event);
                    this.events.set(id, event);
                    added++;
                }
                page.highlights.forEach((word) => this.highlights.add(word));
                this.count = page.count;
                hasMore = page.hasMore;
                if (!hasMore || added >= PAGE_TARGET) break;
            }
        } catch {
            if (generation !== this.generation) return;
            if (this.hits.length === 0) this.snapshot.merge({ status: "error", loadingMore: false });
            else this.snapshot.merge({ loadingMore: false });
            return;
        }
        if (generation !== this.generation) return;
        this.publish(hasMore);
    }

    private publish(hasMore: boolean): void {
        const twelveHour = SettingsStore.getValue("showTwelveHourTimestamps");
        const terms = [...this.highlights];
        const groups = new Map<string, DesktopSearchResultGroup>();

        for (const event of this.hits) {
            const roomId = event.getRoomId()!;
            const room = this.props.client.getRoom(roomId);
            let group = groups.get(roomId);
            if (!group) {
                group = { roomId, roomName: room?.name ?? roomId, rows: [] };
                groups.set(roomId, group);
            }
            const content = event.getContent();
            const body = typeof content.body === "string" ? content.body : "";
            const isAttachment = ATTACHMENT_MSGTYPES.includes(String(content.msgtype));
            const senderId = event.getSender() ?? "";
            const date = new Date(event.getTs());
            const row: DesktopSearchResultRow = {
                id: event.getId()!,
                roomId,
                senderId,
                senderName: event.sender?.name ?? room?.getMember(senderId)?.name ?? senderId,
                timeLabel: formatDate(date, twelveHour),
                fullTimeLabel: formatFullDate(date, twelveHour),
                segments: highlightSegments(body, terms),
                attachmentName: isAttachment ? body : undefined,
            };
            group.rows.push(row);
        }

        const total = this.hits.length;
        const useServerCount = hasMore && this.exactCount && this.count !== undefined;
        this.snapshot.merge({
            status: "ready",
            groups: [...groups.values()],
            resultCount: useServerCount ? Math.max(total, this.count!) : total,
            countIsLowerBound: useServerCount ? false : hasMore,
            hasMore,
            loadingMore: false,
        });
    }
}
