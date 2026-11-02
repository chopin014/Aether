/*
Copyright 2025 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// @vitest-environment happy-dom

import { vi, describe, it, expect, afterEach, type Mock, type Mocked } from "vitest";
import { mockPlatformPeg } from "test-utils";

import { EventIndexPeg } from "./EventIndexPeg.ts";
import type BaseEventIndexManager from "./BaseEventIndexManager.ts";
import SettingsStore from "../settings/SettingsStore.ts";
import { MatrixClientPeg } from "../MatrixClientPeg.ts";
import EventIndex from "./EventIndex.ts";

vi.mock("./EventIndex.ts");

afterEach(() => {
    vi.restoreAllMocks();
});

describe("EventIndexPeg", () => {
    describe("initEventIndex", () => {
        it("passes tokenizerMode to initEventIndex", async () => {
            const mockIndexingManager = {
                initEventIndex: vi.fn().mockResolvedValue(undefined),
                getUserVersion: vi.fn().mockResolvedValue(1),
                isEventIndexEmpty: vi.fn().mockResolvedValue(false),
            } as any as Mocked<BaseEventIndexManager>;
            mockPlatformPeg({ getEventIndexingManager: () => mockIndexingManager });

            vi.spyOn(MatrixClientPeg, "get").mockReturnValue({
                getUserId: () => "@user:example.org",
                getDeviceId: () => "DEVICE123",
                on: vi.fn(),
                removeListener: vi.fn(),
            } as any);

            vi.spyOn(SettingsStore, "getValueAt").mockImplementation((_level, settingName): any => {
                if (settingName === "tokenizerMode") return "ngram";
                if (settingName === "crawlerSleepTime") return 3000;
                return undefined;
            });

            const peg = new EventIndexPeg();
            await peg.initEventIndex();

            expect(mockIndexingManager.initEventIndex).toHaveBeenCalledWith("@user:example.org", "DEVICE123", "ngram");
        });

        it("passes language tokenizer mode by default", async () => {
            const mockIndexingManager = {
                initEventIndex: vi.fn().mockResolvedValue(undefined),
                getUserVersion: vi.fn().mockResolvedValue(1),
                isEventIndexEmpty: vi.fn().mockResolvedValue(false),
            } as any as Mocked<BaseEventIndexManager>;
            mockPlatformPeg({ getEventIndexingManager: () => mockIndexingManager });

            vi.spyOn(MatrixClientPeg, "get").mockReturnValue({
                getUserId: () => "@user:example.org",
                getDeviceId: () => "DEVICE123",
                on: vi.fn(),
                removeListener: vi.fn(),
            } as any);

            vi.spyOn(SettingsStore, "getValueAt").mockImplementation((_level, settingName): any => {
                if (settingName === "tokenizerMode") return "language";
                if (settingName === "crawlerSleepTime") return 3000;
                return undefined;
            });

            const peg = new EventIndexPeg();
            await peg.initEventIndex();

            expect(mockIndexingManager.initEventIndex).toHaveBeenCalledWith(
                "@user:example.org",
                "DEVICE123",
                "language",
            );
        });

        it("sets forceAddInitialCheckpoints when database was recreated", async () => {
            const mockIndex = {
                setForceAddInitialCheckpoints: vi.fn(),
                init: vi.fn().mockResolvedValue(undefined),
            };
            (EventIndex as unknown as Mock).mockImplementation(function () {
                return mockIndex;
            });

            const mockIndexingManager = {
                initEventIndex: vi.fn().mockResolvedValue({ wasRecreated: true }),
                getUserVersion: vi.fn().mockResolvedValue(1),
                isEventIndexEmpty: vi.fn().mockResolvedValue(false),
            } as any as Mocked<BaseEventIndexManager>;
            mockPlatformPeg({ getEventIndexingManager: () => mockIndexingManager });

            vi.spyOn(MatrixClientPeg, "get").mockReturnValue({
                getUserId: () => "@user:example.org",
                getDeviceId: () => "DEVICE123",
                on: vi.fn(),
                removeListener: vi.fn(),
            } as any);

            vi.spyOn(SettingsStore, "getValueAt").mockImplementation((_level, settingName): any => {
                if (settingName === "tokenizerMode") return "ngram";
                if (settingName === "crawlerSleepTime") return 3000;
                return undefined;
            });

            const peg = new EventIndexPeg();
            await peg.initEventIndex();

            expect(mockIndex.setForceAddInitialCheckpoints).toHaveBeenCalledWith(true);
        });

        it("sets forceAddInitialCheckpoints when index is empty", async () => {
            const mockIndex = {
                setForceAddInitialCheckpoints: vi.fn(),
                init: vi.fn().mockResolvedValue(undefined),
            };
            (EventIndex as unknown as Mock).mockImplementation(function () {
                return mockIndex;
            });

            const mockIndexingManager = {
                initEventIndex: vi.fn().mockResolvedValue(undefined),
                getUserVersion: vi.fn().mockResolvedValue(1),
                isEventIndexEmpty: vi.fn().mockResolvedValue(true),
                setUserVersion: vi.fn().mockResolvedValue(undefined),
            } as any as Mocked<BaseEventIndexManager>;
            mockPlatformPeg({ getEventIndexingManager: () => mockIndexingManager });

            vi.spyOn(MatrixClientPeg, "get").mockReturnValue({
                getUserId: () => "@user:example.org",
                getDeviceId: () => "DEVICE123",
                on: vi.fn(),
                removeListener: vi.fn(),
            } as any);

            vi.spyOn(SettingsStore, "getValueAt").mockImplementation((_level, settingName): any => {
                if (settingName === "tokenizerMode") return "ngram";
                if (settingName === "crawlerSleepTime") return 3000;
                return undefined;
            });

            const peg = new EventIndexPeg();
            await peg.initEventIndex();

            expect(mockIndexingManager.setUserVersion).toHaveBeenCalledWith(1);
            expect(mockIndex.setForceAddInitialCheckpoints).toHaveBeenCalledWith(true);
        });

        it("reinitializes index when userVersion is 0 and index is not empty", async () => {
            const mockIndex = {
                setForceAddInitialCheckpoints: vi.fn(),
                init: vi.fn().mockResolvedValue(undefined),
            };
            (EventIndex as unknown as Mock).mockImplementation(function () {
                return mockIndex;
            });

            const mockIndexingManager = {
                initEventIndex: vi.fn().mockResolvedValue(undefined),
                getUserVersion: vi.fn().mockResolvedValue(0),
                isEventIndexEmpty: vi.fn().mockResolvedValue(false),
                closeEventIndex: vi.fn().mockResolvedValue(undefined),
                deleteEventIndex: vi.fn().mockResolvedValue(undefined),
                setUserVersion: vi.fn().mockResolvedValue(undefined),
            } as any as Mocked<BaseEventIndexManager>;
            mockPlatformPeg({ getEventIndexingManager: () => mockIndexingManager });

            vi.spyOn(MatrixClientPeg, "get").mockReturnValue({
                getUserId: () => "@user:example.org",
                getDeviceId: () => "DEVICE123",
                on: vi.fn(),
                removeListener: vi.fn(),
            } as any);

            vi.spyOn(SettingsStore, "getValueAt").mockImplementation((_level, settingName): any => {
                if (settingName === "tokenizerMode") return "ngram";
                if (settingName === "crawlerSleepTime") return 3000;
                return undefined;
            });

            const peg = new EventIndexPeg();
            await peg.initEventIndex();

            expect(mockIndexingManager.closeEventIndex).toHaveBeenCalled();
            expect(mockIndexingManager.deleteEventIndex).toHaveBeenCalled();
            expect(mockIndexingManager.initEventIndex).toHaveBeenCalledTimes(2);
            expect(mockIndexingManager.initEventIndex).toHaveBeenNthCalledWith(
                2,
                "@user:example.org",
                "DEVICE123",
                "ngram",
            );
        });
    });

    describe("initInBackground", () => {
        function mockIndex(): Record<string, Mock> {
            const index = {
                listenBeforeOpening: vi.fn(),
                abandon: vi.fn(),
                setForceAddInitialCheckpoints: vi.fn(),
                init: vi.fn().mockResolvedValue(undefined),
            };
            (EventIndex as unknown as Mock).mockImplementation(function () {
                return index;
            });
            return index;
        }

        it("listens straight away but opens the index only when told to", async () => {
            const mockIndexingManager = {
                supportsEventIndexing: vi.fn().mockResolvedValue(true),
                initEventIndex: vi.fn().mockResolvedValue(undefined),
                getUserVersion: vi.fn().mockResolvedValue(1),
                isEventIndexEmpty: vi.fn().mockResolvedValue(false),
            } as any as Mocked<BaseEventIndexManager>;
            mockPlatformPeg({ getEventIndexingManager: () => mockIndexingManager });
            vi.spyOn(MatrixClientPeg, "get").mockReturnValue({
                getUserId: () => "@user:example.org",
                getDeviceId: () => "DEVICE123",
            } as any);
            vi.spyOn(SettingsStore, "getValueAt").mockImplementation((_level, settingName): any =>
                settingName === "enableEventIndexing" ? true : undefined,
            );

            const index = mockIndex();
            const open = Promise.withResolvers<void>();
            const peg = new EventIndexPeg();
            const done = peg.initInBackground(open.promise);
            expect(index.listenBeforeOpening).toHaveBeenCalled();
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(mockIndexingManager.initEventIndex).not.toHaveBeenCalled();

            open.resolve();
            await expect(done).resolves.toBe(true);
            expect(mockIndexingManager.initEventIndex).toHaveBeenCalled();
            expect(peg.get()).toBe(index);
        });

        it("does not open the index after logging out while it was waiting", async () => {
            const index = mockIndex();
            const mockIndexingManager = {
                supportsEventIndexing: vi.fn().mockResolvedValue(true),
                initEventIndex: vi.fn().mockResolvedValue(undefined),
            } as any as Mocked<BaseEventIndexManager>;
            mockPlatformPeg({ getEventIndexingManager: () => mockIndexingManager });
            vi.spyOn(MatrixClientPeg, "get").mockReturnValue({ getUserId: () => "@user:example.org" } as any);
            vi.spyOn(SettingsStore, "getValueAt").mockImplementation((_level, settingName): any =>
                settingName === "enableEventIndexing" ? true : undefined,
            );

            const open = Promise.withResolvers<void>();
            const peg = new EventIndexPeg();
            const done = peg.initInBackground(open.promise);
            await new Promise((resolve) => setTimeout(resolve, 0));
            await peg.unset();
            open.resolve();

            await expect(done).resolves.toBe(false);
            expect(index.abandon).toHaveBeenCalled();
            expect(mockIndexingManager.initEventIndex).not.toHaveBeenCalled();
            expect(peg.get()).toBeNull();
        });

        it("stops listening when indexing is turned off", async () => {
            const mockIndexingManager = {
                supportsEventIndexing: vi.fn().mockResolvedValue(true),
                initEventIndex: vi.fn(),
            } as any as Mocked<BaseEventIndexManager>;
            mockPlatformPeg({ getEventIndexingManager: () => mockIndexingManager });
            vi.spyOn(SettingsStore, "getValueAt").mockReturnValue(false);

            const index = mockIndex();
            const peg = new EventIndexPeg();
            await expect(peg.initInBackground(Promise.resolve())).resolves.toBe(false);
            expect(index.abandon).toHaveBeenCalled();
            expect(mockIndexingManager.initEventIndex).not.toHaveBeenCalled();
        });
    });
});
