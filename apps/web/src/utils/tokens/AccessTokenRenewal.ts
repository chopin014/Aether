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

/** The shortest wait before renewing again after a refresh, so a very short-lived token cannot cause a storm. */
export const MIN_RENEWAL_GAP_MS = 5000;

/** How long handing the session to another instance waits for a refresh under way to store its tokens. */
export const SETTLE_TIMEOUT_MS = 5000;

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
 * Whether the session stored on this device is still the one a client belongs to. It is not once the user has
 * logged out, or logged in again as another session.
 * @param client - The client.
 */
export function isStoredSessionOf(client: MatrixClient): boolean {
    try {
        return (
            localStorage.getItem("mx_user_id") === client.getUserId() &&
            (localStorage.getItem("mx_device_id") ?? null) === client.getDeviceId()
        );
    } catch {
        return false;
    }
}

/**
 * Renews an OAuth2 session's access token before a request finds it expired. A token that has expired, or soon will,
 * is renewed at once, such as at start-up while the stores open. Otherwise it is renewed shortly before it expires:
 * a minute before, or halfway through the life of a token issued for less than two minutes. Each refresh, whether made
 * here or by a request, gives the next expiry through {@link noteExpiry}.
 *
 * A renewal that fails is not acted on: a request that then finds the token unknown refreshes it, or logs out, as
 * it would without this.
 */
export class AccessTokenRenewal {
    private static readonly byClient = new WeakMap<MatrixClient, AccessTokenRenewal>();

    private timer?: ReturnType<typeof setTimeout>;
    private started = false;
    private stopped = false;
    // The latest token's expiry, and how long it was issued for, once a refresh has reported them.
    private expiresAt?: number;
    private lifetime?: number;

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
        if (renewal.expiresAt !== undefined) {
            // A refresh already happened, and planned from the token it issued.
            renewal.plan(renewal.expiresAt, renewal.lifetime);
            return;
        }
        const expiresAt = getStoredAccessTokenExpiry();
        if (expiresAt !== undefined && expiresAt - RENEW_BEFORE_EXPIRY_MS <= Date.now()) {
            renewal.renew();
        } else {
            renewal.plan(expiresAt, undefined);
        }
    }

    /**
     * Wait, briefly, for a refresh under way to store its tokens, such as before handing the session to another
     * instance: a refresh replaces the refresh token, and the other instance must start from the new one.
     * @param client - The client.
     */
    public static async settle(client: MatrixClient | null): Promise<void> {
        if (!client || !AccessTokenRenewal.byClient.has(client)) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
            client.http.whenTokenRefreshSettled(),
            new Promise<void>((resolve) => (timer = setTimeout(resolve, SETTLE_TIMEOUT_MS))),
        ]);
        clearTimeout(timer);
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
        this.lifetime = this.expiresAt !== undefined ? this.expiresAt - Date.now() : undefined;
        if (this.started) this.plan(this.expiresAt, this.lifetime);
    }

    /**
     * Plan the renewal of a token expiring at `expiresAt`. It is called while the refresh that issued the token is
     * still finishing, so it never renews at once: renewing then would only join that refresh.
     */
    private plan(expiresAt: number | undefined, lifetime: number | undefined): void {
        clearTimeout(this.timer);
        this.timer = undefined;
        if (this.stopped || expiresAt === undefined) return;
        const margin = lifetime === undefined ? RENEW_BEFORE_EXPIRY_MS : Math.min(RENEW_BEFORE_EXPIRY_MS, lifetime / 2);
        const delay = Math.max(expiresAt - margin - Date.now(), MIN_RENEWAL_GAP_MS);
        // Checked again when it fires, as a computer that slept may have passed the renewal time.
        this.timer = setTimeout(
            () => {
                this.timer = undefined;
                if (expiresAt - margin - Date.now() > MIN_RENEWAL_GAP_MS) this.plan(expiresAt, lifetime);
                else this.renew();
            },
            Math.min(delay, MAX_TIMER_MS),
        );
    }

    private renew(): void {
        if (this.stopped) return;
        logger.debug("AccessTokenRenewal: renewing the access token before it expires");
        this.client.http.refreshAccessToken().then(
            (refreshed) => {
                if (!refreshed) {
                    logger.warn("AccessTokenRenewal: could not renew the access token ahead of time");
                    return;
                }
                // A renewal that joined a refresh already under way learns no expiry of its own, so nothing planned
                // the next one. It is planned from the latest token.
                if (this.started && this.timer === undefined) this.plan(this.expiresAt, this.lifetime);
            },
            (error) => logger.warn("AccessTokenRenewal: could not renew the access token ahead of time", error),
        );
    }
}
