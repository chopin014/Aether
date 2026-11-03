/*
Copyright 2024 New Vector Ltd.
Copyright 2022 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { logger } from "matrix-js-sdk/src/logger";
import { type MatrixClient } from "matrix-js-sdk/src/matrix";
import fetchMock from "@fetch-mock/vitest";
import { advanceDateAndTime, stubClient, createTestClient } from "test-utils";

import { type IMatrixClientPeg, MatrixClientPeg as peg } from "./MatrixClientPeg";
import { presencePreferenceKey } from "./utils/presencePreference";
import SdkConfig from "./SdkConfig";
import { createClientWithCreds } from "./utils/createMatrixClient";
import * as StorageManager from "./utils/StorageManager";
import { SlidingSyncManager } from "./SlidingSyncManager";
import { LegacyCryptoStoreError } from "./utils/LegacyCryptoStoreError.ts";
import SettingsStore from "./settings/SettingsStore";

vi.useFakeTimers();

const PegClass = Object.getPrototypeOf(peg).constructor;

describe("MatrixClientPeg", () => {
    beforeEach(() => {
        // stub out Logger.log which gets called a lot and clutters up the test output
        vi.spyOn(logger, "log").mockImplementation(() => {});
    });

    afterEach(() => {
        localStorage.clear();
        window.location.hash = "";
        vi.restoreAllMocks();

        // some of the tests assign `MatrixClientPeg.matrixClient`: clear it, to prevent leakage between tests
        peg.unset();
    });

    it("setJustRegisteredUserId", () => {
        stubClient();
        (peg as any).matrixClient = peg.get();
        peg.setJustRegisteredUserId("@userId:matrix.org");
        expect(peg.safeGet().credentials.userId).toBe("@userId:matrix.org");
        expect(peg.currentUserIsJustRegistered()).toBe(true);
        expect(peg.userRegisteredWithinLastHours(0)).toBe(false);
        expect(peg.userRegisteredWithinLastHours(1)).toBe(true);
        expect(peg.userRegisteredWithinLastHours(24)).toBe(true);
        advanceDateAndTime(1 * 60 * 60 * 1000 + 1);
        expect(peg.userRegisteredWithinLastHours(0)).toBe(false);
        expect(peg.userRegisteredWithinLastHours(1)).toBe(false);
        expect(peg.userRegisteredWithinLastHours(24)).toBe(true);
        advanceDateAndTime(24 * 60 * 60 * 1000);
        expect(peg.userRegisteredWithinLastHours(0)).toBe(false);
        expect(peg.userRegisteredWithinLastHours(1)).toBe(false);
        expect(peg.userRegisteredWithinLastHours(24)).toBe(false);
    });

    it("setJustRegisteredUserId(null)", () => {
        stubClient();
        (peg as any).matrixClient = peg.get();
        peg.setJustRegisteredUserId(null);
        expect(peg.currentUserIsJustRegistered()).toBe(false);
        expect(peg.userRegisteredWithinLastHours(0)).toBe(false);
        expect(peg.userRegisteredWithinLastHours(1)).toBe(false);
        expect(peg.userRegisteredWithinLastHours(24)).toBe(false);
        advanceDateAndTime(1 * 60 * 60 * 1000 + 1);
        expect(peg.userRegisteredWithinLastHours(0)).toBe(false);
        expect(peg.userRegisteredWithinLastHours(1)).toBe(false);
        expect(peg.userRegisteredWithinLastHours(24)).toBe(false);
    });

    describe(".start", () => {
        let testPeg: IMatrixClientPeg;

        beforeEach(() => {
            // instantiate a MatrixClientPegClass instance, with a new MatrixClient
            testPeg = new PegClass();
            fetchMock.get("http://example.com/_matrix/client/versions", {});

            const mockClient = createTestClient();
            mockClient.initRustCrypto = vi.fn();
            mockClient.startClient = vi.fn();
            mockClient.setSyncPresence = vi.fn().mockResolvedValue(undefined);
            testPeg.set(mockClient as unknown as MatrixClient);
        });

        it("should apply saved invisible intent immediately after starting the SDK", async () => {
            const client = testPeg.safeGet();
            localStorage.setItem(presencePreferenceKey(client), "offline");
            await testPeg.start();
            expect(client.setSyncPresence).toHaveBeenCalledWith("offline");
            expect(vi.mocked(client.startClient).mock.invocationCallOrder[0]).toBeLessThan(
                vi.mocked(client.setSyncPresence).mock.invocationCallOrder[0],
            );
        });

        it.each([
            ["#/room/!target:example.org", "!target:example.org"],
            ["#/room/%21target%3Aexample.org/%24event?via=example.org", "!target:example.org"],
            ["", "!last:example.org"],
            ["#/", "!last:example.org"],
            ["#/home", undefined],
            ["#/room/%23alias%3Aexample.org", undefined],
        ])("prioritizes the startup destination for sliding sync at %s", async (route, expectedRoomId) => {
            window.location.hash = route;
            localStorage.setItem("mx_last_room_id", "!last:example.org");
            const getValue = SettingsStore.getValue.bind(SettingsStore);
            vi.spyOn(SettingsStore, "getValue").mockImplementation((name, ...args) => {
                if (name === "feature_simplified_sliding_sync") return true;
                return getValue(name, ...args);
            });
            const setup = vi.spyOn(SlidingSyncManager.instance, "setup").mockResolvedValue(undefined);
            await testPeg.start();
            expect(setup).toHaveBeenCalledWith(testPeg.safeGet(), expectedRoomId);
        });

        it("should initialise the rust crypto library by default", async () => {
            const mockInitRustCrypto = vi.spyOn(testPeg.safeGet(), "initRustCrypto").mockResolvedValue(undefined);

            const cryptoStoreKey = new Uint8Array([1, 2, 3, 4]);
            await testPeg.start({ rustCryptoStoreKey: cryptoStoreKey });
            expect(mockInitRustCrypto).toHaveBeenCalledWith({ storageKey: cryptoStoreKey });
        });

        it("should try to start dehydration if dehydration is enabled", async () => {
            const mockInitRustCrypto = vi.spyOn(testPeg.safeGet(), "initRustCrypto").mockResolvedValue(undefined);
            const mockStartDehydration = vi.fn();
            vi.spyOn(testPeg.safeGet(), "getCrypto").mockReturnValue({
                isDehydrationSupported: vi.fn().mockResolvedValue(true),
                startDehydration: mockStartDehydration,
                setDeviceIsolationMode: vi.fn(),
            } as any);
            vi.spyOn(testPeg.safeGet(), "waitForClientWellKnown").mockResolvedValue({
                "m.homeserver": {
                    base_url: "http://example.com",
                },
                "org.matrix.msc3814": true,
            } as any);

            const cryptoStoreKey = new Uint8Array([1, 2, 3, 4]);
            await testPeg.start({ rustCryptoStoreKey: cryptoStoreKey });
            expect(mockInitRustCrypto).toHaveBeenCalledWith({ storageKey: cryptoStoreKey });
            expect(mockStartDehydration).toHaveBeenCalledWith({ onlyIfKeyCached: true, rehydrate: false });
        });

        it("should start crypto while the sync store is still opening", async () => {
            const client = testPeg.safeGet();
            let openStore!: () => void;
            client.store.startup = vi.fn(() => new Promise<void>((resolve) => (openStore = resolve)));
            const mockInitRustCrypto = vi.spyOn(client, "initRustCrypto").mockResolvedValue(undefined);

            const starting = testPeg.start();
            await vi.waitFor(() => expect(mockInitRustCrypto).toHaveBeenCalled());
            expect(client.startClient).not.toHaveBeenCalled();

            openStore();
            await starting;
            expect(client.startClient).toHaveBeenCalled();
        });

        it("prefetches server versions while the sync store is opening without adding a startup gate", async () => {
            const client = testPeg.safeGet();
            const store = Promise.withResolvers<void>();
            client.store.startup = vi.fn().mockReturnValue(store.promise);
            const versions = vi.spyOn(client, "getVersions").mockReturnValue(new Promise(() => {}));
            const starting = testPeg.start();
            expect(versions).toHaveBeenCalledTimes(1);
            expect(client.startClient).not.toHaveBeenCalled();
            store.resolve();
            await starting;
            expect(client.startClient).toHaveBeenCalled();
        });

        it("handles a failed versions prefetch without aborting local startup", async () => {
            const error = new Error("Offline");
            vi.spyOn(testPeg.safeGet(), "getVersions").mockRejectedValueOnce(error);
            vi.spyOn(SlidingSyncManager.instance, "checkSupport").mockResolvedValue(undefined);
            const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
            await testPeg.start();
            expect(testPeg.safeGet().startClient).toHaveBeenCalled();
            expect(warn).toHaveBeenCalledWith("Unable to prefetch server versions; startup will retry", error);
        });

        it("should not wait for the server to answer about dehydration before syncing", async () => {
            vi.spyOn(testPeg.safeGet(), "initRustCrypto").mockResolvedValue(undefined);
            vi.spyOn(testPeg.safeGet(), "getCrypto").mockReturnValue({
                isDehydrationSupported: vi.fn().mockReturnValue(new Promise(() => {})),
                setDeviceIsolationMode: vi.fn(),
            } as any);

            await testPeg.start();
            expect(testPeg.safeGet().startClient).toHaveBeenCalled();
        });

        it("should initialise the rust crypto library for an existing login", async () => {
            const mockInitRustCrypto = vi.spyOn(testPeg.safeGet(), "initRustCrypto").mockResolvedValue(undefined);

            await testPeg.start();
            expect(mockInitRustCrypto).toHaveBeenCalledTimes(1);
        });

        it("should refuse to start a session which still has an unmigrated legacy crypto store", async () => {
            vi.spyOn(StorageManager, "hasUnmigratedLegacyCryptoStore").mockResolvedValue(true);
            const mockInitRustCrypto = vi.spyOn(testPeg.safeGet(), "initRustCrypto").mockResolvedValue(undefined);

            await expect(testPeg.start()).rejects.toThrow(LegacyCryptoStoreError);
            expect(mockInitRustCrypto).not.toHaveBeenCalled();
        });

        it("should poll the client well-known by default", async () => {
            vi.spyOn(testPeg.safeGet(), "initRustCrypto").mockResolvedValue(undefined);
            const startClient = vi.spyOn(testPeg.safeGet(), "startClient").mockResolvedValue(undefined);

            await testPeg.start();

            const opts = startClient.mock.calls[0][0];
            expect(opts?.clientWellKnownPollPeriod).toBe(2 * 60 * 60);
        });

        it("should not poll the client well-known when enable_client_well_known_lookups is false", async () => {
            const sdkConfigGet = SdkConfig.get;
            vi.spyOn(SdkConfig, "get").mockImplementation((key?: any, altCaseName?: string): any => {
                if (key === "enable_client_well_known_lookups") return false;
                return sdkConfigGet(key, altCaseName);
            });
            vi.spyOn(testPeg.safeGet(), "initRustCrypto").mockResolvedValue(undefined);
            const startClient = vi.spyOn(testPeg.safeGet(), "startClient").mockResolvedValue(undefined);

            await testPeg.start();

            const opts = startClient.mock.calls[0][0];
            expect(opts?.clientWellKnownPollPeriod).toBeUndefined();
        });

        describe("client well-known lookups", () => {
            const WELL_KNOWN_URL = "https://example.com/.well-known/matrix/client";

            beforeEach(() => {
                // Use a real MatrixClient and really start it: these tests exist to observe what the SDK
                // requests over the network, which mocking `startClient` (as above) cannot see. This is
                // what caught matrix-js-sdk fetching the well-known despite `clientWellKnownPollPeriod`
                // being unset.
                testPeg = new PegClass();
                testPeg.set(
                    createClientWithCreds({
                        homeserverUrl: "http://example.com",
                        userId: "@user:example.com",
                        deviceId: "DEVICE",
                        accessToken: "token",
                    }),
                );
                vi.spyOn(testPeg.safeGet(), "initRustCrypto").mockResolvedValue(undefined);
            });

            afterEach(() => {
                testPeg.get()?.stopClient();
                testPeg.unset();
            });

            async function requestedUrls(): Promise<string[]> {
                await fetchMock.callHistory.flush();
                return fetchMock.callHistory.calls().map((call) => call.url);
            }

            it("shares the prefetched versions request with the SDK startup", async () => {
                await testPeg.start();
                const urls = await requestedUrls();
                expect(urls.filter((url) => url.endsWith("/_matrix/client/versions"))).toHaveLength(1);
            });

            it("requests the client well-known on startup by default", async () => {
                await testPeg.start();

                expect(await requestedUrls()).toContain(WELL_KNOWN_URL);
            });

            it("never requests the client well-known when enable_client_well_known_lookups is false", async () => {
                const sdkConfigGet = SdkConfig.get;
                vi.spyOn(SdkConfig, "get").mockImplementation((key?: any, altCaseName?: string): any => {
                    if (key === "enable_client_well_known_lookups") return false;
                    return sdkConfigGet(key, altCaseName);
                });

                await testPeg.start();

                expect(await requestedUrls()).not.toContainEqual(expect.stringContaining("/.well-known/matrix/"));
            });
        });
    });
});
