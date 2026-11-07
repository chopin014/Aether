/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// @vitest-environment happy-dom

import { vi, describe, beforeEach, it, expect } from "vitest";
import { type MatrixClient, RoomNameType } from "matrix-js-sdk/src/matrix";
import { mockPlatformPeg } from "test-utils";

import { createClientWithCreds } from "./createMatrixClient";
import PlatformPeg from "../PlatformPeg";
import { persistTokens } from "./tokens/tokens.ts";
import {
    ACCESS_TOKEN_EXPIRY_STORAGE_KEY,
    AccessTokenRenewal,
    RENEW_BEFORE_EXPIRY_MS,
} from "./tokens/AccessTokenRenewal.ts";

vi.mock("./tokens/tokens.ts", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./tokens/tokens.ts")>()),
    persistTokens: vi.fn().mockResolvedValue(undefined),
}));

describe("createMatrixClient", () => {
    let client: MatrixClient;

    beforeEach(() => {
        vi.stubGlobal("localStorage", {
            getItem: vi.fn().mockReturnValue(null),
            setItem: vi.fn(),
            removeItem: vi.fn(),
        });

        client = createClientWithCreds({
            homeserverUrl: "https://test.dummy",
            userId: "@user:test.dummy",
            accessToken: "access_token",
        });
    });

    describe("room name generator", () => {
        it("should return empty room for an empty room", () => {
            const roomName = client.roomNameGenerator?.("", {
                type: RoomNameType.EmptyRoom,
            });
            expect(roomName).toBe("Empty room");
        });

        it("should include the old name for an empty room that used to have a name", () => {
            const roomName = client.roomNameGenerator?.("", {
                type: RoomNameType.EmptyRoom,
                oldName: "Old Room",
            });
            expect(roomName).toBe("Empty room (was Old Room)");
        });

        it("should return null for an actual room name", () => {
            const roomName = client.roomNameGenerator?.("", {
                type: RoomNameType.Actual,
                name: "Some name",
            });
            expect(roomName).toBeNull();
        });

        describe("generated room names", () => {
            it("should return empty room when there are no members", () => {
                const roomName = client.roomNameGenerator?.("", {
                    type: RoomNameType.Generated,
                    names: [],
                    count: 0,
                });
                expect(roomName).toBe("Empty room");
            });

            it("should return the single member name when there is only one other member", () => {
                const roomName = client.roomNameGenerator?.("", {
                    type: RoomNameType.Generated,
                    names: ["Alice"],
                    count: 2,
                });
                expect(roomName).toBe("Alice");
            });

            it("should join two member names with 'and'", () => {
                const roomName = client.roomNameGenerator?.("", {
                    type: RoomNameType.Generated,
                    names: ["Alice", "Bob"],
                    count: 2,
                });
                expect(roomName).toBe("Alice and Bob");
            });

            it("should name the first member and count the rest when there is one other member not named", () => {
                const roomName = client.roomNameGenerator?.("", {
                    type: RoomNameType.Generated,
                    names: ["Alice", "Bob"],
                    count: 3,
                });
                expect(roomName).toBe("Alice and one other");
            });

            it("should name the first member and count the rest when there are multiple members not named", () => {
                const roomName = client.roomNameGenerator?.("", {
                    type: RoomNameType.Generated,
                    names: ["Alice", "Bob", "Carol"],
                    count: 3,
                });
                expect(roomName).toBe("Alice and 2 others");
            });

            describe("when inviting", () => {
                it("should return empty room when there are no invitees", () => {
                    const roomName = client.roomNameGenerator?.("", {
                        type: RoomNameType.Generated,
                        subtype: "Inviting",
                        names: [],
                        count: 0,
                    });
                    expect(roomName).toBe("Empty room");
                });

                it("should return the single invitee name when there is only one invitee", () => {
                    const roomName = client.roomNameGenerator?.("", {
                        type: RoomNameType.Generated,
                        subtype: "Inviting",
                        names: ["Alice"],
                        count: 1,
                    });
                    expect(roomName).toBe("Alice");
                });

                it("should say who is being invited when there are two invitees", () => {
                    const roomName = client.roomNameGenerator?.("", {
                        type: RoomNameType.Generated,
                        subtype: "Inviting",
                        names: ["Alice", "Bob"],
                        count: 2,
                    });
                    expect(roomName).toBe("Inviting Alice and Bob");
                });

                it("should name the first invitee and count the rest when there are more than two invitees", () => {
                    const roomName = client.roomNameGenerator?.("", {
                        type: RoomNameType.Generated,
                        subtype: "Inviting",
                        names: ["Alice", "Bob", "Carol"],
                        count: 3,
                    });
                    expect(roomName).toBe("Inviting Alice and 2 others");
                });

                it("should count uninvited members separately from named invitees", () => {
                    const roomName = client.roomNameGenerator?.("", {
                        type: RoomNameType.Generated,
                        subtype: "Inviting",
                        names: ["Alice", "Bob"],
                        count: 4,
                    });
                    expect(roomName).toBe("Inviting Alice and 3 others");
                });
            });
        });
    });

    describe("oauth2ClientConfig", () => {
        beforeEach(() => {
            mockPlatformPeg();
            Object.defineProperty(PlatformPeg.get(), "getOAuthCallbackUrl", {
                value: () => new URL("https://test.dummy/oauth/callback"),
            });
        });

        it("should not be set when there is no refresh token", () => {
            client = createClientWithCreds({
                homeserverUrl: "https://test.dummy",
                userId: "@user:test.dummy",
                accessToken: "access_token",
            });

            expect(client.http.opts.oauth2ClientConfig).toBeUndefined();
        });

        it("should not be set when there is a refresh token but no stored OAuth2 client ID", () => {
            client = createClientWithCreds({
                homeserverUrl: "https://test.dummy",
                userId: "@user:test.dummy",
                accessToken: "access_token",
                refreshToken: "refresh_token",
            });

            expect(client.http.opts.oauth2ClientConfig).toBeUndefined();
        });

        it("should be set from the stored OAuth2 client ID when there is a refresh token", () => {
            client = createClientWithCreds(
                {
                    homeserverUrl: "https://test.dummy",
                    userId: "@user:test.dummy",
                    accessToken: "access_token",
                    refreshToken: "refresh_token",
                },
                "test-client-id",
            );

            expect(client.http.opts.oauth2ClientConfig).toEqual(
                expect.objectContaining({
                    clientId: "test-client-id",
                }),
            );
        });

        it("keeps refreshed tokens and their expiry, and renews them before they expire", async () => {
            vi.useFakeTimers();
            // The stored session is this client's.
            vi.mocked(localStorage.getItem).mockImplementation((key) =>
                key === "mx_user_id" ? "@user:test.dummy" : null,
            );
            try {
                client = createClientWithCreds(
                    {
                        homeserverUrl: "https://test.dummy",
                        userId: "@user:test.dummy",
                        accessToken: "access_token",
                        refreshToken: "refresh_token",
                        pickleKey: "pickle",
                    },
                    "test-client-id",
                );
                const refresh = vi.spyOn(client.http, "refreshAccessToken").mockResolvedValue(true);
                AccessTokenRenewal.start(client);
                const expiry = new Date(Date.now() + 5 * 60_000);
                const tokens = { accessToken: "new_access", refreshToken: "new_refresh", expiry };
                await client.http.opts.onTokenRefresh!(tokens);
                expect(persistTokens).toHaveBeenCalledWith("pickle", tokens);
                expect(localStorage.setItem).toHaveBeenCalledWith(
                    ACCESS_TOKEN_EXPIRY_STORAGE_KEY,
                    String(expiry.getTime()),
                );
                await vi.advanceTimersByTimeAsync(5 * 60_000 - RENEW_BEFORE_EXPIRY_MS);
                expect(refresh).toHaveBeenCalledOnce();
                AccessTokenRenewal.stop(client);
            } finally {
                vi.useRealTimers();
            }
        });

        it("does not store tokens refreshed after the session was replaced or ended", async () => {
            client = createClientWithCreds(
                {
                    homeserverUrl: "https://test.dummy",
                    userId: "@user:test.dummy",
                    accessToken: "access_token",
                    refreshToken: "refresh_token",
                },
                "test-client-id",
            );
            // Another session is stored now, such as after logging in again.
            vi.mocked(localStorage.getItem).mockImplementation((key) =>
                key === "mx_user_id" ? "@other:test.dummy" : null,
            );
            await client.http.opts.onTokenRefresh!({
                accessToken: "late_access",
                refreshToken: "late_refresh",
                expiry: new Date(Date.now() + 60_000),
            });
            expect(persistTokens).not.toHaveBeenCalled();
            expect(localStorage.setItem).not.toHaveBeenCalledWith(ACCESS_TOKEN_EXPIRY_STORAGE_KEY, expect.anything());
        });

        it("does not renew the tokens of a session that cannot refresh them", () => {
            vi.mocked(localStorage.getItem).mockReturnValue("0");
            client = createClientWithCreds({
                homeserverUrl: "https://test.dummy",
                userId: "@user:test.dummy",
                accessToken: "access_token",
                refreshToken: "refresh_token",
            });
            const refresh = vi.spyOn(client.http, "refreshAccessToken");
            AccessTokenRenewal.start(client);
            expect(refresh).not.toHaveBeenCalled();
        });
    });
});
