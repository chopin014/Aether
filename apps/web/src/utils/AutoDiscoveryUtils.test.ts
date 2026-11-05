/*
Copyright 2024 New Vector Ltd.
Copyright 2023 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { vi, describe, it, expect, afterAll, beforeEach } from "vitest";
import { makeDelegatedAuthMetadata } from "test-utils/auth";
import { AutoDiscovery, AutoDiscoveryAction, type ClientConfig } from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";
import fetchMock from "@fetch-mock/vitest";

import AutoDiscoveryUtils from "./AutoDiscoveryUtils";

describe("AutoDiscoveryUtils", () => {
    beforeEach(() => {
        fetchMock.mockReset();
        fetchMock.catch({
            status: 404,
            body: '{"errcode": "M_UNRECOGNIZED", "error": "Unrecognized request"}',
            headers: { "content-type": "application/json" },
        });
    });

    describe("buildValidatedConfigFromDiscovery()", () => {
        const serverName = "my-server";

        beforeEach(() => {
            // don't litter console with expected errors
            vi.spyOn(logger, "error")
                .mockClear()
                .mockImplementation(() => {});
        });

        afterAll(() => {
            vi.spyOn(logger, "error").mockRestore();
        });

        const validIsConfig = {
            "m.identity_server": {
                state: AutoDiscoveryAction.SUCCESS,
                base_url: "identity.com",
            },
        };
        const validHsConfig = {
            "m.homeserver": {
                state: AutoDiscoveryAction.SUCCESS,
                base_url: "https://matrix.org",
            },
        };

        const expectedValidatedConfig = {
            hsName: serverName,
            hsNameIsDifferent: true,
            hsUrl: "https://matrix.org",
            isDefault: false,
            isNameResolvable: true,
            isUrl: "identity.com",
        };

        it("throws an error when discovery result is falsy", async () => {
            await expect(() =>
                AutoDiscoveryUtils.buildValidatedConfigFromDiscovery(serverName, undefined as any),
            ).rejects.toThrow("Unexpected error resolving homeserver configuration");
            expect(logger.error).toHaveBeenCalled();
        });

        it("throws an error when discovery result does not include homeserver config", async () => {
            const discoveryResult = {
                ...validIsConfig,
            } as unknown as ClientConfig;
            await expect(() =>
                AutoDiscoveryUtils.buildValidatedConfigFromDiscovery(serverName, discoveryResult),
            ).rejects.toThrow("Unexpected error resolving homeserver configuration");
            expect(logger.error).toHaveBeenCalled();
        });

        it("throws an error when identity server config has fail error and recognised error string", async () => {
            const discoveryResult = {
                ...validHsConfig,
                "m.identity_server": {
                    state: AutoDiscoveryAction.FAIL_ERROR,
                    error: "GenericFailure",
                },
            };
            await expect(() =>
                AutoDiscoveryUtils.buildValidatedConfigFromDiscovery(serverName, discoveryResult),
            ).rejects.toThrow("Unexpected error resolving identity server configuration");
            expect(logger.error).toHaveBeenCalled();
        });

        it("throws an error when homeserver config has fail error and recognised error string", async () => {
            const discoveryResult = {
                ...validIsConfig,
                "m.homeserver": {
                    state: AutoDiscoveryAction.FAIL_ERROR,
                    error: AutoDiscovery.ERROR_INVALID_HOMESERVER,
                },
            };
            await expect(() =>
                AutoDiscoveryUtils.buildValidatedConfigFromDiscovery(serverName, discoveryResult),
            ).rejects.toThrow("Homeserver URL does not appear to be a valid Matrix homeserver");
            expect(logger.error).toHaveBeenCalled();
        });

        it("throws an error with fallback message identity server config has fail error", async () => {
            const discoveryResult = {
                ...validHsConfig,
                "m.identity_server": {
                    state: AutoDiscoveryAction.FAIL_ERROR,
                },
            };
            await expect(() =>
                AutoDiscoveryUtils.buildValidatedConfigFromDiscovery(serverName, discoveryResult),
            ).rejects.toThrow("Unexpected error resolving identity server configuration");
        });

        it("throws an error when error is ERROR_INVALID_HOMESERVER", async () => {
            const discoveryResult = {
                ...validIsConfig,
                "m.homeserver": {
                    state: AutoDiscoveryAction.FAIL_ERROR,
                    error: AutoDiscovery.ERROR_INVALID_HOMESERVER,
                },
            };
            await expect(() =>
                AutoDiscoveryUtils.buildValidatedConfigFromDiscovery(serverName, discoveryResult),
            ).rejects.toThrow("Homeserver URL does not appear to be a valid Matrix homeserver");
        });

        it("throws an error when homeserver base_url is falsy", async () => {
            const discoveryResult = {
                ...validIsConfig,
                "m.homeserver": {
                    state: AutoDiscoveryAction.SUCCESS,
                    base_url: "",
                },
            };
            await expect(() =>
                AutoDiscoveryUtils.buildValidatedConfigFromDiscovery(serverName, discoveryResult),
            ).rejects.toThrow("Unexpected error resolving homeserver configuration");
            expect(logger.error).toHaveBeenCalledWith("No homeserver URL configured");
        });

        it("throws an error when homeserver base_url is not a valid URL", async () => {
            const discoveryResult = {
                ...validIsConfig,
                "m.homeserver": {
                    state: AutoDiscoveryAction.SUCCESS,
                    base_url: "banana",
                },
            };
            await expect(() =>
                AutoDiscoveryUtils.buildValidatedConfigFromDiscovery(serverName, discoveryResult),
            ).rejects.toThrow("Invalid URL");
        });

        it("uses hs url hostname when serverName is falsy in args and config", async () => {
            const discoveryResult = {
                ...validIsConfig,
                ...validHsConfig,
            };
            await expect(AutoDiscoveryUtils.buildValidatedConfigFromDiscovery("", discoveryResult)).resolves.toEqual({
                ...expectedValidatedConfig,
                hsNameIsDifferent: false,
                hsName: "matrix.org",
                warning: null,
            });
        });

        it("uses serverName from props", async () => {
            const discoveryResult = {
                ...validIsConfig,
                "m.homeserver": {
                    ...validHsConfig["m.homeserver"],
                    server_name: "should not use this name",
                },
            };
            const syntaxOnly = true;
            await expect(
                AutoDiscoveryUtils.buildValidatedConfigFromDiscovery(serverName, discoveryResult, syntaxOnly),
            ).resolves.toEqual({
                ...expectedValidatedConfig,
                hsNameIsDifferent: true,
                hsName: serverName,
                warning: null,
            });
        });

        it("ignores liveliness error when checking syntax only", async () => {
            const discoveryResult = {
                ...validIsConfig,
                "m.homeserver": {
                    ...validHsConfig["m.homeserver"],
                    state: AutoDiscoveryAction.FAIL_ERROR,
                    error: AutoDiscovery.ERROR_INVALID_HOMESERVER,
                },
            };
            const syntaxOnly = true;
            await expect(
                AutoDiscoveryUtils.buildValidatedConfigFromDiscovery(serverName, discoveryResult, syntaxOnly),
            ).resolves.toEqual({
                ...expectedValidatedConfig,
                warning: "Homeserver URL does not appear to be a valid Matrix homeserver",
            });
        });

        it("handles homeserver too old error", async () => {
            const discoveryResult: ClientConfig = {
                ...validIsConfig,
                "m.homeserver": {
                    state: AutoDiscoveryAction.FAIL_ERROR,
                    error: AutoDiscovery.ERROR_UNSUPPORTED_HOMESERVER_SPEC_VERSION,
                    base_url: "https://matrix.org",
                },
            };
            const syntaxOnly = true;
            await expect(() =>
                AutoDiscoveryUtils.buildValidatedConfigFromDiscovery(serverName, discoveryResult, syntaxOnly),
            ).rejects.toThrow(
                "Your homeserver is too old and does not support the minimum API version required. Please contact your account provider, or upgrade your server.",
            );
        });

        it("should validate delegated oidc auth", async () => {
            const issuer = "https://auth.matrix.org/";
            fetchMock.get(`${validHsConfig["m.homeserver"].base_url}/_matrix/client/versions`, { versions: ["v1.15"] });
            fetchMock.get(`${validHsConfig["m.homeserver"].base_url}/_matrix/client/v1/auth_metadata`, {
                ...makeDelegatedAuthMetadata(issuer),
                scopes_supported: ["email"],
                response_modes_supported: ["query", "fragment"],
                prompt_values_supported: ["none", "login", "create"],
                device_authorization_endpoint: `${issuer}oauth2/device`,
                account_management_uri: `${issuer}account/`,
                account_management_actions_supported: [
                    "org.matrix.profile",
                    "org.matrix.sessions_list",
                    "org.matrix.session_view",
                    "org.matrix.session_end",
                    "org.matrix.cross_signing_reset",
                ],
            });

            const discoveryResult = {
                ...validIsConfig,
                ...validHsConfig,
            };
            await expect(
                AutoDiscoveryUtils.buildValidatedConfigFromDiscovery(serverName, discoveryResult),
            ).resolves.toEqual({
                ...expectedValidatedConfig,
                hsNameIsDifferent: true,
                hsName: serverName,
                delegatedAuthentication: expect.objectContaining({
                    issuer,
                    account_management_actions_supported: [
                        "org.matrix.profile",
                        "org.matrix.sessions_list",
                        "org.matrix.session_view",
                        "org.matrix.session_end",
                        "org.matrix.cross_signing_reset",
                    ],
                    account_management_uri: "https://auth.matrix.org/account/",
                    authorization_endpoint: "https://auth.matrix.org/auth",
                    registration_endpoint: "https://auth.matrix.org/registration",
                    token_endpoint: "https://auth.matrix.org/token",
                }),
                warning: null,
            });
        });
    });

    describe("validateServerConfigWithStaticUrls", () => {
        const homeserver = "https://matrix.org";

        it("starts authentication metadata while server liveliness is still pending", async () => {
            const versions = Promise.withResolvers<{ versions: string[] }>();
            fetchMock.get(`${homeserver}/_matrix/client/versions`, () => versions.promise);
            fetchMock.get(`${homeserver}/_matrix/client/v1/auth_metadata`, {
                ...makeDelegatedAuthMetadata("https://auth.matrix.org/"),
            });
            const validating = AutoDiscoveryUtils.validateServerConfigWithStaticUrls(homeserver);
            await vi.waitFor(() => {
                expect(fetchMock.callHistory.called(`${homeserver}/_matrix/client/versions`)).toBe(true);
                expect(fetchMock.callHistory.called(`${homeserver}/_matrix/client/v1/auth_metadata`)).toBe(true);
            });
            versions.resolve({ versions: ["v1.13"] });
            expect((await validating).delegatedAuthentication?.issuer).toBe("https://auth.matrix.org/");
        });

        it("requests metadata from the normalized static homeserver URL", async () => {
            fetchMock.get(`${homeserver}/proxy/_matrix/client/versions`, { versions: ["v1.13"] });
            fetchMock.get(`${homeserver}/proxy/_matrix/client/v1/auth_metadata`, {
                ...makeDelegatedAuthMetadata("https://auth.matrix.org/"),
            });
            const config = await AutoDiscoveryUtils.validateServerConfigWithStaticUrls(
                `${homeserver}/proxy/?ignored=value#fragment`,
            );
            expect(config.hsUrl).toBe(`${homeserver}/proxy`);
            expect(config.delegatedAuthentication?.issuer).toBe("https://auth.matrix.org/");
            expect(fetchMock.callHistory.calls().map((call) => call.url)).toEqual(
                expect.arrayContaining([
                    `${homeserver}/proxy/_matrix/client/versions`,
                    `${homeserver}/proxy/_matrix/client/v1/auth_metadata`,
                ]),
            );
        });

        it("retains a fatal discovery error without waiting for pending authentication metadata", async () => {
            fetchMock.get(`${homeserver}/_matrix/client/versions`, { versions: ["r0.0.1"] });
            const metadata = Promise.withResolvers<object>();
            fetchMock.get(`${homeserver}/_matrix/client/v1/auth_metadata`, () => metadata.promise);
            try {
                await expect(AutoDiscoveryUtils.validateServerConfigWithStaticUrls(homeserver)).rejects.toThrow(
                    "Your homeserver is too old",
                );
            } finally {
                metadata.resolve({});
            }
        });

        it("treats unsupported OIDC as optional while retaining other metadata errors as warnings", async () => {
            fetchMock.get(`${homeserver}/_matrix/client/versions`, { versions: ["v1.13"] });
            expect((await AutoDiscoveryUtils.validateServerConfigWithStaticUrls(homeserver)).warning).toBeNull();
            fetchMock.get(`${homeserver}/_matrix/client/v1/auth_metadata`, {
                status: 400,
                body: { errcode: "M_UNKNOWN", error: "Unavailable" },
            });
            const config = await AutoDiscoveryUtils.validateServerConfigWithStaticUrls(homeserver);
            expect(config.hsUrl).toBe(homeserver);
            expect(config.warning).toBeInstanceOf(Error);
            expect(config.delegatedAuthentication).toBeUndefined();
        });
    });

    describe("authComponentStateForError", () => {
        const error = new Error("TEST");

        it("should return expected error for the registration page", () => {
            expect(AutoDiscoveryUtils.authComponentStateForError(error, "register")).toMatchSnapshot();
        });
    });
});
