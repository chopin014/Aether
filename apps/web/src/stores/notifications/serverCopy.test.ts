/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it, vi } from "vitest";
import { type MatrixClient, MatrixError, Method } from "matrix-js-sdk/src/matrix";

import { fetchPushRules, fetchRoomAccountData } from "./serverCopy";

function client(authedRequest: (...args: unknown[]) => Promise<unknown>): MatrixClient {
    return { getSafeUserId: () => "@me:example.org", http: { authedRequest: vi.fn(authedRequest) } } as never;
}

describe("serverCopy", () => {
    it("fetches the push rules", async () => {
        const cli = client(async () => ({ global: {} }));
        await expect(fetchPushRules(cli)).resolves.toEqual({ global: {} });
        expect(cli.http.authedRequest).toHaveBeenCalledWith(Method.Get, "/pushrules/", undefined, undefined, {
            localTimeoutMs: 30_000,
        });
    });

    it("fetches a room's account data", async () => {
        const cli = client(async () => ({ v: 1 }));
        await expect(fetchRoomAccountData(cli, "!room:example.org", "io.aether.mute")).resolves.toEqual({ v: 1 });
        expect(cli.http.authedRequest).toHaveBeenCalledWith(
            Method.Get,
            "/user/%40me%3Aexample.org/rooms/!room%3Aexample.org/account_data/io.aether.mute",
            undefined,
            undefined,
            { localTimeoutMs: 30_000 },
        );
    });

    it("reads missing account data as empty, and passes on other errors", async () => {
        const missing = client(async () => {
            throw new MatrixError({ errcode: "M_NOT_FOUND", error: "Not found" }, 404);
        });
        await expect(fetchRoomAccountData(missing, "!room:example.org", "io.aether.mute")).resolves.toEqual({});
        const offline = client(async () => {
            throw new Error("offline");
        });
        await expect(fetchRoomAccountData(offline, "!room:example.org", "io.aether.mute")).rejects.toThrow("offline");
    });
});
