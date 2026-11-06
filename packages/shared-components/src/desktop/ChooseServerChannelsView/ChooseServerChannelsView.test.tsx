/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@test-utils";
import userEvent from "@testing-library/user-event";

import { ChooseServerChannelsView, type ChooseServerChannelsViewSnapshot } from "./ChooseServerChannelsView";
import { MockViewModel } from "../../core/viewmodel";

function renderPicker(snapshot: Partial<ChooseServerChannelsViewSnapshot> = {}) {
    const vm = Object.assign(
        new MockViewModel<ChooseServerChannelsViewSnapshot>({
            serverName: "Gamers",
            channels: [
                { id: "!a", name: "general", kind: "text", topic: "Say hi", memberCount: 120, selected: true },
                { id: "!b", name: "memes", kind: "text", memberCount: 1, selected: false },
                { id: "!c", name: "Lounge", kind: "voice", memberCount: 30, selected: true },
            ],
            busy: false,
            ...snapshot,
        }),
        { toggle: vi.fn(), setAll: vi.fn(), confirm: vi.fn(), skip: vi.fn() },
    );
    render(<ChooseServerChannelsView vm={vm} />);
    return vm;
}

describe("ChooseServerChannelsView", () => {
    it("lists text and voice channels with their topic and size", () => {
        renderPicker();
        expect(screen.getByRole("heading", { name: "Pick your channels" })).toBeVisible();
        expect(screen.getByText(/Gamers has 3 channels/)).toBeVisible();
        expect(screen.getByRole("heading", { name: "Text channels" })).toBeVisible();
        expect(screen.getByRole("heading", { name: "Voice channels" })).toBeVisible();
        expect(screen.getByText("Say hi")).toBeVisible();
        expect(screen.getByText("120 members")).toBeVisible();
        expect(screen.getByText("1 member")).toBeVisible();
        expect(screen.getByRole("checkbox", { name: /general/ })).toBeChecked();
        expect(screen.getByRole("checkbox", { name: /memes/ })).not.toBeChecked();
        expect(screen.getByText("2 selected")).toBeVisible();
    });

    it("toggles channels and selects all", async () => {
        const vm = renderPicker();
        await userEvent.click(screen.getByRole("checkbox", { name: /memes/ }));
        expect(vm.toggle).toHaveBeenCalledWith("!b");
        await userEvent.click(screen.getByRole("button", { name: "Select all" }));
        expect(vm.setAll).toHaveBeenCalledWith(true);
    });

    it("offers to clear the selection when everything is selected", async () => {
        const vm = renderPicker({
            channels: [{ id: "!a", name: "general", kind: "text", memberCount: 2, selected: true }],
        });
        await userEvent.click(screen.getByRole("button", { name: "Clear" }));
        expect(vm.setAll).toHaveBeenCalledWith(false);
    });

    it("joins the selection or skips", async () => {
        const vm = renderPicker();
        await userEvent.click(screen.getByRole("button", { name: "Join 2 channels" }));
        expect(vm.confirm).toHaveBeenCalled();
        await userEvent.click(screen.getByRole("button", { name: "Skip for now" }));
        expect(vm.skip).toHaveBeenCalled();
    });

    it("shows errors", () => {
        renderPicker({ error: "Could not join" });
        expect(screen.getByRole("alert")).toHaveTextContent("Could not join");
    });
});
