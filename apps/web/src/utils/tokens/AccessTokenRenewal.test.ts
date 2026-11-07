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
    persistAccessTokenExpiry,
    RENEW_BEFORE_EXPIRY_MS,
} from "./AccessTokenRenewal";

const MINUTE = 60_000;

describe("AccessTokenRenewal", () => {
    let client: MatrixClient;
    let refreshAccessToken: ReturnType<typeof vi.fn<() => Promise<boolean>>>;

    beforeEach(() => {
        vi.useFakeTimers({ now: 1_000_000_000 });
        localStorage.clear();
        refreshAccessToken = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
        client = { http: { refreshAccessToken } } as unknown as MatrixClient;
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

    it("only warns when a renewal fails, leaving the next request to refresh", async () => {
        const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
        refreshAccessToken.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error("offline"));
        persistAccessTokenExpiry(new Date(Date.now() - MINUTE));
        const renewal = AccessTokenRenewal.create(client);
        AccessTokenRenewal.start(client);
        await vi.advanceTimersByTimeAsync(0);
        renewal.noteExpiry(new Date(Date.now()));
        await vi.advanceTimersByTimeAsync(0);
        expect(refreshAccessToken).toHaveBeenCalledTimes(2);
        expect(warn).toHaveBeenCalledTimes(2);
        // Nothing is tried again by itself.
        await vi.advanceTimersByTimeAsync(10 * MINUTE);
        expect(refreshAccessToken).toHaveBeenCalledTimes(2);
    });
});
