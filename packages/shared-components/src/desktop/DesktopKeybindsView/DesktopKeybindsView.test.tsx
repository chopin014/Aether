/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@test-utils";
import userEvent from "@testing-library/user-event";

import { DesktopKeybindsView, type DesktopKeybindsSnapshot } from "./DesktopKeybindsView";
import { MockViewModel } from "../../core/viewmodel";

describe("DesktopKeybindsView", () => {
    it("labels recording and clearing by action, and displays conflict feedback", async () => {
        const vm = Object.assign(
            new MockViewModel<DesktopKeybindsSnapshot>({
                rows: [
                    {
                        id: "toggle_mute",
                        label: "Toggle microphone",
                        key: "Ctrl + M",
                        status: "This key is already in use.",
                    },
                ],
                description: "Available while Aether is focused.",
            }),
            { record: vi.fn(), clear: vi.fn() },
        );
        render(<DesktopKeybindsView vm={vm} />);
        await userEvent.click(screen.getByRole("button", { name: "Toggle microphone Ctrl + M" }));
        expect(vm.record).toHaveBeenCalledWith("toggle_mute");
        const clear = screen.getByRole("button", { name: "Clear Toggle microphone keybind" });
        expect(clear).toHaveTextContent("Clear");
        await userEvent.click(clear);
        expect(vm.clear).toHaveBeenCalledWith("toggle_mute");
        expect(screen.getByText("This key is already in use.")).toBeVisible();
    });
    it("announces recording and disables clearing for an unbound action", () => {
        const vm = Object.assign(
            new MockViewModel<DesktopKeybindsSnapshot>({
                rows: [{ id: "push_to_talk", label: "Push to talk", key: "", status: "No key assigned" }],
                description: "Focused shortcuts",
                recording: "push_to_talk",
                error: "Could not save",
            }),
            { record: vi.fn(), clear: vi.fn() },
        );
        render(<DesktopKeybindsView vm={vm} />);
        expect(screen.getByRole("button", { name: /Push to talk Press a key/ })).toHaveAttribute(
            "aria-pressed",
            "true",
        );
        expect(screen.getByRole("button", { name: "Clear Push to talk keybind" })).toBeDisabled();
        expect(screen.getByRole("status")).toHaveTextContent("Could not save");
    });
});
