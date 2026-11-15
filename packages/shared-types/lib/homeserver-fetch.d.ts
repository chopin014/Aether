/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/** A homeserver request the renderer hands to the desktop app's main process. */
export interface HomeserverFetchRequest {
    /** Names the request for {@link HomeserverFetchApi.abort}, unique per window. */
    id: string;
    url: string;
    method: string;
    headers: [string, string][];
    body?: string;
}

/** The answer to a {@link HomeserverFetchRequest}. */
export interface HomeserverFetchResponse {
    status: number;
    statusText: string;
    headers: [string, string][];
    body: ArrayBuffer | null;
}

/**
 * Sends homeserver requests from the desktop app's main process, which asks the server's CORS permission once per
 * origin rather than before nearly every request.
 */
export interface HomeserverFetchApi {
    fetch(request: HomeserverFetchRequest): Promise<HomeserverFetchResponse>;
    abort(id: string): void;
}
