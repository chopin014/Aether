/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type MatrixClient } from "matrix-js-sdk/src/matrix";

// The settings first: they create this controller as they load, so importing it first would find it unfinished.
import SettingsStore from "../SettingsStore";
import SlidingSyncController from "./SlidingSyncController";
import { SettingLevel } from "../SettingLevel";
import PlatformPeg from "../../PlatformPeg";
import type BasePlatform from "../../BasePlatform";
import { MatrixClientPeg } from "../../MatrixClientPeg";
import { SlidingSyncManager } from "../../SlidingSyncManager";
import { SlidingSyncCache } from "../../sliding-sync/SlidingSyncCache";

describe("SlidingSyncController", () => {
    let order: string[];
    let client: MatrixClient;

    beforeEach(() => {
        order = [];
        client = {
            store: { deleteAllData: vi.fn(async () => void order.push("delete sync store")) },
        } as unknown as MatrixClient;
        vi.spyOn(MatrixClientPeg, "get").mockReturnValue(client);
        vi.spyOn(SlidingSyncCache, "deleteAll").mockImplementation(async () => void order.push("delete saved rooms"));
        vi.spyOn(PlatformPeg, "get").mockReturnValue({
            reload: () => order.push("reload"),
        } as unknown as BasePlatform);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        SlidingSyncManager.serverSupportsSlidingSync = false;
    });

    describe("turned off", () => {
        it("clears the sync data sliding sync left stale, then reloads", async () => {
            vi.spyOn(SlidingSyncManager.instance, "isActiveFor").mockReturnValue(true);
            await new SlidingSyncController().onChange(SettingLevel.DEVICE, null, false);
            expect(SlidingSyncManager.instance.isActiveFor).toHaveBeenCalledWith(client);
            expect(order).toEqual(["delete sync store", "delete saved rooms", "reload"]);
        });

        it("keeps the sync data of a client that fell back to regular sync", async () => {
            vi.spyOn(SlidingSyncManager.instance, "isActiveFor").mockReturnValue(false);
            await new SlidingSyncController().onChange(SettingLevel.DEVICE, null, false);
            expect(order).toEqual(["reload"]);
        });

        it("still reloads when clearing fails", async () => {
            vi.spyOn(SlidingSyncManager.instance, "isActiveFor").mockReturnValue(true);
            vi.mocked(client.store.deleteAllData).mockRejectedValue(new Error("blocked"));
            await new SlidingSyncController().onChange(SettingLevel.DEVICE, null, false);
            expect(order).toEqual(["reload"]);
        });
    });

    it("only reloads when turned on", async () => {
        await new SlidingSyncController().onChange(SettingLevel.DEVICE, null, true);
        expect(client.store.deleteAllData).not.toHaveBeenCalled();
        expect(order).toEqual(["reload"]);
    });

    describe("settingDisabled", () => {
        const withSetting = (on: boolean): void => {
            vi.spyOn(SettingsStore, "getValue").mockImplementation(
                (name) => name === "feature_simplified_sliding_sync" && on,
            );
        };

        it("can always be turned off, even where the server offers no sliding sync", () => {
            withSetting(true);
            SlidingSyncManager.serverSupportsSlidingSync = false;
            expect(new SlidingSyncController().settingDisabled).toBe(false);
        });

        it("can be turned on only where the server offers sliding sync", () => {
            withSetting(false);
            SlidingSyncManager.serverSupportsSlidingSync = false;
            expect(new SlidingSyncController().settingDisabled).toEqual(expect.any(String));
            SlidingSyncManager.serverSupportsSlidingSync = true;
            expect(new SlidingSyncController().settingDisabled).toBe(false);
        });
    });
});
