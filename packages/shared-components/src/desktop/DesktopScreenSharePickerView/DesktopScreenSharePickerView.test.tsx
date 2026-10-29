/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@test-utils";

import { MockViewModel } from "../../core/viewmodel/MockViewModel";
import {
    DesktopScreenSharePickerView,
    type DesktopScreenSharePickerViewSnapshot,
} from "./DesktopScreenSharePickerView";

function model(overrides: Partial<DesktopScreenSharePickerViewSnapshot> = {}) {
    return Object.assign(
        new MockViewModel<DesktopScreenSharePickerViewSnapshot>({
            step: "source",
            tab: "window",
            sources: [{ id: "window:1:0", name: "Editor", thumbnailURL: "data:image/png;base64," }],
            selectedSource: null,
            loading: false,
            error: null,
            quality: { resolutionHeight: 540, frameRate: 12, maxBitrate: null, includeSystemAudio: false },
            limits: { maxResolutionHeight: 540, maxFrameRate: 12, maxBitrate: 750_000 },
            ...overrides,
        }),
        {
            selectTab: vi.fn(),
            selectSource: vi.fn(),
            setQuality: vi.fn(),
            next: vi.fn(),
            back: vi.fn(),
            confirm: vi.fn(),
            cancel: vi.fn(),
            refresh: vi.fn().mockResolvedValue(undefined),
        },
    );
}

describe("DesktopScreenSharePickerView", () => {
    it("routes source selection and prevents progressing without a selected source", () => {
        const vm = model();
        render(<DesktopScreenSharePickerView vm={vm} />);
        expect(screen.getByRole("tab", { name: "Application window" })).toHaveAttribute("aria-selected", "true");
        expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
        expect(screen.queryByRole("img", { hidden: true })).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Editor" }));
        expect(vm.selectSource).toHaveBeenCalledWith("window:1:0");
    });

    it("offers deployment-specific quality values and disables higher presets", () => {
        const vm = model({ step: "quality", selectedSource: { id: "window:1:0", name: "Editor", thumbnailURL: "" } });
        render(<DesktopScreenSharePickerView vm={vm} />);
        expect(screen.getByRole("button", { name: "540p" })).toHaveAttribute("aria-pressed", "true");
        expect(screen.getByRole("button", { name: "720p" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "60 FPS" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "1.5 Mbps" })).toBeDisabled();
        fireEvent.click(screen.getByRole("button", { name: "0.75 Mbps" }));
        expect(vm.setQuality).toHaveBeenCalledWith({ maxBitrate: 750_000 });
        expect(screen.getByText("Screen audio is unavailable for this capture method.")).toBeVisible();
        fireEvent.click(screen.getByRole("button", { name: "Share" }));
        expect(vm.confirm).toHaveBeenCalledTimes(1);
    });

    it("shows loading, retry and empty states without exposing raw capture errors", () => {
        const loading = model({ sources: [], loading: true });
        const view = render(<DesktopScreenSharePickerView vm={loading} />);
        expect(screen.getByRole("status")).toHaveTextContent("Loading available sources…");
        const failed = model({ sources: [], error: "private OS error" });
        view.rerender(<DesktopScreenSharePickerView vm={failed} />);
        expect(screen.getByText("Sources could not be loaded. Try again.")).toBeVisible();
        expect(screen.getByRole("alert")).toBeVisible();
        expect(screen.queryByText("private OS error")).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Retry" }));
        expect(failed.refresh).toHaveBeenCalledOnce();
        const empty = model({ sources: [] });
        view.rerender(<DesktopScreenSharePickerView vm={empty} />);
        expect(screen.getByText(/No sources are available/)).toBeVisible();
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(empty.cancel).toHaveBeenCalledOnce();
    });

    it("keeps edits within the quality step and permits source resolution when policy is unbounded", () => {
        const vm = model({
            step: "quality",
            selectedSource: { id: "window:1:0", name: "Editor", thumbnailURL: "" },
            limits: { maxResolutionHeight: null, maxFrameRate: null, maxBitrate: null },
        });
        render(<DesktopScreenSharePickerView vm={vm} />);
        fireEvent.click(screen.getByRole("button", { name: "720p" }));
        expect(vm.setQuality).toHaveBeenLastCalledWith({ resolutionHeight: 720 });
        fireEvent.click(screen.getByRole("button", { name: "30 FPS" }));
        expect(vm.setQuality).toHaveBeenLastCalledWith({ frameRate: 30 });
        fireEvent.click(screen.getByRole("button", { name: "Source" }));
        expect(vm.setQuality).toHaveBeenLastCalledWith({ resolutionHeight: null });
        fireEvent.click(screen.getByRole("button", { name: "Auto" }));
        expect(vm.setQuality).toHaveBeenLastCalledWith({ maxBitrate: null });
        fireEvent.click(screen.getByRole("button", { name: "Back" }));
        expect(vm.back).toHaveBeenCalledOnce();
        expect(vm.confirm).not.toHaveBeenCalled();
    });

    it("supports keyboard source tabs and advances only after a source is selected", () => {
        const source = { id: "window:1:0", name: "Editor", thumbnailURL: "" };
        const vm = model({ selectedSource: source });
        render(<DesktopScreenSharePickerView vm={vm} />);
        const next = screen.getByRole("button", { name: "Next" });
        expect(next).toBeEnabled();
        fireEvent.click(next);
        expect(vm.next).toHaveBeenCalledOnce();
        screen.getByRole("tab", { name: "Application window" }).focus();
        fireEvent.keyDown(screen.getByRole("tablist"), { key: "ArrowRight" });
        expect(screen.getByRole("tab", { name: "Entire screen" })).toHaveFocus();
        expect(vm.selectTab).toHaveBeenLastCalledWith("screen");
        fireEvent.click(screen.getByRole("tab", { name: "Application window" }));
        expect(vm.selectTab).toHaveBeenLastCalledWith("window");
    });
});
