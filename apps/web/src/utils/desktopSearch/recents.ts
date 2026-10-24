/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { isFilterKey, isSameQuery, type SearchFilter, type SearchQuery } from "./query";

const MAX_RECENTS = 10;

function storageKey(userId: string): string {
    return `mx_desktop_search_recents_${userId}`;
}

function isFilter(value: unknown): value is SearchFilter {
    const filter = value as Partial<SearchFilter> | null;
    return (
        !!filter &&
        typeof filter.key === "string" &&
        isFilterKey(filter.key) &&
        typeof filter.value === "string" &&
        (filter.label === undefined || typeof filter.label === "string")
    );
}

/** Recent searches, newest first. They are kept in local storage for this account only and never leave the device. */
export function loadRecentSearches(userId: string, storage: Storage = localStorage): SearchQuery[] {
    try {
        const parsed: unknown = JSON.parse(storage.getItem(storageKey(userId)) ?? "[]");
        if (!Array.isArray(parsed)) return [];
        return parsed
            .filter(
                (item): item is SearchQuery =>
                    typeof item?.text === "string" && Array.isArray(item.filters) && item.filters.every(isFilter),
            )
            .slice(0, MAX_RECENTS);
    } catch {
        return [];
    }
}

/** Adds a search to the front, moving it up when it was already there. */
export function addRecentSearch(userId: string, query: SearchQuery, storage: Storage = localStorage): SearchQuery[] {
    const entry: SearchQuery = { text: query.text.trim(), filters: query.filters };
    const next = [entry, ...loadRecentSearches(userId, storage).filter((recent) => !isSameQuery(recent, entry))].slice(
        0,
        MAX_RECENTS,
    );
    try {
        storage.setItem(storageKey(userId), JSON.stringify(next));
    } catch {
        // Storage can be full or blocked; recents are a convenience only.
    }
    return next;
}

export function clearRecentSearches(userId: string, storage: Storage = localStorage): void {
    try {
        storage.removeItem(storageKey(userId));
    } catch {
        // Nothing to clear if storage is unavailable.
    }
}
