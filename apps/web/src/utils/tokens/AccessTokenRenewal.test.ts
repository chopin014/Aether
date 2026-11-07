/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type MatrixClient } from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";

import {
    ACCESS_TOKEN_EXPIRY_STORAGE_KEY,
    AccessTokenRenewal,
    getStoredAccessTokenExpiry,
    claimStoredSession,
    ownsStoredSession,
    MIN_RENEWAL_GAP_MS,
    persistAccessTokenExpiry,
    RENEW_BEFORE_EXPIRY_MS,
    SETTLE_TIMEOUT_MS,
} from "./AccessTokenRenewal";

const MINUTE = 60_000;

describe("AccessTokenRenewal", () => {
    let client: MatrixClient;
    let refreshAccessToken: ReturnType<typeof vi.fn<() => Promise<boolean>>>;
    let whenTokenRefreshSettled: ReturnType<typeof vi.fn<() => Promise<void>>>;

    beforeEach(() => {
        vi.useFakeTimers({ now: 1_000_000_000 });
        localStorage.clear();
        refreshAccessToken = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
        whenTokenRefreshSettled = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
        client = {
            http: { refreshAccessToken, whenTokenRefreshSettled },
            getUserId: () => "@alice:example.org",
            getDeviceId: () => "DEVICE",
        } as unknown as MatrixClient;
    });

    afterEach(() => {
        AccessTokenRenewal.stop(client);
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    describe("the stored expiry", () => {
        it("is kept and read back, and forgotten when a refresh gives none", () => {
            expect(getStoredAccessTokenExpiry()).toBeUndefined();
            persistAccessTokenExpiry(new Date(Date.now() + 5 * MINUTE));
            expect(localStorage.getItem(ACCESS_TOKEN_EXPIRY_STORAGE_KEY)).toBe(String(Date.now() + 5 * MINUTE));
            expect(getStoredAccessTokenExpiry()).toBe(Date.now() + 5 * MINUTE);
            persistAccessTokenExpiry(undefined);
            expect(getStoredAccessTokenExpiry()).toBeUndefined();
        });

        it("is ignored when it is not a time", () => {
            localStorage.setItem(ACCESS_TOKEN_EXPIRY_STORAGE_KEY, "soon");
            expect(getStoredAccessTokenExpiry()).toBeUndefined();
            persistAccessTokenExpiry(new Date(Number.NaN));
            expect(localStorage.getItem(ACCESS_TOKEN_EXPIRY_STORAGE_KEY)).toBeNull();
        });
    });

    it("renews a stored token that has expired as soon as it starts", () => {
        persistAccessTokenExpiry(new Date(Date.now() - MINUTE));
        AccessTokenRenewal.create(client);
        expect(refreshAccessToken).not.toHaveBeenCalled();
        AccessTokenRenewal.start(client);
        expect(refreshAccessToken).toHaveBeenCalledOnce();
        // Starting again does not renew twice.
        AccessTokenRenewal.start(client);
        expect(refreshAccessToken).toHaveBeenCalledOnce();
    });

    it("renews a token that expires within the margin as soon as it starts", () => {
        persistAccessTokenExpiry(new Date(Date.now() + RENEW_BEFORE_EXPIRY_MS - 1));
        AccessTokenRenewal.create(client);
        AccessTokenRenewal.start(client);
        expect(refreshAccessToken).toHaveBeenCalledOnce();
    });

    it("renews a valid token shortly before it expires, then each refreshed one", async () => {
        persistAccessTokenExpiry(new Date(Date.now() + 5 * MINUTE));
        const renewal = AccessTokenRenewal.create(client);
        AccessTokenRenewal.start(client);
        await vi.advanceTimersByTimeAsync(5 * MINUTE - RENEW_BEFORE_EXPIRY_MS - 1);
        expect(refreshAccessToken).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(refreshAccessToken).toHaveBeenCalledOnce();

        // The refresh reports the new token's expiry.
        renewal.noteExpiry(new Date(Date.now() + 5 * MINUTE));
        await vi.advanceTimersByTimeAsync(5 * MINUTE - RENEW_BEFORE_EXPIRY_MS);
        expect(refreshAccessToken).toHaveBeenCalledTimes(2);
    });

    it("plans from a refresh reported before it starts, over the stored expiry", async () => {
        persistAccessTokenExpiry(new Date(Date.now() - MINUTE));
        const renewal = AccessTokenRenewal.create(client);
        renewal.noteExpiry(new Date(Date.now() + 5 * MINUTE));
        expect(refreshAccessToken).not.toHaveBeenCalled();
        AccessTokenRenewal.start(client);
        expect(refreshAccessToken).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(5 * MINUTE - RENEW_BEFORE_EXPIRY_MS);
        expect(refreshAccessToken).toHaveBeenCalledOnce();
    });

    it("plans nothing when the expiry is not known", async () => {
        const renewal = AccessTokenRenewal.create(client);
        AccessTokenRenewal.start(client);
        renewal.noteExpiry(undefined);
        await vi.advanceTimersByTimeAsync(60 * MINUTE);
        expect(refreshAccessToken).not.toHaveBeenCalled();
    });

    it("does nothing for a client set up without renewal", () => {
        persistAccessTokenExpiry(new Date(Date.now() - MINUTE));
        AccessTokenRenewal.start(client);
        expect(refreshAccessToken).not.toHaveBeenCalled();
    });

    it("stops renewing when the client stops", async () => {
        persistAccessTokenExpiry(new Date(Date.now() + 5 * MINUTE));
        const renewal = AccessTokenRenewal.create(client);
        AccessTokenRenewal.start(client);
        AccessTokenRenewal.stop(client);
        await vi.advanceTimersByTimeAsync(10 * MINUTE);
        renewal.noteExpiry(new Date(Date.now() - MINUTE));
        AccessTokenRenewal.start(client);
        expect(refreshAccessToken).not.toHaveBeenCalled();
    });

    it("checks a renewal far away again rather than renewing when a long timer fires", async () => {
        const renewal = AccessTokenRenewal.create(client);
        AccessTokenRenewal.start(client);
        renewal.noteExpiry(new Date(Date.now() + 40 * 24 * 60 * MINUTE));
        // Browsers cap timers at about 24.8 days.
        await vi.advanceTimersByTimeAsync(2 ** 31);
        expect(refreshAccessToken).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(40 * 24 * 60 * MINUTE - 2 ** 31 - RENEW_BEFORE_EXPIRY_MS);
        expect(refreshAccessToken).toHaveBeenCalledOnce();
    });

    it("renews a short-lived token halfway through its life, after the refresh that issued it", async () => {
        const renewal = AccessTokenRenewal.create(client);
        // Each refresh issues a token for 30 seconds, and reports it while it is still finishing.
        refreshAccessToken.mockImplementation(async () => {
            renewal.noteExpiry(new Date(Date.now() + 30_000));
            return true;
        });
        AccessTokenRenewal.start(client);
        renewal.noteExpiry(new Date(Date.now() + 30_000));
        // Never at once: that would only join the refresh reporting the token.
        expect(refreshAccessToken).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(15_000);
        expect(refreshAccessToken).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(15_000);
        expect(refreshAccessToken).toHaveBeenCalledTimes(2);
    });

    it("plans the next renewal when it only joined a refresh already under way", async () => {
        const renewal = AccessTokenRenewal.create(client);
        AccessTokenRenewal.start(client);
        renewal.noteExpiry(new Date(Date.now() + 2 * MINUTE));
        // The refresh it joins reported its token before the renewal began, so it reports nothing more.
        await vi.advanceTimersByTimeAsync(MINUTE);
        expect(refreshAccessToken).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(MIN_RENEWAL_GAP_MS);
        expect(refreshAccessToken).toHaveBeenCalledTimes(2);
    });

    describe("settle", () => {
        it("waits for a refresh under way to store its tokens", async () => {
            const settled = Promise.withResolvers<void>();
            whenTokenRefreshSettled.mockReturnValue(settled.promise);
            AccessTokenRenewal.create(client);
            let done = false;
            const settling = AccessTokenRenewal.settle(client).then((result) => {
                done = true;
                return result;
            });
            await vi.advanceTimersByTimeAsync(SETTLE_TIMEOUT_MS - 1);
            expect(done).toBe(false);
            settled.resolve();
            await expect(settling).resolves.toBe(true);
        });

        it("gives up after a while, so handing the session over cannot hang", async () => {
            whenTokenRefreshSettled.mockReturnValue(new Promise(() => {}));
            AccessTokenRenewal.create(client);
            const settling = AccessTokenRenewal.settle(client);
            vi.spyOn(logger, "warn").mockImplementation(() => {});
            await vi.advanceTimersByTimeAsync(SETTLE_TIMEOUT_MS);
            // It says the wait ran out.
            await expect(settling).resolves.toBe(false);
        });

        it("has nothing to wait for without renewal", async () => {
            await AccessTokenRenewal.settle(client);
            await AccessTokenRenewal.settle(null);
            expect(whenTokenRefreshSettled).not.toHaveBeenCalled();
        });
    });

    it("lets a client store tokens only from claiming the stored session until it is released", () => {
        expect(ownsStoredSession(client)).toBe(false);
        claimStoredSession(client);
        expect(ownsStoredSession(client)).toBe(true);
        // Another client claiming it, such as after logging in again, takes it over.
        const other = { http: client.http } as unknown as MatrixClient;
        claimStoredSession(other);
        expect(ownsStoredSession(client)).toBe(false);
        AccessTokenRenewal.release(other);
        expect(ownsStoredSession(other)).toBe(false);
    });

    it("stops renewing when released", async () => {
        persistAccessTokenExpiry(new Date(Date.now() + 5 * MINUTE));
        AccessTokenRenewal.create(client);
        AccessTokenRenewal.start(client);
        claimStoredSession(client);
        AccessTokenRenewal.release(client);
        expect(ownsStoredSession(client)).toBe(false);
        await vi.advanceTimersByTimeAsync(10 * MINUTE);
        expect(refreshAccessToken).not.toHaveBeenCalled();
    });

    it("only warns when a renewal fails, leaving the next request to refresh", async () => {
        const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
        refreshAccessToken.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error("offline"));
        persistAccessTokenExpiry(new Date(Date.now() - MINUTE));
        const renewal = AccessTokenRenewal.create(client);
        AccessTokenRenewal.start(client);
        await vi.advanceTimersByTimeAsync(0);
        renewal.noteExpiry(new Date(Date.now()));
        await vi.advanceTimersByTimeAsync(MIN_RENEWAL_GAP_MS);
        expect(refreshAccessToken).toHaveBeenCalledTimes(2);
        expect(warn).toHaveBeenCalledTimes(2);
        // Nothing is tried again by itself.
        await vi.advanceTimersByTimeAsync(10 * MINUTE);
        expect(refreshAccessToken).toHaveBeenCalledTimes(2);
    });
});
