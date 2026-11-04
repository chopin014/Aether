/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type IOpenIDToken, type MatrixClient } from "matrix-js-sdk/src/matrix";

function makeToken(accessToken: string, expiresIn = 3600): IOpenIDToken {
    return {
        access_token: accessToken,
        token_type: "Bearer",
        matrix_server_name: "example.org",
        expires_in: expiresIn,
    };
}

function makeClient(getOpenIdToken = vi.fn().mockResolvedValue(makeToken("token"))): MatrixClient {
    return { getOpenIdToken } as unknown as MatrixClient;
}

describe("getCallOpenIdToken", () => {
    let getCallOpenIdToken: typeof import("./ElementCallOpenIdToken").getCallOpenIdToken;
    let joinTokens: typeof import("./ElementCallOpenIdToken").elementCallOpenIdTokens;

    beforeEach(async () => {
        vi.useFakeTimers();
        vi.resetModules();
        ({ getCallOpenIdToken, elementCallOpenIdTokens: joinTokens } = await import("./ElementCallOpenIdToken"));
    });
    afterEach(() => vi.useRealTimers());

    it("reuses a token until shortly before it expires", async () => {
        const getOpenIdToken = vi
            .fn()
            .mockResolvedValueOnce(makeToken("first", 300))
            .mockResolvedValueOnce(makeToken("second", 300));
        const client = makeClient(getOpenIdToken);

        await expect(getCallOpenIdToken(client)).resolves.toMatchObject({ access_token: "first" });
        await vi.advanceTimersByTimeAsync(239_000);
        await expect(getCallOpenIdToken(client)).resolves.toMatchObject({ access_token: "first" });
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(getCallOpenIdToken(client)).resolves.toMatchObject({ access_token: "second" });
        expect(getOpenIdToken).toHaveBeenCalledTimes(2);
    });

    it("shares a request in flight and keeps tokens apart per client", async () => {
        const pending = Promise.withResolvers<IOpenIDToken>();
        const first = makeClient(vi.fn().mockReturnValue(pending.promise));
        const second = makeClient();

        const a = getCallOpenIdToken(first);
        expect(getCallOpenIdToken(first)).toBe(a);
        pending.resolve(makeToken("first"));
        await expect(a).resolves.toMatchObject({ access_token: "first" });
        await expect(getCallOpenIdToken(second)).resolves.toMatchObject({ access_token: "token" });
        expect(first.getOpenIdToken).toHaveBeenCalledOnce();
    });

    it("asks again after a failure or a request that never answers", async () => {
        const getOpenIdToken = vi
            .fn()
            .mockRejectedValueOnce(new Error("offline"))
            .mockReturnValueOnce(new Promise(() => {}))
            .mockResolvedValueOnce(makeToken("fresh"));
        const client = makeClient(getOpenIdToken);

        await expect(getCallOpenIdToken(client)).rejects.toThrow("offline");
        void getCallOpenIdToken(client);
        await vi.advanceTimersByTimeAsync(10_000);
        await expect(getCallOpenIdToken(client)).resolves.toMatchObject({ access_token: "fresh" });
        expect(getOpenIdToken).toHaveBeenCalledTimes(3);
    });

    it("does not keep a token without a lifetime", async () => {
        const getOpenIdToken = vi.fn().mockResolvedValue({ ...makeToken("token"), expires_in: undefined });
        const client = makeClient(getOpenIdToken);

        await getCallOpenIdToken(client);
        await getCallOpenIdToken(client);
        expect(getOpenIdToken).toHaveBeenCalledTimes(2);
    });

    describe("for a join", () => {
        it("offers the kept token", async () => {
            const client = makeClient();
            await expect(joinTokens.get(client)).resolves.toMatchObject({ access_token: "token" });
        });

        it("gives up on a token request that has stalled, so Element Call requests its own", async () => {
            const client = makeClient(vi.fn().mockReturnValue(new Promise(() => {})));
            const offered = joinTokens.get(client);
            await vi.advanceTimersByTimeAsync(2_000);
            await expect(offered).resolves.toBeUndefined();
        });

        it("offers nothing when no token can be had", async () => {
            const client = makeClient(vi.fn().mockRejectedValue(new Error("offline")));
            await expect(joinTokens.get(client)).resolves.toBeUndefined();
        });

        it("forgets a token the call service refused, but not a newer one", async () => {
            const getOpenIdToken = vi
                .fn()
                .mockResolvedValueOnce(makeToken("refused"))
                .mockResolvedValueOnce(makeToken("fresh"))
                .mockResolvedValueOnce(makeToken("unused"));
            const client = makeClient(getOpenIdToken);
            const refused = (await joinTokens.get(client))!;
            joinTokens.refused(client, refused);
            await vi.advanceTimersByTimeAsync(0);
            await expect(joinTokens.get(client)).resolves.toMatchObject({ access_token: "fresh" });

            // A late report about the old token leaves the newer one alone.
            joinTokens.refused(client, refused);
            await vi.advanceTimersByTimeAsync(0);
            await expect(joinTokens.get(client)).resolves.toMatchObject({ access_token: "fresh" });
            expect(getOpenIdToken).toHaveBeenCalledTimes(2);
        });
    });
});
