/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import type { WatchItem, WatchSource } from "./WatchTogetherProtocol";

/** A link the shared player can play, before it has an item ID or an author. */
export interface PlayableLink {
    readonly source: WatchSource;
    readonly ref: string;
    readonly start?: number;
}

/** Title and channel shown in the player and the queue. */
export interface PlayableMetadata {
    readonly title?: string;
    readonly channel?: string;
}

/** Why a link was refused before anyone tried to play it. */
export type PlayableLinkError = "unsupported" | "not_found" | "not_embeddable";

/** Thrown by {@link fetchMetadata} for a video YouTube will not play in an embedded player. */
export class PlayableLinkRefusedError extends Error {
    public constructor(public readonly reason: PlayableLinkError) {
        super(reason);
    }
}

const YOUTUBE_HOSTS = new Set([
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtube-nocookie.com",
    "www.youtube-nocookie.com",
]);
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const MEDIA_EXTENSIONS = /\.(mp4|m4v|webm|ogv|ogg|oga|mp3|m4a|aac|wav|flac|opus|mov)$/i;

/** Reads a YouTube `t=` value such as `90`, `90s` or `1h2m3s`. */
function parseStartTime(value: string | null): number | undefined {
    if (!value) return;
    if (/^\d+$/.test(value)) return Number(value) || undefined;
    const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value);
    if (!match || !match[0]) return;
    const seconds = Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
    return seconds || undefined;
}

function youTubeId(url: URL): string | undefined {
    const host = url.hostname.toLowerCase();
    if (host === "youtu.be") return url.pathname.split("/")[1];
    if (!YOUTUBE_HOSTS.has(host)) return;
    if (url.pathname === "/watch") return url.searchParams.get("v") ?? undefined;
    const [, kind, id] = url.pathname.split("/");
    if (kind === "shorts" || kind === "live" || kind === "embed" || kind === "v") return id;
}

/**
 * Recognises a link the shared player can play: any common form of YouTube video link, or an https link to an
 * audio or video file. Returns undefined for anything else, including text that merely contains a link.
 */
export function parsePlayableLink(text: string): PlayableLink | undefined {
    const trimmed = text.trim();
    if (!trimmed || /\s/.test(trimmed) || trimmed.length > 2048) return;
    let url: URL;
    try {
        url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`);
    } catch {
        return;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return;
    const id = youTubeId(url);
    if (id !== undefined) {
        if (!YOUTUBE_ID.test(id)) return;
        const start = parseStartTime(url.searchParams.get("t") ?? url.searchParams.get("start"));
        return { source: "youtube", ref: id, ...(start ? { start } : {}) };
    }
    if (url.protocol === "https:" && MEDIA_EXTENSIONS.test(url.pathname)) {
        url.hash = "";
        return { source: "media", ref: url.href };
    }
}

/** A YouTube thumbnail; image loads are allowed from anywhere by the app's content security policy. */
export function thumbnailUrl(item: Pick<WatchItem, "source" | "ref">): string | undefined {
    return item.source === "youtube" ? `https://i.ytimg.com/vi/${item.ref}/mqdefault.jpg` : undefined;
}

/** The address to open the item at its source, for "open on YouTube". */
export function sourceUrl(item: Pick<WatchItem, "source" | "ref">): string {
    return item.source === "youtube" ? `https://www.youtube.com/watch?v=${item.ref}` : item.ref;
}

const clip = (value: unknown, max: number): string | undefined =>
    typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;

/**
 * Looks up a title before the item is shared, so everyone's queue shows it without each client asking. YouTube's
 * oEmbed answers without credentials and allows any origin; a 401 or 403 there means the owner turned off
 * embedding, which is better reported now than as a black player for everyone.
 */
export async function fetchMetadata(
    link: PlayableLink,
    fetchFn: typeof fetch = fetch,
    signal?: AbortSignal,
): Promise<PlayableMetadata> {
    if (link.source === "media") {
        const url = new URL(link.ref);
        let name = url.pathname.split("/").pop() ?? "";
        try {
            name = decodeURIComponent(name);
        } catch {
            // Keep the raw name when it is not valid percent-encoding.
        }
        return { title: clip(name.replace(MEDIA_EXTENSIONS, ""), 120), channel: clip(url.hostname, 60) };
    }
    const watch = `https://www.youtube.com/watch?v=${link.ref}`;
    let response: Response;
    try {
        response = await fetchFn(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watch)}`, {
            credentials: "omit",
            referrerPolicy: "no-referrer",
            signal,
        });
    } catch (error) {
        if (signal?.aborted) throw error;
        // Offline or blocked: the player still knows the title once it loads.
        return {};
    }
    if (response.status === 401 || response.status === 403) throw new PlayableLinkRefusedError("not_embeddable");
    if (response.status === 404 || response.status === 400) throw new PlayableLinkRefusedError("not_found");
    if (!response.ok) return {};
    try {
        const body = (await response.json()) as Record<string, unknown>;
        return { title: clip(body.title, 120), channel: clip(body.author_name, 60) };
    } catch {
        return {};
    }
}
