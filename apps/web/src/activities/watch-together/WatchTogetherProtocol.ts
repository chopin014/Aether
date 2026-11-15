/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/** The whole shared player, sent after every change and in answer to a sync request. */
export const WATCH_STATE = "io.aether.watch.state";
/** Sent by someone who just joined, so the people already watching tell them where the player is. */
export const WATCH_SYNC_REQUEST = "io.aether.watch.sync_request";

/** The call data transport drops larger packets on receipt, so a state must fit in this. */
export const WATCH_MAX_PAYLOAD_BYTES = 8000;
export const WATCH_MAX_ITEMS = 50;
/** Playback speeds offered to everyone; YouTube supports exactly these. */
export const WATCH_RATES: readonly number[] = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
/**
 * A new item starts this many seconds after it is chosen, so every player has time to load and they all start
 * together instead of the slowest one skipping the opening.
 */
export const WATCH_START_LEAD_SECONDS = 1.2;

const MAX_TITLE = 120;
const MAX_CHANNEL = 60;
const MAX_URL = 2048;
const MAX_ID = 64;
const MAX_POSITION = 7 * 24 * 3600;

/**
 * Where an item plays from: a YouTube video, an audio or video file any browser can play, or a video on any
 * website, which each person opens in the desktop app and plays on their own account.
 */
export type WatchSource = "youtube" | "media" | "site";

const SOURCES: readonly WatchSource[] = ["youtube", "media", "site"];

/** One video or song in the shared queue. */
export interface WatchItem {
    readonly id: string;
    readonly source: WatchSource;
    /** The YouTube video ID, or the https URL of the media file or web page. */
    readonly ref: string;
    readonly title?: string;
    /** The YouTube channel, or the site a file comes from. */
    readonly channel?: string;
    /** Where to start the first time this item plays, from a `t=` link parameter. */
    readonly start?: number;
    /** Matrix user ID of whoever added it. */
    readonly addedBy: string;
}

/**
 * The shared player. Everyone in the call holds a copy and the newest revision wins, so two people pressing pause
 * and next at the same moment end up agreeing everywhere. An empty queue means the activity was stopped; it is kept
 * so an older state still in flight cannot bring the activity back.
 */
export interface WatchState {
    /** Changes whenever a new activity starts, so leftovers of the previous one are recognisable. */
    readonly session: string;
    readonly revision: number;
    /** Matrix user ID of whoever made this revision. */
    readonly author: string;
    /** The app instance that made this revision; breaks ties between equal revisions, even from one user. */
    readonly origin: string;
    readonly items: readonly WatchItem[];
    readonly index: number;
    readonly playing: boolean;
    /**
     * Playback position in seconds when this state was made. Negative while a new item counts down to its start
     * (see {@link WATCH_START_LEAD_SECONDS}).
     */
    readonly position: number;
    readonly rate: number;
    /** The last item played to its end; adding another item starts it straight away. */
    readonly ended: boolean;
}

/** A message on the call data channel. */
export type WatchMessage = { type: typeof WATCH_STATE; state: WatchState } | { type: typeof WATCH_SYNC_REQUEST };

const isString = (value: unknown, max: number): value is string =>
    typeof value === "string" && value.length > 0 && value.length <= max;
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Checks that a YouTube video ID or media URL is one this app would have produced itself. */
export function isValidRef(source: WatchSource, ref: unknown): ref is string {
    if (source === "youtube") return typeof ref === "string" && /^[A-Za-z0-9_-]{11}$/.test(ref);
    if (!isString(ref, MAX_URL)) return false;
    try {
        return new URL(ref).protocol === "https:";
    } catch {
        return false;
    }
}

function parseItem(value: unknown): WatchItem | undefined {
    if (!value || typeof value !== "object") return;
    const item = value as Record<string, unknown>;
    if (!SOURCES.includes(item.source as WatchSource)) return;
    const source = item.source as WatchSource;
    if (!isString(item.id, MAX_ID) || !isString(item.addedBy, 255) || !isValidRef(source, item.ref)) return;
    if (item.title !== undefined && !isString(item.title, MAX_TITLE)) return;
    if (item.channel !== undefined && !isString(item.channel, MAX_CHANNEL)) return;
    if (item.start !== undefined && (!isFiniteNumber(item.start) || item.start < 0 || item.start > MAX_POSITION))
        return;
    return {
        id: item.id,
        source,
        ref: item.ref,
        addedBy: item.addedBy,
        ...(item.title !== undefined ? { title: item.title } : {}),
        ...(item.channel !== undefined ? { channel: item.channel } : {}),
        ...(item.start !== undefined ? { start: item.start } : {}),
    };
}

/** Rejects anything malformed or out of range; another participant's client is not trusted to be correct. */
export function parseState(value: unknown): WatchState | undefined {
    if (!value || typeof value !== "object") return;
    const state = value as Record<string, unknown>;
    if (!isString(state.session, MAX_ID) || !isString(state.author, 255) || !isString(state.origin, MAX_ID)) return;
    if (!Number.isSafeInteger(state.revision) || (state.revision as number) < 1) return;
    if (!Array.isArray(state.items) || state.items.length > WATCH_MAX_ITEMS) return;
    const items = state.items.map(parseItem);
    if (items.some((item) => !item) || new Set(items.map((item) => item!.id)).size !== items.length) return;
    if (typeof state.playing !== "boolean" || typeof state.ended !== "boolean") return;
    if (!isFiniteNumber(state.position) || state.position < -10 || state.position > MAX_POSITION) return;
    if (!isFiniteNumber(state.rate) || !WATCH_RATES.includes(state.rate)) return;
    const index = state.index;
    if (!Number.isSafeInteger(index)) return;
    if (items.length ? (index as number) < 0 || (index as number) >= items.length : index !== -1) return;
    return {
        session: state.session,
        revision: state.revision as number,
        author: state.author,
        origin: state.origin,
        items: items as WatchItem[],
        index: index as number,
        playing: state.playing,
        position: state.position,
        rate: state.rate,
        ended: state.ended,
    };
}

/** Decodes a call data packet, or returns undefined when it is not a valid Watch Together message. */
export function parseMessage(payload: Uint8Array): WatchMessage | undefined {
    if (payload.byteLength > WATCH_MAX_PAYLOAD_BYTES + 192) return;
    let message: unknown;
    try {
        message = JSON.parse(new TextDecoder().decode(payload));
    } catch {
        return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) return;
    const { type, state } = message as Record<string, unknown>;
    if (type === WATCH_SYNC_REQUEST) return { type };
    if (type !== WATCH_STATE) return;
    const parsed = parseState(state);
    return parsed && { type, state: parsed };
}

/** Encodes a message for the call data channel. */
export function encodeMessage(message: WatchMessage): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(message));
}

/** True when `a` should replace `b`: a higher revision, or the same revision from a later-sorting origin. */
export function isNewer(a: WatchState, b: WatchState): boolean {
    return a.revision > b.revision || (a.revision === b.revision && a.origin > b.origin);
}
