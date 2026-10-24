/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    Direction,
    Filter,
    type IRoomEventFilter,
    type ISearchResults,
    type MatrixClient,
    type MatrixEvent,
} from "matrix-js-sdk/src/matrix";

import { type EventSearchOptions } from "../../Searching";

/** One page of matching events, oldest page last. */
export interface SearchSourcePage {
    events: MatrixEvent[];
    hasMore: boolean;
    /** Total reported by the search backend, when it gives one. */
    count?: number;
    /** Words the backend matched, for highlighting. */
    highlights: string[];
}

/** Something that yields pages of results one after another. */
export interface SearchSource {
    next(): Promise<SearchSourcePage>;
}

export interface TextSearchDeps {
    client: MatrixClient;
    term: string;
    /** Set for a single room, so Element's encrypted-room path is used. */
    roomId?: string;
    options: EventSearchOptions;
    signal: AbortSignal;
    search: (
        client: MatrixClient,
        term: string,
        roomId?: string,
        signal?: AbortSignal,
        options?: EventSearchOptions,
    ) => Promise<ISearchResults>;
    paginate: (client: MatrixClient, results: ISearchResults) => Promise<ISearchResults>;
}

/** Element's own message search (`eventSearch`), including Seshat for encrypted rooms where it is enabled. */
export class TextSearchSource implements SearchSource {
    private results?: ISearchResults;
    private consumed = 0;

    public constructor(private readonly deps: TextSearchDeps) {}

    public async next(): Promise<SearchSourcePage> {
        const { client, term, roomId, options, signal, search, paginate } = this.deps;
        this.results = this.results
            ? await paginate(client, this.results)
            : await search(client, term, roomId, signal, options);
        const fresh = this.results.results.slice(this.consumed);
        this.consumed = this.results.results.length;
        return {
            events: fresh.map((result) => result.context.getEvent()),
            hasMore: !!this.results.next_batch,
            count: this.results.count,
            highlights: this.results.highlights,
        };
    }
}

interface RoomCursor {
    roomId: string;
    /** `undefined` before the first request, `null` once the start of the room is reached. */
    token: string | null | undefined;
    buffer: MatrixEvent[];
    done: boolean;
}

const MESSAGES_PER_REQUEST = 30;
const MAX_EMPTY_REQUESTS = 20;

/**
 * Lists events that match filters only (no search words). The search API needs a term, so this pages through each
 * room's history with a server-side `RoomEventFilter` and merges the rooms newest first. Unencrypted rooms only.
 */
export class BrowseSearchSource implements SearchSource {
    private readonly cursors: RoomCursor[];
    private readonly filter: Filter;

    public constructor(
        private readonly client: MatrixClient,
        roomIds: string[],
        filter: IRoomEventFilter,
        private readonly pageSize = 10,
        private readonly signal?: AbortSignal,
    ) {
        this.cursors = roomIds.map((roomId) => ({ roomId, token: undefined, buffer: [], done: false }));
        this.filter = new Filter(client.getSafeUserId());
        this.filter.setDefinition({
            room: {
                timeline: {
                    types: ["m.room.message"],
                    senders: filter.senders,
                    contains_url: filter.contains_url,
                },
            },
        });
    }

    private async fill(cursor: RoomCursor): Promise<void> {
        for (let attempt = 0; attempt < MAX_EMPTY_REQUESTS && !cursor.done && cursor.buffer.length === 0; attempt++) {
            if (this.signal?.aborted) return;
            const response = await this.client.createMessagesRequest(
                cursor.roomId,
                cursor.token ?? null,
                MESSAGES_PER_REQUEST,
                Direction.Backward,
                this.filter,
            );
            const mapper = this.client.getEventMapper();
            cursor.buffer = (response.chunk ?? []).map((raw) => mapper(raw));
            cursor.token = response.end ?? null;
            // Filtered requests can return an empty chunk with a token while older matches remain; only a missing token ends the room.
            if (!response.end) cursor.done = true;
        }
        // A room that keeps returning nothing after many requests is treated as exhausted.
        if (cursor.buffer.length === 0) cursor.done = true;
    }

    public async next(): Promise<SearchSourcePage> {
        const events: MatrixEvent[] = [];
        while (events.length < this.pageSize) {
            await Promise.all(this.cursors.filter((c) => !c.done && c.buffer.length === 0).map((c) => this.fill(c)));
            if (this.signal?.aborted) break;

            // Every room that is not exhausted has a buffered event now, so the newest of them is next overall.
            let newest: RoomCursor | undefined;
            for (const cursor of this.cursors) {
                if (!cursor.buffer.length) continue;
                if (!newest || cursor.buffer[0].getTs() > newest.buffer[0].getTs()) newest = cursor;
            }
            if (!newest) break;
            events.push(newest.buffer.shift()!);
        }
        return {
            events,
            hasMore: this.cursors.some((cursor) => !cursor.done || cursor.buffer.length > 0),
            highlights: [],
        };
    }
}
