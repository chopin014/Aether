/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "vitest-canvas-mock";
import { type DesktopUpdateState } from "shared-types";

import PlatformPeg from "../../PlatformPeg";
import type BasePlatform from "../../BasePlatform";
import { restartDesktopUpdate } from "../../toasts/restartDesktopUpdate";
import { DesktopUpdatesViewModel } from "./DesktopUpdatesViewModel";

vi.mock("../../toasts/restartDesktopUpdate", () => ({ restartDesktopUpdate: vi.fn() }));

describe("DesktopUpdatesViewModel", () => {
    let publishState: (state: DesktopUpdateState) => void;
    let resolveState: (state: DesktopUpdateState) => void;
    let rejectState: (reason?: unknown) => void;
    let unsubscribe: ReturnType<typeof vi.fn>;
    let startUpdateCheck: ReturnType<typeof vi.fn>;
    let getState: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        unsubscribe = vi.fn();
        startUpdateCheck = vi.fn();
        getState = vi.fn(
            () =>
                new Promise<DesktopUpdateState>((resolve, reject) => {
                    resolveState = resolve;
                    rejectState = reject;
                }),
        );
        vi.mocked(restartDesktopUpdate).mockReset();
        const platform = {
            getDesktopUpdateState: getState,
            onDesktopUpdateStateChanged: (listener: (state: DesktopUpdateState) => void) => {
                publishState = listener;
                return unsubscribe;
            },
            startUpdateCheck,
        } as unknown as BasePlatform;
        vi.spyOn(PlatformPeg, "get").mockReturnValue(platform);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("keeps the newest event when the initial state request resolves later", async () => {
        const vm = new DesktopUpdatesViewModel();
        publishState({ status: "downloading", currentVersion: "1.4.2", version: "1.5.0", percent: 35 });
        resolveState({ status: "idle", currentVersion: "1.4.2", lastChecked: 1 });
        await Promise.resolve();

        expect(getState).toHaveBeenCalledOnce();
        expect(vm.getSnapshot()).toEqual({
            state: { status: "downloading", currentVersion: "1.4.2", version: "1.5.0", percent: 35 },
            loading: false,
        });

        vm.dispose();
        expect(unsubscribe).toHaveBeenCalledOnce();
    });

    it("checks again only from idle or error states", async () => {
        const vm = new DesktopUpdatesViewModel();
        vm.checkForUpdates();
        expect(startUpdateCheck).not.toHaveBeenCalled();

        resolveState({ status: "error", currentVersion: "1.4.2" });
        await Promise.resolve();

        vm.checkForUpdates();
        expect(startUpdateCheck).toHaveBeenCalledOnce();

        publishState({ status: "ready", currentVersion: "1.4.2", version: "1.5.0" });
        vm.checkForUpdates();
        expect(startUpdateCheck).toHaveBeenCalledOnce();
    });

    it("shows a generic recoverable error when the initial state request fails", async () => {
        const vm = new DesktopUpdatesViewModel();
        rejectState(new Error("private platform detail"));
        await Promise.resolve();
        await Promise.resolve();

        expect(vm.getSnapshot()).toEqual({
            state: { status: "error", currentVersion: "" },
            loading: false,
        });
    });

    it("ignores late state and snapshot results after disposal", async () => {
        const vm = new DesktopUpdatesViewModel();
        const initialSnapshot = vm.getSnapshot();

        vm.dispose();
        publishState({ status: "ready", currentVersion: "1.4.2", version: "1.5.0" });
        resolveState({ status: "idle", currentVersion: "1.4.2" });
        await Promise.resolve();

        expect(unsubscribe).toHaveBeenCalledOnce();
        expect(vm.getSnapshot()).toBe(initialSnapshot);
    });

    it("restarts only when an update is ready", async () => {
        const vm = new DesktopUpdatesViewModel();
        vm.restartToUpdate();
        resolveState({ status: "idle", currentVersion: "1.4.2" });
        await Promise.resolve();

        vm.restartToUpdate();
        expect(restartDesktopUpdate).not.toHaveBeenCalled();

        publishState({ status: "ready", currentVersion: "1.4.2", version: "1.5.0" });
        vm.restartToUpdate();
        expect(restartDesktopUpdate).toHaveBeenCalledOnce();
    });
});
