/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// Tests for the patched SDK's way to refresh an access token before a request needs it.

import { describe, expect, it, vi } from "vitest";
import {
    type AccessTokens,
    type MatrixClient,
    ClientPrefix,
    type HttpApiEvent,
    type HttpApiEventHandlerMap,
    MatrixHttpApi,
    Method,
    TypedEventEmitter,
    type ValidatedAuthMetadata,
} from "matrix-js-sdk/src/matrix";

import { AccessTokenRenewal } from "./AccessTokenRenewal";

const metadata = {
    issuer: "https://auth.example.org/",
    authorization_endpoint: "https://auth.example.org/authorize",
    token_endpoint: "https://auth.example.org/token",
    revocation_endpoint: "https://auth.example.org/revoke",
    registration_endpoint: "https://auth.example.org/register",
    code_challenge_methods_supported: ["S256"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    response_modes_supported: ["query", "fragment"],
    response_types_supported: ["code"],
} as unknown as ValidatedAuthMetadata;

function setup(
    withOAuth = true,
    onTokenRefresh?: (tokens: AccessTokens) => Promise<void>,
): {
    http: MatrixHttpApi<{ baseUrl: string; prefix: ClientPrefix; onlyData: true }>;
    calls: string[];
    refreshed: AccessTokens[];
    tokenResponse: PromiseWithResolvers<Response>;
} {
    const calls: string[] = [];
    const refreshed: AccessTokens[] = [];
    const tokenResponse = Promise.withResolvers<Response>();
    const fetchFn = vi.fn(async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
        const url = input instanceof Request ? input.url : input.toString();
        if (url === metadata.token_endpoint) {
            const body = init?.body instanceof URLSearchParams ? init.body : undefined;
            calls.push(`token ${body?.get("refresh_token")}`);
            return tokenResponse.promise;
        }
        const headers = new Headers(init?.headers);
        calls.push(`${new URL(url).pathname} ${headers.get("Authorization")}`);
        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const http = new MatrixHttpApi(new TypedEventEmitter<HttpApiEvent, HttpApiEventHandlerMap>(), {
        baseUrl: "https://matrix.example.org",
        prefix: ClientPrefix.V3,
        onlyData: true as const,
        accessToken: "old_access",
        refreshToken: "old_refresh",
        oauth2ClientConfig: withOAuth ? { clientId: "client", deviceId: "DEVICE" } : undefined,
        authMetadataCallback: async () => metadata,
        fetchFn,
        onTokenRefresh: async (tokens) => {
            refreshed.push(tokens);
            await onTokenRefresh?.(tokens);
        },
    });
    return { http, calls, refreshed, tokenResponse };
}

const tokens = (expiresIn = 300): Response =>
    new Response(
        JSON.stringify({
            access_token: "new_access",
            refresh_token: "new_refresh",
            token_type: "Bearer",
            expires_in: expiresIn,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
    );

describe("refreshing an access token ahead of time", () => {
    it("makes requests sent meanwhile wait for the new token, rather than fail with the old one", async () => {
        const { http, calls, refreshed, tokenResponse } = setup();
        const renewing = http.refreshAccessToken();
        const request = http.authedRequest(Method.Get, "/pushrules/");
        await vi.waitFor(() => expect(calls).toEqual(["token old_refresh"]));
        tokenResponse.resolve(tokens());
        await expect(renewing).resolves.toBe(true);
        await request;
        expect(calls).toEqual(["token old_refresh", "/_matrix/client/v3/pushrules/ Bearer new_access"]);
        expect(refreshed).toEqual([
            { accessToken: "new_access", refreshToken: "new_refresh", expiry: expect.any(Date) },
        ]);
    });

    it("leaves the token alone when the refresh fails, for requests to handle as before", async () => {
        const { http, calls, tokenResponse } = setup();
        const renewing = http.refreshAccessToken();
        tokenResponse.resolve(new Response("unavailable", { status: 503 }));
        await expect(renewing).resolves.toBe(false);
        await http.authedRequest(Method.Get, "/pushrules/");
        expect(calls.at(-1)).toBe("/_matrix/client/v3/pushrules/ Bearer old_access");
    });

    it("settles once a refresh under way has stored its tokens", async () => {
        const stored = Promise.withResolvers<void>();
        const { http, refreshed, tokenResponse } = setup(true, () => stored.promise);
        await http.whenTokenRefreshSettled();
        const renewing = http.refreshAccessToken();
        let settled = false;
        const settling = http.whenTokenRefreshSettled().then(() => (settled = true));
        tokenResponse.resolve(tokens());
        await vi.waitFor(() => expect(refreshed).toHaveLength(1));
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(settled).toBe(false);
        stored.resolve();
        await settling;
        await expect(renewing).resolves.toBe(true);
    });

    it("renews a 30 second token halfway through its life, after the refresh that issued it", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        try {
            const created: { renewal?: AccessTokenRenewal } = {};
            const { http, calls, tokenResponse } = setup(true, async (issued) =>
                created.renewal?.noteExpiry(issued.expiry),
            );
            const client = { http } as unknown as MatrixClient;
            created.renewal = AccessTokenRenewal.create(client);
            AccessTokenRenewal.start(client);
            const renewing = http.refreshAccessToken();
            tokenResponse.resolve(tokens(30));
            await renewing;
            expect(calls.filter((call) => call.startsWith("token"))).toHaveLength(1);
            await vi.advanceTimersByTimeAsync(14_000);
            expect(calls.filter((call) => call.startsWith("token"))).toHaveLength(1);
            await vi.advanceTimersByTimeAsync(1_000);
            expect(calls.filter((call) => call.startsWith("token"))).toEqual([
                "token old_refresh",
                "token new_refresh",
            ]);
            AccessTokenRenewal.stop(client);
        } finally {
            vi.useRealTimers();
        }
    });

    it("does nothing for a session that cannot refresh", async () => {
        const { http, calls } = setup(false);
        await expect(http.refreshAccessToken()).resolves.toBe(false);
        expect(calls).toEqual([]);
    });
});
