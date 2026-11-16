/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/** Embedded players that refuse to play without a Referer naming the app they are in. */
const EMBED_PREFIXES = ["https://www.youtube.com/embed/", "https://www.youtube-nocookie.com/embed/"];

/**
 * How Aether identifies itself to embedded players. YouTube asks apps that show its player outside a web page to
 * send their application ID as an https Referer; without one it shows error 153 instead of the video.
 */
export const APP_EMBED_REFERRER = "https://io.github.chopin014.aether/";

/**
 * Returns the headers for an embedded player's page with the app's Referer added, or undefined when the request is
 * not one, or already says where it comes from. Pages served from the app's own `vector://` scheme send none.
 */
export function withEmbedReferrer(url: string, headers: Record<string, string>): Record<string, string> | undefined {
    if (!EMBED_PREFIXES.some((prefix) => url.startsWith(prefix))) return;
    if (Object.keys(headers).some((name) => name.toLowerCase() === "referer")) return;
    return { ...headers, Referer: APP_EMBED_REFERRER };
}
