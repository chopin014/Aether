/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type IRoomEventFilter, MsgType } from "matrix-js-sdk/src/matrix";

import { type HasValue, parseIsoDate, type SearchFilter, type SearchFilterKey } from "./query";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The parts of a Matrix event the filters read. `MatrixEvent` satisfies it. */
export interface SearchableEvent {
    getId(): string | undefined;
    getRoomId(): string | undefined;
    getSender(): string | null | undefined;
    getTs(): number;
    getContent(): Record<string, any>;
}

/** What the filters need to know about the world beyond the event itself. */
export interface FilterContext {
    isPinned(roomId: string, eventId: string): boolean;
}

const MEDIA_MSGTYPES: Record<Exclude<HasValue, "link">, string[]> = {
    file: [MsgType.File, MsgType.Image, MsgType.Video, MsgType.Audio],
    image: [MsgType.Image],
    video: [MsgType.Video],
    sound: [MsgType.Audio],
};

const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"]+/i;

function values(filters: SearchFilter[], key: SearchFilterKey): string[] {
    return filters.filter((filter) => filter.key === key).map((filter) => filter.value);
}

/** Time bounds in ms: `[min, max)` from `before:`, `after:` and `during:`. */
export function dateBounds(filters: SearchFilter[]): { min: number; max: number } {
    let min = -Infinity;
    let max = Infinity;
    for (const { key, value } of filters) {
        const start = parseIsoDate(value);
        if (start === null) continue;
        if (key === "before") max = Math.min(max, start);
        else if (key === "after") min = Math.max(min, start + DAY_MS);
        else if (key === "during") {
            min = Math.max(min, start);
            max = Math.min(max, start + DAY_MS);
        }
    }
    return { min, max };
}

/**
 * Builds the server-side part of a search. Only `from:`, `in:` and the attachment kinds of `has:` can narrow the
 * homeserver query; everything else is applied afterwards by {@link matchesFilters}.
 *
 * `has:` maps to `contains_url`, which Matrix defines as "the content has a `url` key". That is exactly what an
 * unencrypted attachment is. It is not what a link in the text is, so `has:link` stays client-side.
 *
 * @param scopeRoomIds the rooms to search, after `in:` narrowing
 */
export function toRoomEventFilter(filters: SearchFilter[], scopeRoomIds: string[]): IRoomEventFilter {
    const filter: IRoomEventFilter = { rooms: scopeRoomIds };
    const senders = values(filters, "from");
    if (senders.length) filter.senders = senders;
    if (values(filters, "has").some((value) => value !== "link")) filter.contains_url = true;
    return filter;
}

/**
 * Filters the homeserver cannot apply, which are checked on the results that come back. Searching with any of
 * these is approximate: pages may contain fewer matches than asked for and the total is unknown.
 */
export function clientSideKeys(filters: SearchFilter[]): SearchFilterKey[] {
    const keys = new Set<SearchFilterKey>();
    for (const { key, value } of filters) {
        if (key === "from" || key === "in") continue;
        if (key === "has" && value !== "link") keys.add("has"); // narrowed by contains_url, finished by msgtype
        else keys.add(key);
    }
    return [...keys];
}

/** Whether any accepted filter is applied on the client. */
export function isApproximate(filters: SearchFilter[]): boolean {
    return clientSideKeys(filters).length > 0;
}

function hasLink(content: Record<string, any>): boolean {
    const body = typeof content.body === "string" ? content.body : "";
    const formatted = typeof content.formatted_body === "string" ? content.formatted_body : "";
    return URL_PATTERN.test(body) || /<a\s[^>]*href=/i.test(formatted);
}

function mentions(content: Record<string, any>, userId: string): boolean {
    const mentioned: unknown = content["m.mentions"]?.user_ids;
    if (Array.isArray(mentioned) && mentioned.includes(userId)) return true;
    const body = typeof content.body === "string" ? content.body : "";
    const formatted = typeof content.formatted_body === "string" ? content.formatted_body : "";
    return (
        body.includes(userId) ||
        formatted.includes(`matrix.to/#/${userId}`) ||
        formatted.includes(`matrix.to/#/${encodeURIComponent(userId)}`)
    );
}

/** Whether the event satisfies every accepted filter. Room and sender filters are re-checked for local results. */
export function matchesFilters(
    event: SearchableEvent,
    filters: SearchFilter[],
    scopeRoomIds: string[] | undefined,
    context: FilterContext,
): boolean {
    const roomId = event.getRoomId();
    if (scopeRoomIds && (!roomId || !scopeRoomIds.includes(roomId))) return false;

    const senders = values(filters, "from");
    if (senders.length && !senders.includes(event.getSender() ?? "")) return false;

    const content = event.getContent();
    for (const has of values(filters, "has")) {
        if (has === "link") {
            if (!hasLink(content)) return false;
        } else if (!MEDIA_MSGTYPES[has as Exclude<HasValue, "link">]?.includes(content.msgtype)) return false;
    }

    for (const userId of values(filters, "mentions")) {
        if (!mentions(content, userId)) return false;
    }

    const { min, max } = dateBounds(filters);
    const ts = event.getTs();
    if (ts < min || ts >= max) return false;

    for (const wanted of values(filters, "pinned")) {
        const pinned = !!roomId && !!event.getId() && context.isPinned(roomId, event.getId()!);
        if (pinned !== (wanted === "true")) return false;
    }

    for (const wanted of values(filters, "bot")) {
        // Matrix bots send `m.notice`, the message type reserved for automated senders.
        if ((content.msgtype === MsgType.Notice) !== (wanted === "true")) return false;
    }

    return true;
}
