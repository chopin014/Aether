/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type Session } from "electron";
import type { HomeserverFetchRequest, HomeserverFetchResponse } from "shared-types";

export const HOMESERVER_FETCH = "aether:homeserver-fetch";
export const HOMESERVER_FETCH_ABORT = "aether:homeserver-fetch-abort";

/**
 * How long a server's answer to a preflight is relied on for its whole origin. Chromium keeps it for 5 seconds per URL
 * unless the server says otherwise, which homeservers do not, so nearly every request paid for one.
 */
export const PREFLIGHT_POLICY_MS = 60 * 60_000;

const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH"]);
const SIMPLE_METHODS = new Set(["GET", "HEAD", "POST"]);
/** Headers a page may send without a preflight, with any value (Content-Type only with the values below). */
const SAFELISTED_HEADERS = new Set(["accept", "accept-language", "content-language"]);
const SIMPLE_CONTENT_TYPES = new Set(["application/x-www-form-urlencoded", "multipart/form-data", "text/plain"]);
/** Headers a page may not set; Chromium sets or forbids them. */
const FORBIDDEN_HEADERS = new Set([
    "accept-charset",
    "accept-encoding",
    "connection",
    "content-length",
    "cookie",
    "cookie2",
    "date",
    "dnt",
    "expect",
    "host",
    "keep-alive",
    "origin",
    "referer",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "via",
]);
/** Status codes a response cannot carry a body with. */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);
const MAX_BODY_LENGTH = 64 * 1024 * 1024;

/** What a server allowed the page to send it, learned from a preflight. */
interface OriginPolicy {
    methods: Set<string>;
    headers: Set<string>;
    expiresAt: number;
}

