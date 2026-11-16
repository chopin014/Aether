/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/** The URI scheme of Matrix links (spec appendix "Matrix URI scheme"), which matrix.to hands to installed apps. */
export const MATRIX_SCHEME = "matrix";

/** Longer arguments are not links a person clicked, and are ignored. */
const MAX_URI_LENGTH = 2048;
/** The spec caps every identifier at 255 bytes, sigil included. */
const MAX_ID_BYTES = 255;
const MAX_VIA = 10;

/** A Matrix link, reduced to the one place it can open in the app. */
export type MatrixLink =
    | { kind: "room"; roomIdOrAlias: string; eventId?: string; via: string[] }
    | { kind: "user"; userId: string };

// A DNS name, IPv4 address or bracketed IPv6 address, with an optional port.
const SERVER_NAME = /^(?:\[[0-9A-Fa-f:.]{2,45}\]|[A-Za-z0-9.-]{1,255})(?::\d{1,5})?$/;
// Opaque parts of room and event IDs: the characters every room version generates (base64 variants included).
const OPAQUE_ROOM = /^[A-Za-z0-9._~+=-]+$/;
const OPAQUE_EVENT = /^[A-Za-z0-9._~+=/-]+$/;
// Characters no identifier may hold: controls, whitespace and text direction overrides (which can disguise a name),
// plus those that would change how the app's route reads.
const FORBIDDEN = /[\p{Cc}\p{Zs}\p{Zl}\p{Zp}\u202A-\u202E\u2066-\u2069?#\\]/u;

function isServerName(value: string): boolean {
    return SERVER_NAME.test(value);
}

/** Splits `localpart:server` at the first colon, checking that both halves are usable. */
function splitServer(id: string): { localpart: string; server: string } | undefined {
    const colon = id.indexOf(":");
    if (colon <= 0) return undefined;
    const server = id.slice(colon + 1);
    return isServerName(server) ? { localpart: id.slice(0, colon), server } : undefined;
}

function isAcceptableId(id: string): boolean {
    return Buffer.byteLength(id, "utf8") <= MAX_ID_BYTES && !FORBIDDEN.test(id);
}

function parseAlias(withoutSigil: string): string | undefined {
    const parts = splitServer(withoutSigil);
    if (!parts || parts.localpart.includes("/")) return undefined;
    return `#${withoutSigil}`;
}

function parseUserId(withoutSigil: string): string | undefined {
    return splitServer(withoutSigil) ? `@${withoutSigil}` : undefined;
}

/** Room and event IDs are opaque, and since room version 12 a room ID has no server part. */
function parseOpaqueId(withoutSigil: string, sigil: "!" | "$", opaque: RegExp): string | undefined {
    const colon = withoutSigil.indexOf(":");
    const local = colon < 0 ? withoutSigil : withoutSigil.slice(0, colon);
    if (!local || !opaque.test(local)) return undefined;
    if (colon >= 0 && !isServerName(withoutSigil.slice(colon + 1))) return undefined;
    return `${sigil}${withoutSigil}`;
}

function decodeSegment(segment: string): string | undefined {
    try {
        const decoded = decodeURIComponent(segment);
        return decoded && isAcceptableId(decoded) ? decoded : undefined;
    } catch {
        return undefined;
    }
}

function parseVia(query: string): string[] {
    const via = new Set<string>();
    for (const server of new URLSearchParams(query).getAll("via")) {
        if (via.size >= MAX_VIA) break;
        if (isServerName(server)) via.add(server);
    }
    return [...via];
}

/**
 * Reads a `matrix:` URI, such as `matrix:r/aether:example.org?via=example.org`, given to the app from outside.
 *
 * Only what is needed to show a room, an event in a room, or a user is kept. Anything that would make the app act,
 * like `action=join` or `action=chat`, is dropped: opening a link only ever navigates, and the person then decides.
 * @returns the link, or undefined when the argument is not a well-formed Matrix link.
 */
export function parseMatrixUri(uri: string): MatrixLink | undefined {
    if (typeof uri !== "string" || uri.length > MAX_URI_LENGTH) return undefined;
    if (uri.slice(0, MATRIX_SCHEME.length + 1).toLowerCase() !== `${MATRIX_SCHEME}:`) return undefined;

    const rest = uri.slice(MATRIX_SCHEME.length + 1).split("#", 1)[0];
    // The authority part is reserved by the spec for future use, so a link that has one cannot be read yet.
    if (rest.startsWith("//")) return undefined;
    const queryStart = rest.indexOf("?");
    const path = queryStart < 0 ? rest : rest.slice(0, queryStart);
    const query = queryStart < 0 ? "" : rest.slice(queryStart + 1);

    const segments = path.split("/");
    if (segments.length !== 2 && segments.length !== 4) return undefined;
    const [type, rawId, subType, rawSubId] = segments;
    const id = decodeSegment(rawId);
    if (!id) return undefined;

    if (type === "u") {
        if (segments.length !== 2) return undefined;
        const userId = parseUserId(id);
        return userId ? { kind: "user", userId } : undefined;
    }

    let roomIdOrAlias: string | undefined;
    if (type === "r") roomIdOrAlias = parseAlias(id);
    else if (type === "roomid") roomIdOrAlias = parseOpaqueId(id, "!", OPAQUE_ROOM);
    if (!roomIdOrAlias) return undefined;

    let eventId: string | undefined;
    if (segments.length === 4) {
        const subId = subType === "e" ? decodeSegment(rawSubId) : undefined;
        eventId = subId ? parseOpaqueId(subId, "$", OPAQUE_EVENT) : undefined;
        if (!eventId) return undefined;
    }
    return { kind: "room", roomIdOrAlias, eventId, via: parseVia(query) };
}

/** The first command line argument that is a usable Matrix link, if any. */
export function findMatrixLink(args: readonly string[]): MatrixLink | undefined {
    for (const arg of args) {
        const link = parseMatrixUri(arg);
        if (link) return link;
    }
    return undefined;
}

/**
 * The app route that opens a link, as a URL fragment such as `#/room/%23aether%3Aexample.org?via=example.org`.
 * Identifiers are percent-encoded so that none of their characters can be read as part of the route.
 */
export function getMatrixLinkHash(link: MatrixLink): string {
    if (link.kind === "user") return `#/user/${encodeURIComponent(link.userId)}`;
    const event = link.eventId ? `/${encodeURIComponent(link.eventId)}` : "";
    const via = link.via.map((server) => `via=${encodeURIComponent(server)}`).join("&");
    return `#/room/${encodeURIComponent(link.roomIdOrAlias)}${event}${via ? `?${via}` : ""}`;
}
