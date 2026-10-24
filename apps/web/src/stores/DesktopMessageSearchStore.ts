/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { TypedEventEmitter } from "matrix-js-sdk/src/matrix";

import { type SearchQuery } from "../utils/desktopSearch/query";
import { type ResolvedScope } from "../utils/desktopSearch/scope";

/** A search that is showing results. The scope is fixed when it starts so jumping to a result keeps it stable. */
export interface ActiveDesktopSearch {
    /** Changes whenever a search starts, so views can tell a new search from an update. */
    id: number;
    query: SearchQuery;
    scope: ResolvedScope;
}

export const DESKTOP_SEARCH_UPDATE = "update";

type EventMap = { [DESKTOP_SEARCH_UPDATE]: () => void };

/**
 * Shares the active desktop message search between the header box and the results column, which live in different
 * parts of the tree. It holds no Matrix state; the results model runs the search.
 */
export class DesktopMessageSearchStore extends TypedEventEmitter<typeof DESKTOP_SEARCH_UPDATE, EventMap> {
    public static readonly instance = new DesktopMessageSearchStore();

    private nextId = 1;
    private current: ActiveDesktopSearch | null = null;

    public get active(): ActiveDesktopSearch | null {
        return this.current;
    }

    public start(query: SearchQuery, scope: ResolvedScope): void {
        this.current = { id: this.nextId++, query, scope };
        this.emit(DESKTOP_SEARCH_UPDATE);
    }

    public close(): void {
        if (!this.current) return;
        this.current = null;
        this.emit(DESKTOP_SEARCH_UPDATE);
    }
}
