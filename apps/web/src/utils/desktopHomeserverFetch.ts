/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/** Status codes a response cannot carry a body with. */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

let nextId = 0;

function abortError(signal: AbortSignal): unknown {
    return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

/**
 * A `fetch` for the Matrix client that has the desktop app send requests to the homeserver, if the app can. Chromium
 * asks the homeserver's CORS permission before nearly every request a page sends it, keeping the answer for only 5
 * seconds per URL; the desktop app asks once per origin instead. Other requests, and bodies other than text (such as
 * uploads), keep using the page's own `fetch`. It behaves like `fetch` otherwise: a request that fails rejects with a
 * `TypeError`, and an aborted one with its signal's reason.
 *
 * @param baseUrl - The homeserver the client talks to.
 * @returns The `fetch` to give the client, or undefined outside the desktop app.
 */
export function desktopHomeserverFetch(baseUrl: string | undefined): typeof fetch | undefined {
    const bridge = typeof window === "undefined" ? undefined : window.electron?.homeserverFetch;
    if (!bridge || !baseUrl) return undefined;
    const origin = new URL(baseUrl).origin;
    return async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : undefined;
        const body = init.body;
        if (
            url === undefined ||
            new URL(url, location.href).origin !== origin ||
            (body !== undefined && body !== null && typeof body !== "string")
        ) {
            return fetch(input, init);
        }
        const signal = init.signal ?? undefined;
        if (signal?.aborted) throw abortError(signal);
        const id = String(++nextId);
        const onAbort = (): void => bridge.abort(id);
        signal?.addEventListener("abort", onAbort, { once: true });
        try {
            const response = await bridge.fetch({
                id,
                url: new URL(url, location.href).href,
                method: init.method ?? "GET",
                headers: [...new Headers(init.headers)],
                body: body ?? undefined,
            });
            return new Response(NULL_BODY_STATUSES.has(response.status) ? null : response.body, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
            });
        } catch (error) {
            if (signal?.aborted) throw abortError(signal);
            throw new TypeError("Failed to fetch", { cause: error });
        } finally {
            signal?.removeEventListener("abort", onAbort);
        }
    };
}
