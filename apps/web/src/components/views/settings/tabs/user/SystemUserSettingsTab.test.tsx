/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { fireEvent, render, screen } from "test-utils-rtl";

import { SystemUserSettingsTab } from "./SystemUserSettingsTab";
import SettingsStore from "../../../../../settings/SettingsStore";
import { SettingLevel } from "../../../../../settings/SettingLevel";

describe("<SystemUserSettingsTab />", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    /** Lets the platform change the named desktop settings and nothing else. */
    const mockPlatformSettings = (names: string[]): void => {
        const original = SettingsStore.canSetValue;
        vi.spyOn(SettingsStore, "canSetValue").mockImplementation((name, roomId, level) =>
            level === SettingLevel.PLATFORM ? names.includes(name) : original(name, roomId, level),
        );
    };

    const headings = (container: HTMLElement): (string | null)[] =>
        [...container.querySelectorAll(".mx_SettingsSubsectionHeading_heading")].map((h) => h.textContent);

    it("only shows the advanced timings where the desktop settings cannot be changed", () => {
        mockPlatformSettings([]);
        const { container } = render(<SystemUserSettingsTab />);
        expect(headings(container)).toEqual(["Advanced"]);
    });

    it("groups the desktop app's settings by startup and performance", () => {
        mockPlatformSettings(["Electron.showTrayIcon", "Electron.enableHardwareAcceleration"]);
        const { container } = render(<SystemUserSettingsTab />);
        expect(headings(container)).toEqual(["Start-up and window behaviour", "Performance and privacy", "Advanced"]);
    });

    it("saves a changed timing on this device", () => {
        mockPlatformSettings([]);
        const setValue = vi.spyOn(SettingsStore, "setValue").mockResolvedValue(undefined);
        render(<SystemUserSettingsTab />);

        fireEvent.change(screen.getByLabelText("Autocomplete delay (ms)"), { target: { value: "250" } });

        expect(setValue).toHaveBeenCalledWith("autocompleteDelay", null, SettingLevel.DEVICE, 250);
    });
});
