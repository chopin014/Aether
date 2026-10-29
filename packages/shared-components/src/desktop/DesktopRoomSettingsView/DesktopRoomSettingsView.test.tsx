/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { fireEvent, render, screen } from "@test-utils";
import { describe, expect, it, vi } from "vitest";

import { MockViewModel } from "../../core/viewmodel/MockViewModel";
import {
    DesktopRoomSettingsView,
    type DesktopRoomSettingsViewActions,
    type DesktopRoomSettingsViewSnapshot,
} from "./DesktopRoomSettingsView";

describe("DesktopRoomSettingsView", () => {
    it("renders grouped settings and routes tab selection through its view model", () => {
        const selectTab = vi.fn();
        const vm = new (class
            extends MockViewModel<DesktopRoomSettingsViewSnapshot>
            implements DesktopRoomSettingsViewActions
        {
            public selectTab = selectTab;
        })({
            navigationLabel: "Channel settings for Build Room",
            groups: [
                {
                    label: "CHANNEL SETTINGS",
                    tabs: [
                        { id: "GENERAL", label: "Overview", icon: <span>G</span> },
                        { id: "SECURITY", label: "Security & Privacy", icon: <span>S</span> },
                    ],
                },
            ],
            activeTabId: "GENERAL",
            activeTabContent: <div>General room options</div>,
        });

        render(<DesktopRoomSettingsView vm={vm} />);

        expect(screen.getByRole("navigation", { name: "Channel settings for Build Room" })).toBeInTheDocument();
        expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
        expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "mx_tabpanel_GENERAL_label");
        expect(screen.getByText("General room options")).toBeInTheDocument();

        fireEvent.click(screen.getByRole("tab", { name: "Security & Privacy" }));
        expect(selectTab).toHaveBeenCalledWith("SECURITY");
    });

    it("activates the focused tab when navigating with the arrow keys", () => {
        const selectTab = vi.fn();
        const vm = new (class
            extends MockViewModel<DesktopRoomSettingsViewSnapshot>
            implements DesktopRoomSettingsViewActions
        {
            public selectTab = selectTab;
        })({
            navigationLabel: "Channel settings",
            groups: [
                {
                    label: "CHANNEL SETTINGS",
                    tabs: [
                        { id: "GENERAL", label: "Overview", icon: null },
                        { id: "SECURITY", label: "Security & Privacy", icon: null },
                    ],
                },
            ],
            activeTabId: "GENERAL",
            activeTabContent: <div>General room options</div>,
        });
        render(<DesktopRoomSettingsView vm={vm} />);

        const overviewTab = screen.getByRole("tab", { name: "Overview" });
        overviewTab.focus();
        fireEvent.keyDown(screen.getByRole("tablist"), { key: "ArrowDown" });

        expect(screen.getByRole("tab", { name: "Security & Privacy" })).toHaveFocus();
        expect(selectTab).toHaveBeenCalledWith("SECURITY");
    });
});
