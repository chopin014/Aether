/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import { DesktopScreenSharePickerViewModel } from "./DesktopScreenSharePickerViewModel";
import { DesktopVoicePipeline } from "../../audio/desktop/DesktopVoicePipeline";

const source = { id: "window:1:0", name: "Editor", thumbnailURL: "data:image/png;base64," };

describe("DesktopScreenSharePickerViewModel", () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("serializes refreshes and ignores a confirmation finishing after the dialog closes", async () => {
        vi.useFakeTimers();
        let resolve!: (sources: DesktopCapturerSource[]) => void;
        const getSources = vi.fn().mockImplementation(
            () =>
                new Promise<DesktopCapturerSource[]>((res) => {
                    resolve = res;
                }),
        );
        const onFinished = vi.fn();
        const vm = new DesktopScreenSharePickerViewModel({ getSources, onFinished });
        const first = vm.refresh();
        expect(vm.refresh()).toBe(first);
        expect(getSources).toHaveBeenCalledTimes(1);
        resolve([source]);
        await first;
        vm.selectSource(source.id);
        vm.next();
        vm.back();
        expect(vm.getSnapshot().selectedSource).toEqual(source);
        vm.next();
        vm.confirm();
        vm.confirm();
        expect(getSources).toHaveBeenCalledTimes(2);
        const pending = vm.refresh();
        vm.dispose();
        resolve([source]);
        await pending;
        await vi.advanceTimersByTimeAsync(1000);
        expect(getSources).toHaveBeenCalledTimes(2);
        expect(onFinished).not.toHaveBeenCalled();
    });

    it("clears a selection when changing source type and confirms the latest source once", async () => {
        const screen = { ...source, id: "screen:0:0", name: "Screen" };
        const getSources = vi.fn().mockResolvedValue([source, screen]);
        const onFinished = vi.fn();
        const save = vi.spyOn(DesktopVoicePipeline.instance, "setScreenShareQuality");
        const vm = new DesktopScreenSharePickerViewModel({ getSources, onFinished });
        await vm.refresh();
        vm.selectSource(source.id);
        vm.selectTab("screen");
        vm.selectSource(source.id);
        vm.next();
        expect(vm.getSnapshot().selectedSource).toBeNull();
        expect(vm.getSnapshot().step).toBe("source");
        vm.selectSource(screen.id);
        vm.setQuality({ resolutionHeight: 720, includeSystemAudio: true });
        vm.next();
        const refreshed = { ...screen, thumbnailURL: "new-thumbnail" };
        getSources.mockResolvedValue([source, refreshed]);
        vm.confirm();
        await vm.refresh();
        expect(onFinished).toHaveBeenCalledExactlyOnceWith(refreshed);
        expect(save).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
                resolutionHeight: 720,
                includeSystemAudio: false,
            }),
        );
        vm.confirm();
        vm.cancel();
        await vm.refresh();
        expect(onFinished).toHaveBeenCalledTimes(1);
        vm.dispose();
    });

    it("rejects a disappeared source immediately before confirming and does not change preferences on cancel", async () => {
        const getSources = vi.fn().mockResolvedValue([source]);
        const onFinished = vi.fn();
        const save = vi.spyOn(DesktopVoicePipeline.instance, "setScreenShareQuality");
        const vm = new DesktopScreenSharePickerViewModel({ getSources, onFinished });
        await vm.refresh();
        vm.selectSource(source.id);
        vm.next();
        expect(vm.getSnapshot().step).toBe("quality");
        vm.setQuality({ resolutionHeight: 720 });
        expect(save).not.toHaveBeenCalled();

        getSources.mockResolvedValue([]);
        vm.confirm();
        await vm.refresh();
        expect(vm.getSnapshot().selectedSource).toBeNull();
        expect(vm.getSnapshot().step).toBe("source");
        expect(onFinished).not.toHaveBeenCalled();
        vm.cancel();
        vm.cancel();
        expect(onFinished).toHaveBeenCalledExactlyOnceWith();
        expect(save).not.toHaveBeenCalled();
        vm.dispose();
    });

    it("handles source errors and ignores a response arriving after cancellation", async () => {
        let resolve!: (sources: DesktopCapturerSource[]) => void;
        const getSources = vi.fn(
            () =>
                new Promise<DesktopCapturerSource[]>((res) => {
                    resolve = res;
                }),
        );
        const onFinished = vi.fn();
        const vm = new DesktopScreenSharePickerViewModel({ getSources, onFinished });
        const pending = vm.refresh();
        vm.cancel();
        resolve([source]);
        await pending;
        expect(vm.getSnapshot().sources).toEqual([]);
        expect(onFinished).toHaveBeenCalledTimes(1);
        vm.dispose();

        const failed = new DesktopScreenSharePickerViewModel({
            getSources: vi.fn().mockRejectedValue(new Error("Permission denied")),
            onFinished,
        });
        await failed.refresh();
        expect(failed.getSnapshot().error).toBe("Permission denied");
        expect(failed.getSnapshot().selectedSource).toBeNull();
        failed.dispose();
    });
});
