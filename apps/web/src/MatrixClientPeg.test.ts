/*
Copyright 2024 New Vector Ltd.
Copyright 2022 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { logger } from "matrix-js-sdk/src/logger";
import { ClientEvent, MatrixError, type IPushRules, type MatrixClient } from "matrix-js-sdk/src/matrix";
import fetchMock from "@fetch-mock/vitest";
import { advanceDateAndTime, stubClient, createTestClient } from "test-utils";

import { type IMatrixClientPeg, MatrixClientPeg as peg } from "./MatrixClientPeg";
import { presencePreferenceKey } from "./utils/presencePreference";
import SdkConfig from "./SdkConfig";
import PlatformPeg from "./PlatformPeg";
import type BasePlatform from "./BasePlatform";
import { createClientWithCreds } from "./utils/createMatrixClient";
import { ACCESS_TOKEN_EXPIRY_STORAGE_KEY, AccessTokenRenewal } from "./utils/tokens/AccessTokenRenewal";
import * as StorageManager from "./utils/StorageManager";
import { SlidingSyncManager } from "./SlidingSyncManager";
import { LegacyCryptoStoreError } from "./utils/LegacyCryptoStoreError.ts";
import SettingsStore from "./settings/SettingsStore";
// These internal startup gates verify the SDK patch; neither class is exported by matrix.ts.
// oxlint-disable-next-line no-restricted-imports
import { SyncApi } from "matrix-js-sdk/src/sync";
// oxlint-disable-next-line no-restricted-imports
import { SlidingSyncSdk } from "matrix-js-sdk/src/sliding-sync-sdk";
import {
    ExtensionState,
    SlidingSync,
    SlidingSyncEvent,
    SlidingSyncState,
    type MSC3575SlidingSyncResponse,
} from "matrix-js-sdk/src/sliding-sync";

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
            // The server offers sliding sync, which tests turning it on rely on.
            mockClient.doesServerSupportUnstableFeature = vi.fn().mockResolvedValue(true);
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
            expect(setup).toHaveBeenCalledWith(
                testPeg.safeGet(),
                expectedRoomId,
                route === "#/home" ? { roomId: "!last:example.org", spaceId: undefined } : undefined,
            );
        });

        it.each([
            [
                "!space:example.org",
                "!channel:example.org",
                { roomId: "!channel:example.org", spaceId: "!space:example.org" },
            ],
            ["home", "!channel:example.org", { roomId: "!last:example.org", spaceId: undefined }],
            ["!space:example.org", "#alias:example.org", { roomId: undefined, spaceId: "!space:example.org" }],
        ])("prefetches the saved Home context without selecting it (%s, %s)", async (space, channel, expected) => {
            window.location.hash = "#/home";
            localStorage.setItem("mx_active_space", space);
            localStorage.setItem(`mx_space_context_${space}`, channel);
            localStorage.setItem("mx_last_room_id", "!last:example.org");
            const getValue = SettingsStore.getValue.bind(SettingsStore);
            vi.spyOn(SettingsStore, "getValue").mockImplementation((name, ...args) => {
                if (name === "feature_simplified_sliding_sync") return true;
                return getValue(name, ...args);
            });
            const setup = vi.spyOn(SlidingSyncManager.instance, "setup").mockResolvedValue(undefined);
            await testPeg.start();
            expect(setup).toHaveBeenCalledWith(testPeg.safeGet(), undefined, expected);
            expect(window.location.hash).toBe("#/home");
        });

        describe("with sliding sync turned on", () => {
            beforeEach(() => {
                const getValue = SettingsStore.getValue.bind(SettingsStore);
                vi.spyOn(SettingsStore, "getValue").mockImplementation((name, ...args) => {
                    if (name === "feature_simplified_sliding_sync") return true;
                    return getValue(name, ...args);
                });
            });

            it("uses regular sync where the server offers no sliding sync", async () => {
                vi.spyOn(SlidingSyncManager.instance, "serverOffersSlidingSync").mockResolvedValue(false);
                const setup = vi.spyOn(SlidingSyncManager.instance, "setup");
                const discard = vi.spyOn(SlidingSyncManager.instance, "discardPrefetchedSnapshot");
                const startClient = vi.spyOn(testPeg.safeGet(), "startClient").mockResolvedValue(undefined);
                await testPeg.start();
                expect(setup).not.toHaveBeenCalled();
                expect(startClient.mock.calls[0][0]?.slidingSync).toBeUndefined();
                // The saved rooms read while the stores opened are let go.
                expect(discard).toHaveBeenCalled();
            });

            it("decides at once from the answer kept from last time, and reloads if the server has since dropped it", async () => {
                // This device has rooms saved from sliding sync to show.
                vi.spyOn(SlidingSyncManager.instance, "hasPrefetchedSnapshot").mockResolvedValue(true);
                // The answer kept from last time, then the new one once the server has answered.
                vi.spyOn(SlidingSyncManager.instance, "knownServerSupport")
                    .mockReturnValueOnce(true)
                    .mockReturnValue(false);
                const answer = Promise.withResolvers<boolean | undefined>();
                vi.spyOn(SlidingSyncManager.instance, "serverOffersSlidingSync").mockReturnValue(answer.promise);
                const setup = vi.spyOn(SlidingSyncManager.instance, "setup").mockResolvedValue(undefined);
                vi.spyOn(SlidingSyncManager.instance, "isActiveFor").mockReturnValue(true);
                const reload = vi.fn();
                vi.spyOn(PlatformPeg, "get").mockReturnValue({ reload } as unknown as BasePlatform);
                // Starting does not wait for the server's answer.
                await testPeg.start();
                expect(setup).toHaveBeenCalledOnce();
                answer.resolve(false);
                await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
            });

            it("does not reload when the server's new answer could not be kept, which would reload every time", async () => {
                vi.spyOn(SlidingSyncManager.instance, "hasPrefetchedSnapshot").mockResolvedValue(true);
                // The old answer still reads back, as when storage is full.
                vi.spyOn(SlidingSyncManager.instance, "knownServerSupport").mockReturnValue(true);
                vi.spyOn(SlidingSyncManager.instance, "serverOffersSlidingSync").mockResolvedValue(false);
                vi.spyOn(SlidingSyncManager.instance, "setup").mockResolvedValue(undefined);
                vi.spyOn(SlidingSyncManager.instance, "isActiveFor").mockReturnValue(true);
                const reload = vi.fn();
                vi.spyOn(PlatformPeg, "get").mockReturnValue({ reload } as unknown as BasePlatform);
                await testPeg.start();
                for (let i = 0; i < 5; i++) await Promise.resolve();
                expect(reload).not.toHaveBeenCalled();
            });

            it("waits for the server, though it offered sliding sync before, where no rooms are saved from it", async () => {
                // Such as the first start after the switch to sliding sync, then offline: regular sync shows what it
                // saved, where sliding sync would show nothing.
                vi.spyOn(SlidingSyncManager.instance, "knownServerSupport").mockReturnValue(true);
                vi.spyOn(SlidingSyncManager.instance, "hasPrefetchedSnapshot").mockResolvedValue(false);
                vi.spyOn(SlidingSyncManager.instance, "serverOffersSlidingSync").mockResolvedValue(undefined);
                const setup = vi.spyOn(SlidingSyncManager.instance, "setup");
                await testPeg.start();
                expect(setup).not.toHaveBeenCalled();
            });

            it("uses regular sync for a while where sliding sync failed lately, though offered", async () => {
                vi.spyOn(SlidingSyncManager.instance, "isUnusable").mockReturnValue(true);
                const asked = vi.spyOn(SlidingSyncManager.instance, "serverOffersSlidingSync");
                const setup = vi.spyOn(SlidingSyncManager.instance, "setup");
                await testPeg.start();
                expect(setup).not.toHaveBeenCalled();
                expect(asked).not.toHaveBeenCalled();
            });

            it.each([
                ["reloads to regular sync", true],
                ["does not reload, which would happen every time, when that could not be kept", false],
            ])("%s when sliding sync fails on the server though offered", async (_, kept) => {
                vi.spyOn(SlidingSyncManager.instance, "serverOffersSlidingSync").mockResolvedValue(true);
                vi.spyOn(SlidingSyncManager.instance, "setup").mockResolvedValue(undefined);
                vi.spyOn(SlidingSyncManager.instance, "isActiveFor").mockReturnValue(true);
                const isUnusable = vi.spyOn(SlidingSyncManager.instance, "isUnusable").mockReturnValue(false);
                let fails: () => void = () => {};
                vi.spyOn(SlidingSyncManager.instance, "onUnusable").mockImplementation((listener) => {
                    fails = listener;
                    return () => {};
                });
                const reload = vi.fn();
                vi.spyOn(PlatformPeg, "get").mockReturnValue({ reload } as unknown as BasePlatform);
                await testPeg.start();
                expect(reload).not.toHaveBeenCalled();

                isUnusable.mockReturnValue(kept);
                fails();

                if (kept) await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
                for (let i = 0; i < 10; i++) await Promise.resolve();
                expect(reload).toHaveBeenCalledTimes(kept ? 1 : 0);
            });

            it("moves to regular sync only once a call has ended, as reloading would hang up on it", async () => {
                vi.spyOn(SlidingSyncManager.instance, "serverOffersSlidingSync").mockResolvedValue(true);
                vi.spyOn(SlidingSyncManager.instance, "setup").mockResolvedValue(undefined);
                vi.spyOn(SlidingSyncManager.instance, "isActiveFor").mockReturnValue(true);
                const isUnusable = vi.spyOn(SlidingSyncManager.instance, "isUnusable").mockReturnValue(false);
                let fails: () => void = () => {};
                vi.spyOn(SlidingSyncManager.instance, "onUnusable").mockImplementation((listener) => {
                    fails = listener;
                    return () => {};
                });
                const reload = vi.fn();
                vi.spyOn(PlatformPeg, "get").mockReturnValue({ reload } as unknown as BasePlatform);
                const { CallStore, CallStoreEvent } = await import("./stores/CallStore");
                const connected = new Set([{} as never]);
                vi.spyOn(CallStore.instance, "connectedCalls", "get").mockImplementation(() => connected);
                await testPeg.start();

                isUnusable.mockReturnValue(true);
                fails();
                // The call stores are loaded when it fails.
                await vi.dynamicImportSettled();
                for (let i = 0; i < 10; i++) await Promise.resolve();

                expect(reload).not.toHaveBeenCalled();

                connected.clear();
                CallStore.instance.emit(CallStoreEvent.ConnectedCalls, connected);
                await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
            });

            it("uses sliding sync where the server offers it", async () => {
                vi.spyOn(SlidingSyncManager.instance, "serverOffersSlidingSync").mockResolvedValue(true);
                const setup = vi.spyOn(SlidingSyncManager.instance, "setup").mockResolvedValue(undefined);
                await testPeg.start();
                expect(setup).toHaveBeenCalledOnce();
                expect(setup.mock.calls[0][0]).toBe(testPeg.safeGet());
            });

            it("uses sliding sync where the server cannot be asked, if this device has rooms saved from it", async () => {
                vi.spyOn(SlidingSyncManager.instance, "serverOffersSlidingSync").mockResolvedValue(undefined);
                vi.spyOn(SlidingSyncManager.instance, "hasPrefetchedSnapshot").mockResolvedValue(true);
                const setup = vi.spyOn(SlidingSyncManager.instance, "setup").mockResolvedValue(undefined);
                await testPeg.start();
                expect(setup).toHaveBeenCalledOnce();
            });

            it("uses regular sync where the server cannot be asked and nothing was saved from sliding sync", async () => {
                // Such as a first start while offline: a server without sliding sync must not leave the app unsynced.
                vi.spyOn(SlidingSyncManager.instance, "serverOffersSlidingSync").mockResolvedValue(undefined);
                vi.spyOn(SlidingSyncManager.instance, "hasPrefetchedSnapshot").mockResolvedValue(false);
                const setup = vi.spyOn(SlidingSyncManager.instance, "setup");
                const discard = vi.spyOn(SlidingSyncManager.instance, "discardPrefetchedSnapshot");
                const startClient = vi.spyOn(testPeg.safeGet(), "startClient").mockResolvedValue(undefined);
                await testPeg.start();
                expect(setup).not.toHaveBeenCalled();
                expect(startClient.mock.calls[0][0]?.slidingSync).toBeUndefined();
                expect(discard).toHaveBeenCalled();
            });
        });

        it("passes the rooms saved by the last sliding sync session to the client", async () => {
            const getValue = SettingsStore.getValue.bind(SettingsStore);
            vi.spyOn(SettingsStore, "getValue").mockImplementation((name, ...args) => {
                if (name === "feature_simplified_sliding_sync") return true;
                return getValue(name, ...args);
            });
            vi.spyOn(SlidingSyncManager.instance, "setup").mockResolvedValue(undefined);
            const loader = vi.fn(async () => null);
            const snapshotLoader = vi.spyOn(SlidingSyncManager.instance, "snapshotLoader").mockReturnValue(loader);
            const startClient = vi.spyOn(testPeg.safeGet(), "startClient").mockResolvedValue(undefined);
            // The saved rooms are read while the store and crypto open.
            const prefetch = vi.spyOn(SlidingSyncManager.instance, "prefetchSnapshot").mockReturnValue(undefined);
            const initCrypto = vi.spyOn(testPeg.safeGet(), "initRustCrypto").mockResolvedValue(undefined);
            await testPeg.start();
            expect(prefetch).toHaveBeenCalledWith(testPeg.safeGet());
            expect(prefetch.mock.invocationCallOrder[0]).toBeLessThan(initCrypto.mock.invocationCallOrder[0]);
            expect(snapshotLoader).toHaveBeenCalledWith(testPeg.safeGet());
            expect(startClient).toHaveBeenCalledWith(
                expect.objectContaining({
                    slidingSyncSnapshot: loader,
                    // What depends on every room works the saved rooms out once for each batch the SDK applies.
                    slidingSyncSavedRoomsBatch: SlidingSyncManager.instance.holdForSavedRooms,
                }),
            );
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

        it("renews an expired access token before the first requests, while the local store opens", async () => {
            const client = testPeg.safeGet();
            const store = Promise.withResolvers<void>();
            client.store.startup = vi.fn().mockReturnValue(store.promise);
            const order: string[] = [];
            const refreshAccessToken = vi.fn(async () => {
                order.push("renew");
                return true;
            });
            Object.assign(client, { http: { refreshAccessToken } });
            vi.spyOn(client, "getPushRules").mockImplementation(async () => {
                order.push("push rules");
                return { global: {} };
            });
            localStorage.setItem(ACCESS_TOKEN_EXPIRY_STORAGE_KEY, String(Date.now() - 1000));
            AccessTokenRenewal.create(client);
            try {
                const starting = testPeg.start();
                expect(order).toEqual(["renew", "push rules"]);
                expect(client.startClient).not.toHaveBeenCalled();
                store.resolve();
                await starting;
            } finally {
                AccessTokenRenewal.stop(client);
                localStorage.removeItem(ACCESS_TOKEN_EXPIRY_STORAGE_KEY);
            }
        });

        it("fetches push rules while the local store opens and passes the pending result to sync", async () => {
            const client = testPeg.safeGet();
            const store = Promise.withResolvers<void>();
            client.store.startup = vi.fn().mockReturnValue(store.promise);
            const rules = { global: {} };
            const getPushRules = vi.spyOn(client, "getPushRules").mockResolvedValue(rules);
            const starting = testPeg.start();
            expect(getPushRules).toHaveBeenCalledOnce();
            expect(client.startClient).not.toHaveBeenCalled();
            store.resolve();
            await starting;
            const opts = vi.mocked(client.startClient).mock.calls[0][0]!;
            expect(opts.initialPushRules).toBeUndefined();
            await expect(opts.initialPushRulesPromise).resolves.toBe(rules);
        });

        it("starts regular sync while a push rules request is still pending", async () => {
            const client = testPeg.safeGet();
            // A homeserver that accepts the request but never answers must not hold cached startup.
            vi.spyOn(client, "getPushRules").mockReturnValue(new Promise(() => {}));
            await testPeg.start();
            expect(client.startClient).toHaveBeenCalledWith(
                expect.objectContaining({ initialPushRulesPromise: expect.any(Promise) }),
            );
        });

        it("passes pending push rules to native sync after the store and crypto are ready", async () => {
            const client = testPeg.safeGet();
            const store = Promise.withResolvers<void>();
            const crypto = Promise.withResolvers<void>();
            const rules = Promise.withResolvers<IPushRules>();
            client.store.startup = vi.fn().mockReturnValue(store.promise);
            vi.spyOn(client, "initRustCrypto").mockReturnValue(crypto.promise);
            vi.spyOn(client, "getPushRules").mockReturnValue(rules.promise);
            const getValue = SettingsStore.getValue.bind(SettingsStore);
            vi.spyOn(SettingsStore, "getValue").mockImplementation((name, ...args) => {
                if (name === "feature_simplified_sliding_sync") return true;
                return getValue(name, ...args);
            });
            vi.spyOn(SlidingSyncManager.instance, "setup").mockResolvedValue(undefined);

            const starting = testPeg.start();
            store.resolve();
            await vi.waitFor(() => expect(client.initRustCrypto).toHaveBeenCalled());
            expect(client.startClient).not.toHaveBeenCalled();
            crypto.resolve();
            await starting;

            const opts = vi.mocked(client.startClient).mock.calls[0][0]!;
            expect(opts.initialPushRules).toBeUndefined();
            expect(opts.initialPushRulesPromise).toBeInstanceOf(Promise);
            rules.resolve({ global: {} });
            await expect(opts.initialPushRulesPromise).resolves.toEqual({ global: {} });
        });

        it("leaves failed push-rule prefetches to the SDK retry path", async () => {
            vi.spyOn(testPeg.safeGet(), "getPushRules").mockRejectedValueOnce(new Error("Offline"));
            await testPeg.start();
            const opts = vi.mocked(testPeg.safeGet().startClient).mock.calls[0][0]!;
            await expect(opts.initialPushRulesPromise).resolves.toBeUndefined();
        });

        it("does not fetch push rules for a guest", async () => {
            vi.spyOn(testPeg.safeGet(), "isGuest").mockReturnValue(true);
            const getPushRules = vi.spyOn(testPeg.safeGet(), "getPushRules");
            await testPeg.start();
            expect(getPushRules).not.toHaveBeenCalled();
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

    describe("native SDK transport before push rules", () => {
        const roomId = "!large:example.com";
        const rules: IPushRules = { global: {} };
        const response: MSC3575SlidingSyncResponse = {
            pos: "first",
            lists: {},
            rooms: {
                [roomId]: {
                    name: "Large room",
                    initial: true,
                    required_state: [],
                    timeline: [
                        {
                            event_id: "$message",
                            sender: "@member:example.com",
                            origin_server_ts: 1,
                            type: "m.room.message",
                            content: { msgtype: "m.text", body: "Ready" },
                        },
                    ],
                },
            },
            extensions: {
                probe: {},
                e2ee: { device_one_time_keys_count: { signed_curve25519: 50 } },
                to_device: { events: [], next_batch: "devices" },
            },
        };

        function setup(initialRules: Promise<IPushRules | undefined>) {
            const client = createClientWithCreds({
                homeserverUrl: "http://example.com",
                userId: "@user:example.com",
                accessToken: "token",
            });
            const http = Promise.withResolvers<MSC3575SlidingSyncResponse>();
            const request = vi.spyOn(client, "slidingSync").mockImplementation((_body, _url, signal) => {
                signal?.addEventListener("abort", () => http.reject(new DOMException("Stopped", "AbortError")), {
                    once: true,
                });
                return http.promise;
            });
            const fetchRules = vi.spyOn(client, "getPushRules").mockResolvedValue(rules);
            const sliding = new SlidingSync(client.baseUrl, new Map(), {}, client, 20_000);
            const crypto = {
                processSyncChanges: vi.fn().mockResolvedValue([]),
                onCryptoEvent: vi.fn().mockResolvedValue(undefined),
                onSyncCompleted: vi.fn(),
                markAllTrackedUsersAsDirty: vi.fn().mockResolvedValue(undefined),
            };
            const api = new SlidingSyncSdk(
                sliding,
                client,
                { initialPushRulesPromise: initialRules },
                { logger, cryptoCallbacks: crypto },
            );
            const preProcess = vi.fn().mockResolvedValue(undefined);
            sliding.registerExtension({
                name: () => "probe",
                when: () => ExtensionState.PreProcess,
                onRequest: async () => ({}),
                onResponse: preProcess,
            });
            const lifecycle = vi.fn();
            const roomData = vi.fn();
            sliding.on(SlidingSyncEvent.Lifecycle, lifecycle);
            sliding.on(SlidingSyncEvent.RoomData, roomData);
            sliding.on(SlidingSyncEvent.Lifecycle, (state) => {
                if (state === SlidingSyncState.Complete) api.stop();
            });
            return { client, api, http, request, fetchRules, preProcess, lifecycle, roomData, crypto };
        }

        it("sends HTTP while push rules are pending and gates lifecycle, extensions and room events", async () => {
            const pending = Promise.withResolvers<IPushRules>();
            const fixture = setup(pending.promise);
            const running = fixture.api.sync();
            await vi.waitFor(() => expect(fixture.request).toHaveBeenCalledOnce());
            fixture.http.resolve(response);
            await Promise.resolve();
            await Promise.resolve();
            expect(fixture.lifecycle).not.toHaveBeenCalled();
            expect(fixture.preProcess).not.toHaveBeenCalled();
            expect(fixture.roomData).not.toHaveBeenCalled();
            expect(fixture.client.getRoom(roomId)).toBeNull();
            expect(fixture.crypto.processSyncChanges).not.toHaveBeenCalled();
            expect(fixture.crypto.markAllTrackedUsersAsDirty).toHaveBeenCalledOnce();
            expect(fixture.request.mock.calls[0][0].extensions).toMatchObject({
                e2ee: { enabled: true },
                to_device: { enabled: true },
            });

            pending.resolve(rules);
            await running;
            expect(fixture.client.pushRules).toBe(rules);
            expect(fixture.fetchRules).not.toHaveBeenCalled();
            expect(fixture.lifecycle).toHaveBeenCalledWith(SlidingSyncState.RequestFinished, response, undefined);
            expect(fixture.preProcess).toHaveBeenCalledOnce();
            expect(fixture.crypto.processSyncChanges).toHaveBeenCalledOnce();
            expect(fixture.crypto.processSyncChanges).toHaveBeenCalledWith(
                expect.objectContaining({
                    oneTimeKeysCounts: { signed_curve25519: 50 },
                    toDeviceEvents: [],
                    useMsc4186: true,
                }),
            );
            expect(fixture.roomData).toHaveBeenCalledOnce();
            expect(fixture.client.getRoom(roomId)?.getLiveTimeline().getEvents()[0].getContent().body).toBe("Ready");
        });

        it("still completes crypto processing before publishing room data", async () => {
            const fixture = setup(Promise.resolve(rules));
            const cryptoReady = Promise.withResolvers<[]>();
            fixture.crypto.processSyncChanges.mockReturnValue(cryptoReady.promise);
            const running = fixture.api.sync();
            await vi.waitFor(() => expect(fixture.request).toHaveBeenCalledOnce());
            fixture.http.resolve(response);
            await vi.waitFor(() => expect(fixture.crypto.processSyncChanges).toHaveBeenCalledOnce());
            expect(fixture.roomData).not.toHaveBeenCalled();
            expect(fixture.client.getRoom(roomId)).toBeNull();
            cryptoReady.resolve([]);
            await running;
            expect(fixture.roomData).toHaveBeenCalledOnce();
        });

        it("retries missing or failed prefetched rules before processing the buffered response", async () => {
            const pending = Promise.withResolvers<IPushRules | undefined>();
            const retry = Promise.withResolvers<IPushRules>();
            const fixture = setup(pending.promise);
            fixture.fetchRules.mockRejectedValueOnce(new Error("Offline")).mockReturnValueOnce(retry.promise);
            const running = fixture.api.sync();
            await vi.waitFor(() => expect(fixture.request).toHaveBeenCalledOnce());
            fixture.http.resolve(response);
            pending.resolve(undefined);
            await vi.waitFor(() => expect(fixture.fetchRules).toHaveBeenCalledTimes(2));
            expect(fixture.lifecycle).not.toHaveBeenCalled();
            retry.resolve(rules);
            await running;
            expect(fixture.client.pushRules).toBe(rules);
            expect(fixture.roomData).toHaveBeenCalledOnce();
        });

        it("stops on a terminal push-rule error without processing the buffered response", async () => {
            const pending = Promise.withResolvers<IPushRules | undefined>();
            const fixture = setup(pending.promise);
            const error = new MatrixError({ errcode: "M_UNKNOWN_TOKEN", error: "Expired" });
            fixture.fetchRules.mockRejectedValue(error);
            const syncState = vi.fn();
            fixture.client.on(ClientEvent.Sync, syncState);
            const running = fixture.api.sync();
            await vi.waitFor(() => expect(fixture.request).toHaveBeenCalledOnce());
            fixture.http.resolve(response);
            pending.resolve(undefined);
            await running;
            expect(fixture.fetchRules).toHaveBeenCalledOnce();
            expect(syncState).toHaveBeenCalledWith("ERROR", null, { error });
            expect(fixture.lifecycle).not.toHaveBeenCalled();
            expect(fixture.preProcess).not.toHaveBeenCalled();
            expect(fixture.roomData).not.toHaveBeenCalled();
            expect(fixture.client.getRoom(roomId)).toBeNull();
        });

        it.each([false, true])("settles stop while startup is pending (HTTP received: %s)", async (received) => {
            const pending = Promise.withResolvers<IPushRules | undefined>();
            const fixture = setup(pending.promise);
            const running = fixture.api.sync();
            await vi.waitFor(() => expect(fixture.request).toHaveBeenCalledOnce());
            if (received) fixture.http.resolve(response);
            await Promise.resolve();
            fixture.api.stop();
            await running;
            pending.resolve(undefined);
            await Promise.resolve();
            await Promise.resolve();
            expect(fixture.fetchRules).not.toHaveBeenCalled();
            expect(fixture.client.pushRules).toBeUndefined();
            expect(fixture.lifecycle).not.toHaveBeenCalled();
            expect(fixture.preProcess).not.toHaveBeenCalled();
            expect(fixture.roomData).not.toHaveBeenCalled();
        });
    });

    describe.each(["regular", "sliding"])("%s SDK push-rule startup", (protocol) => {
        it("consumes prefetched rules once and fetches fresh rules on a later startup", async () => {
            const client = createClientWithCreds({
                homeserverUrl: "http://example.com",
                userId: "@user:example.com",
                accessToken: "token",
            });
            const initialRules = { global: {} };
            const laterRules = { global: {} };
            const fetchRules = vi.spyOn(client, "getPushRules").mockResolvedValue(laterRules);
            const sliding = new SlidingSync(client.baseUrl, new Map(), {}, client, 20_000);
            vi.spyOn(sliding, "start").mockImplementation(async (ready) => {
                await ready;
            });
            const api =
                protocol === "sliding"
                    ? new SlidingSyncSdk(sliding, client, { initialPushRules: initialRules }, { logger })
                    : new SyncApi(client, { initialPushRules: initialRules }, { logger });
            const loadRules = (): Promise<void> =>
                protocol === "sliding"
                    ? (api as SlidingSyncSdk).sync()
                    : // The regular sync loop runs indefinitely; exercise its actual startup rule gate directly.
                      (api as unknown as { getPushRules: () => Promise<void> }).getPushRules();
            await loadRules();
            expect(fetchRules).not.toHaveBeenCalled();
            expect(client.pushRules).toBe(initialRules);
            await loadRules();
            expect(fetchRules).toHaveBeenCalledOnce();
            expect(client.pushRules).toBe(laterRules);
        });
    });
});
