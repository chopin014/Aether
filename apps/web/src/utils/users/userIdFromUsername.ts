/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// Characters a username may hold. Homeservers lower-case new usernames, so upper case is folded below.
const LOCALPART = /^[a-z0-9._=\-/+]+$/i;
const SERVER = /^[a-z0-9.-]+(?::\d{1,5})?$|^\[[0-9a-f:.]+\](?::\d{1,5})?$/i;

/**
 * Work out which account someone means when they type a username to find a person: "alice", "@alice" or
 * "alice:example.org". A username with no server is taken to live on the searcher's own homeserver, as on Discord
 * where a username alone is enough. The user directory only lists people who already share a room with the
 * searcher, so without this a friend's exact username finds nobody.
 *
 * @param term - what was typed.
 * @param ownServer - the searcher's homeserver name, such as "matrix.org".
 * @returns the user ID the term names, or null when it is not a username (an email address, a room address or text
 *     with spaces). A full user ID such as "@alice:example.org" is returned unchanged.
 */
export function userIdFromUsername(term: string, ownServer: string): string | null {
    const text = term.trim();
    if (!text || /\s/.test(text)) return null;

    const withoutSigil = text.startsWith("@") ? text.slice(1) : text;
    // Anything else holding "@" is an email address; "#" and "!" start room addresses.
    if (withoutSigil.includes("@") || /^[#!]/.test(withoutSigil)) return null;

    const colon = withoutSigil.indexOf(":");
    if (colon >= 0) {
        const localpart = withoutSigil.slice(0, colon);
        const server = withoutSigil.slice(colon + 1);
        if (!LOCALPART.test(localpart) || !SERVER.test(server)) return null;
        // A full user ID is kept as typed: older accounts may have upper-case letters.
        return text.startsWith("@") ? text : `@${localpart.toLowerCase()}:${server}`;
    }
    if (!LOCALPART.test(withoutSigil) || !ownServer) return null;
    return `@${withoutSigil.toLowerCase()}:${ownServer}`;
}