function isAllowedUrl(url: URL): boolean {
    if (url.protocol === "https:") return true;
    // A homeserver on this machine, as in development.
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

/** Whether the page could send this request without a preflight, by the Fetch standard's rules. */
function needsPreflight(method: string, headers: [string, string][]): boolean {
    if (!SIMPLE_METHODS.has(method)) return true;
    return headers.some(([name, value]) => {
        if (SAFELISTED_HEADERS.has(name)) return false;
        if (name === "content-type") return !SIMPLE_CONTENT_TYPES.has(value.split(";")[0].trim().toLowerCase());
        return true;
    });
}

function allowsOrigin(headers: Headers, requester: string): boolean {
    const allowed = headers.get("access-control-allow-origin");
    return allowed === "*" || allowed === requester;
}

function listHeader(headers: Headers, name: string): Set<string> {
    return new Set(
        (headers.get(name) ?? "")
            .split(",")
            .map((value) => value.trim().toLowerCase())
            .filter(Boolean),
    );
}

/**
 * Lets the renderer send requests to its homeserver without a CORS preflight before each one.
 *
 * A page that sends a homeserver anything but the simplest request (any write, and any request with an access token)
 * first asks the server whether it may, and Chromium keeps the answer for 5 seconds for that URL only, because
 * homeservers send no `Access-Control-Max-Age`. Every message sent, every sync poll and every call membership write
 * therefore waited a whole extra round trip: about 220 ms to matrix.org from Brazil.
 *
 * The main process sends such requests instead and keeps CORS's guarantees itself: it asks the server the same question,
 * with the page's origin, once per origin, method and set of headers, relies on the answer for
 * {@link PREFLIGHT_POLICY_MS}, and hands back only responses the server allows any page, or the app's, to read. It sends no cookies,
 * and only to HTTPS servers or this machine. The renderer can therefore read nothing it could not read anyway; it only
 * stops paying for asking again.
 */
export function setupHomeserverFetch(): void {
    const inFlight = new Map<string, AbortController>();
    const policies = new Map<string, OriginPolicy>();

    const policyKey = (requester: string, origin: string): string => `${requester} ${origin}`;
    const covered = (policy: OriginPolicy | undefined, method: string, names: string[]): boolean =>
        !!policy &&
        policy.expiresAt > Date.now() &&
        (SIMPLE_METHODS.has(method) || policy.methods.has(method.toLowerCase()) || policy.methods.has("*")) &&
        // A wildcard does not cover Authorization, which must be named (Fetch standard).
        names.every((name) => policy.headers.has(name) || (name !== "authorization" && policy.headers.has("*")));

    const preflight = async (
        session: Session,
        requester: string,
        url: URL,
        method: string,
        names: string[],
        signal: AbortSignal,
    ): Promise<void> => {
        const key = policyKey(requester, url.origin);
        if (covered(policies.get(key), method, names)) return;
        const response = await session.fetch(url.href, {
            method: "OPTIONS",
            headers: {
                "Origin": requester,
                "Access-Control-Request-Method": method,
                ...(names.length ? { "Access-Control-Request-Headers": names.join(",") } : {}),
            },
            credentials: "omit",
            signal,
        });
        await response.arrayBuffer().catch(() => undefined);
        const policy: OriginPolicy = {
            methods: listHeader(response.headers, "access-control-allow-methods"),
            headers: listHeader(response.headers, "access-control-allow-headers"),
            expiresAt: Date.now() + PREFLIGHT_POLICY_MS,
        };
        if (!response.ok || !allowsOrigin(response.headers, requester) || !covered(policy, method, names)) {
            throw new Error(`CORS preflight refused ${method} to ${url.origin}`);
        }
        policies.set(key, policy);
    };

    ipcMain.handle(
        HOMESERVER_FETCH,
        async (event: IpcMainInvokeEvent, request: HomeserverFetchRequest): Promise<HomeserverFetchResponse> => {
            // Only the app itself, not a frame it shows.
            if (event.senderFrame !== event.sender.mainFrame) throw new Error("Not available to this frame");
            const requester = event.senderFrame.origin;
            const url = new URL(request.url);
            const method = String(request.method).toUpperCase();
            if (!isAllowedUrl(url) || !METHODS.has(method)) throw new Error("Request not allowed");
            if (
                request.body !== undefined &&
                (typeof request.body !== "string" || request.body.length > MAX_BODY_LENGTH)
            ) {
                throw new Error("Request body not allowed");
            }
            const headers = request.headers
                .map(([name, value]): [string, string] => [String(name).toLowerCase(), String(value)])
                .filter(
                    ([name]) => !FORBIDDEN_HEADERS.has(name) && !name.startsWith("proxy-") && !name.startsWith("sec-"),
                );

            const key = `${event.sender.id} ${request.id}`;
            const controller = new AbortController();
            inFlight.get(key)?.abort();
            inFlight.set(key, controller);
            try {
                if (needsPreflight(method, headers)) {
                    const names = [...new Set(headers.map(([name]) => name))]
                        .filter((name) => !SAFELISTED_HEADERS.has(name))
                        .sort();
                    await preflight(event.sender.session, requester, url, method, names, controller.signal);
                }
                // Without the page's origin: with it, Chromium treats the request as the page's and asks the server
                // first again. The server's answer above, and the check below, stand in for that.
                const response = await event.sender.session.fetch(url.href, {
                    method,
                    headers,
                    body: request.body,
                    credentials: "omit",
                    signal: controller.signal,
                });
                if (!allowsOrigin(response.headers, requester)) {
                    throw new Error(`${url.origin} does not let ${requester} read its response`);
                }
                const body = NULL_BODY_STATUSES.has(response.status) ? null : await response.arrayBuffer();
                return {
                    status: response.status,
                    statusText: response.statusText,
                    headers: [...response.headers].filter(([name]) => name !== "set-cookie"),
                    body,
                };
            } finally {
                if (inFlight.get(key) === controller) inFlight.delete(key);
            }
        },
    );

    ipcMain.on(HOMESERVER_FETCH_ABORT, (event: IpcMainEvent, id: string) => {
        inFlight.get(`${event.sender.id} ${id}`)?.abort();
    });
}
