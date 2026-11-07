/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type MatrixClient } from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";

/** Where the current access token's expiry is kept, in milliseconds since the epoch. It is not a secret. */
export const ACCESS_TOKEN_EXPIRY_STORAGE_KEY = "mx_access_token_expiry";

/** How long before an access token expires it is renewed, so that no request has to wait for a refresh. */
export const RENEW_BEFORE_EXPIRY_MS = 60_000;

// Browsers fire longer timeouts at once. A renewal further away is checked again after this long.
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Keep the expiry of refreshed tokens, or forget it when the server gave none.
 * @param expiry - When the new access token expires.
 */
export function persistAccessTokenExpiry(expiry: Date | undefined): void {
    try {
        if (expiry && Number.isFinite(expiry.getTime())) {
            localStorage.setItem(ACCESS_TOKEN_EXPIRY_STORAGE_KEY, String(expiry.getTime()));
        } else {
            localStorage.removeItem(ACCESS_TOKEN_EXPIRY_STORAGE_KEY);
        }
    } catch (error) {
        logger.warn("AccessTokenRenewal: could not keep the access token's expiry", error);
    }
}

/** When the stored access token expires, in milliseconds since the epoch, if known. */
export function getStoredAccessTokenExpiry(): number | undefined {
    try {
        const value = Number(localStorage.getItem(ACCESS_TOKEN_EXPIRY_STORAGE_KEY) ?? NaN);
        return Number.isFinite(value) ? value : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Renews an OAuth2 session's access token before a request finds it expired. A token that has expired, or soon will,
 * is renewed at once, such as at start-up while the stores open. Otherwise it is renewed shortly before it expires.
 * Each refresh, whether made here or by a request, gives the next expiry through {@link noteExpiry}.
 *
 * A renewal that fails is not acted on: a request that then finds the token unknown refreshes it, or logs out, as
 * it would without this.
 */
export class AccessTokenRenewal {
    private static readonly byClient = new WeakMap<MatrixClient, AccessTokenRenewal>();

    private timer?: ReturnType<typeof setTimeout>;
    private started = false;
    private stopped = false;
    private expiresAt?: number;

    private constructor(private readonly client: MatrixClient) {}

    /**
     * Set up renewal for a client whose session can refresh its tokens. It starts with {@link start}.
     * @param client - The client.
     * @returns The renewal, which must be told of each refresh through {@link noteExpiry}.
     */
    public static create(client: MatrixClient): AccessTokenRenewal {
        const renewal = new AccessTokenRenewal(client);
        AccessTokenRenewal.byClient.set(client, renewal);
        return renewal;
    }

    /**
     * Start renewing a client's access token, from the expiry stored for it. Does nothing for a client set up without
     * renewal, such as one whose session has no refresh token.
     *
     * Call it only once the session's tokens are stored. A refresh rotates the refresh token, and storing the old
     * tokens after it would leave one that no longer works.
     * @param client - The client.
     */
    public static start(client: MatrixClient): void {
        const renewal = AccessTokenRenewal.byClient.get(client);
        if (!renewal || renewal.started) return;
        renewal.started = true;
        renewal.plan(renewal.expiresAt ?? getStoredAccessTokenExpiry());
    }

    /**
     * Stop renewing a client's access token, such as when it is stopped or logged out.
     * @param client - The client.
     */
    public static stop(client: MatrixClient): void {
        const renewal = AccessTokenRenewal.byClient.get(client);
        if (!renewal) return;
        renewal.stopped = true;
        clearTimeout(renewal.timer);
        renewal.timer = undefined;
        AccessTokenRenewal.byClient.delete(client);
    }

    /**
     * Note the expiry of tokens just refreshed, and plan the next renewal.
     * @param expiry - When the new access token expires; undefined when the server did not say.
     */
    public noteExpiry(expiry: Date | undefined): void {
        const expiresAt = expiry?.getTime();
        this.expiresAt = expiresAt !== undefined && Number.isFinite(expiresAt) ? expiresAt : undefined;
        if (this.started) this.plan(this.expiresAt);
    }

    private plan(expiresAt: number | undefined): void {
        clearTimeout(this.timer);
        this.timer = undefined;
        if (this.stopped || expiresAt === undefined) return;
        const delay = expiresAt - RENEW_BEFORE_EXPIRY_MS - Date.now();
        if (delay <= 0) {
            this.renew();
            return;
        }
        // Checked again when it fires, as a computer that slept may have passed the renewal time.
        this.timer = setTimeout(() => this.plan(expiresAt), Math.min(delay, MAX_TIMER_MS));
    }

    private renew(): void {
        if (this.stopped) return;
        logger.debug("AccessTokenRenewal: renewing the access token before it expires");
        this.client.http.refreshAccessToken().then(
            (refreshed) => {
                if (!refreshed) logger.warn("AccessTokenRenewal: could not renew the access token ahead of time");
            },
            (error) => logger.warn("AccessTokenRenewal: could not renew the access token ahead of time", error),
        );
    }
}
