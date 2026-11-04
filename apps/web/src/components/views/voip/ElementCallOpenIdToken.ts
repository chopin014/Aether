/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type IOpenIDToken, type MatrixClient } from "matrix-js-sdk/src/matrix";
import type { ElementCallOpenIdTokens } from "@element-hq/element-call-component";

/** A token is replaced this long before the homeserver says it expires, so a call never starts with a stale one. */
const OPENID_EXPIRY_MARGIN_MS = 60_000;
/** How long a token request in flight is shared, so a request that never answers cannot hold up later calls. */
const OPENID_PENDING_REUSE_MS = 10_000;
/** A join waits this long for a token still being fetched, then lets Element Call request its own. */
const JOIN_WAIT_MS = 2_000;

interface CachedOpenIdToken {
    token: Promise<IOpenIDToken>;
    expiresAt: number;
}

const openIdTokens = new WeakMap<MatrixClient, CachedOpenIdToken>();

/**
 * An OpenID token for authorizing the user's own calls, reused until shortly before it expires, so joining a call
 * does not wait for the homeserver to issue one. It is kept in memory only, per client, and Element Call sends it
 * only to the call service it chose for the user, where it would otherwise send a new token.
 */
export function getCallOpenIdToken(client: MatrixClient): Promise<IOpenIDToken> {
    const cached = openIdTokens.get(client);
    if (cached && cached.expiresAt > Date.now()) return cached.token;

    const requestedAt = Date.now();
    // Shared by everyone asking while the request is in flight.
    const entry: CachedOpenIdToken = {
        token: client.getOpenIdToken(),
        expiresAt: requestedAt + OPENID_PENDING_REUSE_MS,
    };
    openIdTokens.set(client, entry);
    entry.token.then(
        (token) => {
            const lifetimeMs = typeof token.expires_in === "number" ? token.expires_in * 1000 : 0;
            entry.expiresAt = requestedAt + lifetimeMs - OPENID_EXPIRY_MARGIN_MS;
        },
        () => {
            if (openIdTokens.get(client) === entry) openIdTokens.delete(client);
        },
    );
    return entry.token;
}

/**
 * What Element Call asks for when the user joins a call: the kept token, unless it is still being fetched after
 * {@link JOIN_WAIT_MS} or cannot be had, in which case Element Call requests one itself as it would without Aether.
 * A token the call service refused is forgotten, so the next join does not offer it again.
 */
export const elementCallOpenIdTokens: ElementCallOpenIdTokens = {
    get: (client) =>
        Promise.race([
            getCallOpenIdToken(client).catch(() => undefined),
            new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), JOIN_WAIT_MS)),
        ]),
    refused: (client, token) => {
        const entry = openIdTokens.get(client);
        entry?.token.then(
            (kept) => {
                if (kept === token && openIdTokens.get(client) === entry) openIdTokens.delete(client);
            },
            () => {},
        );
    },
};
