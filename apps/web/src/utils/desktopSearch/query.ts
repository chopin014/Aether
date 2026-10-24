/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/** Filter keys understood by the desktop message search. */
export const SEARCH_FILTER_KEYS = [
    "from",
    "in",
    "has",
    "mentions",
    "before",
    "after",
    "during",
    "pinned",
    "bot",
] as const;

export type SearchFilterKey = (typeof SEARCH_FILTER_KEYS)[number];

/**
 * Values of `has:`. Polls, stickers and embeds are left out: Matrix servers only index text messages, so a search
 * could never return them.
 */
export const HAS_VALUES = ["link", "file", "image", "video", "sound"] as const;

export type HasValue = (typeof HAS_VALUES)[number];

/** A single accepted filter. `value` is canonical (user ID, room ID, `has` type, ISO date or `true`/`false`). */
export interface SearchFilter {
    key: SearchFilterKey;
    value: string;
    /** Human readable value shown in chips and used when writing the filter back as text. */
    label?: string;
}

/** A search as typed: free text plus accepted filters. */
export interface SearchQuery {
    text: string;
    filters: SearchFilter[];
}

/** Resolves a typed `from:`, `mentions:` or `in:` value (a name) to a canonical Matrix ID. */
export type FilterValueResolver = (key: SearchFilterKey, raw: string) => { value: string; label?: string } | null;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TOKEN = /([A-Za-z]+):("(?:[^"\\]|\\.)*"|[^\s"]*)|"(?:[^"\\]|\\.)*"|\S+/g;
const SINGLE_VALUED: ReadonlySet<SearchFilterKey> = new Set(["before", "after", "during", "pinned", "bot"]);

export function isFilterKey(key: string): key is SearchFilterKey {
    return (SEARCH_FILTER_KEYS as readonly string[]).includes(key);
}

/** Parses `YYYY-MM-DD` into the start of that local day, or `null` when it is not a real date. */
export function parseIsoDate(value: string): number | null {
    const match = ISO_DATE.exec(value);
    if (!match) return null;
    const [year, month, day] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
    const date = new Date(year, month, day);
    if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) return null;
    return date.getTime();
}

function unquoteValue(raw: string): string {
    if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
        return raw.slice(1, -1).replace(/\\(.)/g, "$1");
    }
    return raw;
}

/** Whether the value is valid for the key without needing a name lookup. */
function canonicalValue(key: SearchFilterKey, raw: string): string | null {
    switch (key) {
        case "has": {
            const value = raw.toLowerCase();
            return (HAS_VALUES as readonly string[]).includes(value) ? value : null;
        }
        case "pinned":
        case "bot": {
            const value = raw.toLowerCase();
            return value === "true" || value === "false" ? value : null;
        }
        case "before":
        case "after":
        case "during":
            return parseIsoDate(raw) === null ? null : raw;
        case "from":
        case "mentions":
            return /^@[^\s:]+:\S+$/.test(raw) ? raw : null;
        case "in":
            return /^[!#]\S+:\S+$/.test(raw) ? raw : null;
    }
}

/**
 * Splits typed text into accepted filters and free text. A `key:value` that cannot be understood (an unknown key, a
 * bad date, a name nobody matches) stays in the text so the user can keep editing it.
 */
export function parseQuery(input: string, resolve?: FilterValueResolver): SearchQuery {
    const filters: SearchFilter[] = [];
    const words: string[] = [];

    for (const match of input.matchAll(TOKEN)) {
        const [token, rawKey, rawValue] = match;
        const key = rawKey?.toLowerCase();
        if (!key || rawValue === undefined || !isFilterKey(key)) {
            words.push(token);
            continue;
        }

        const raw = unquoteValue(rawValue);
        let accepted: SearchFilter | null = null;
        const canonical = canonicalValue(key, raw);
        if (canonical !== null) {
            accepted = { key, value: canonical };
        } else {
            const resolved = resolve?.(key, raw);
            if (resolved) accepted = { key, value: resolved.value, label: resolved.label };
        }

        if (!accepted) {
            words.push(token);
        } else if (SINGLE_VALUED.has(key)) {
            const existing = filters.findIndex((filter) => filter.key === key);
            if (existing >= 0) filters.splice(existing, 1);
            filters.push(accepted);
        } else if (!filters.some((filter) => filter.key === key && filter.value === accepted.value)) {
            filters.push(accepted);
        }
    }

    return { text: words.join(" "), filters };
}

/** Stable identity of a filter, used for chip keys and de-duplication. */
export function filterId(filter: SearchFilter): string {
    return `${filter.key}:${filter.value}`;
}

/** Whether two queries ask for the same search. */
export function isSameQuery(a: SearchQuery, b: SearchQuery): boolean {
    if (a.text.trim() !== b.text.trim() || a.filters.length !== b.filters.length) return false;
    const ids = new Set(a.filters.map(filterId));
    return b.filters.every((filter) => ids.has(filterId(filter)));
}

/** Whether a query has anything to search for. */
export function isEmptyQuery(query: SearchQuery): boolean {
    return query.text.trim() === "" && query.filters.length === 0;
}

/**
 * The key being typed at the end of the input (`from:ali` gives `{ key: "from", partial: "ali" }`), used to drive
 * autocomplete. Returns `null` when the last word is not a known filter key.
 */
export function pendingFilter(input: string): { key: SearchFilterKey; partial: string; start: number } | null {
    const match = /(?:^|\s)([A-Za-z]+):("[^"]*|[^\s"]*)$/.exec(input);
    if (!match) return null;
    const key = match[1].toLowerCase();
    if (!isFilterKey(key)) return null;
    const start = match.index + match[0].length - match[1].length - 1 - match[2].length;
    return { key, partial: match[2].replace(/^"/, ""), start };
}
