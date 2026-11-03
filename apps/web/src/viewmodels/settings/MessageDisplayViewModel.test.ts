/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, describe, expect, it, vi } from "vitest";

import { SettingLevel } from "../../settings/SettingLevel";
import SettingsStore from "../../settings/SettingsStore";
import { MESSAGE_GROUP_SPACING_OPTIONS, MessageDisplayViewModel } from "./MessageDisplayViewModel";

describe("MessageDisplayViewModel", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    function mockSettings(values: { useCompactLayout: boolean; desktopMessageGroupSpacing: number }): void {
        vi.spyOn(SettingsStore, "getValue").mockImplementation(
            ((name: keyof typeof values) => values[name]) as unknown as typeof SettingsStore.getValue,
        );
    }

    it("reads the layout and spacing from settings", () => {
        mockSettings({ useCompactLayout: true, desktopMessageGroupSpacing: 8 });

        const vm = new MessageDisplayViewModel();

        expect(vm.getSnapshot()).toEqual({
            display: "compact",
            groupSpacing: 8,
            groupSpacingOptions: MESSAGE_GROUP_SPACING_OPTIONS,
        });
        vm.dispose();
    });

    it("saves a new layout and shows it straight away", () => {
        mockSettings({ useCompactLayout: false, desktopMessageGroupSpacing: 16 });
        const setValue = vi.spyOn(SettingsStore, "setValue").mockResolvedValue(undefined);
        const vm = new MessageDisplayViewModel();

        vm.setDisplay("compact");

        expect(vm.getSnapshot().display).toBe("compact");
        expect(setValue).toHaveBeenCalledWith("useCompactLayout", null, SettingLevel.DEVICE, true);
        vm.dispose();
    });

    it("saves a new group spacing to the account", () => {
        mockSettings({ useCompactLayout: false, desktopMessageGroupSpacing: 16 });
        const setValue = vi.spyOn(SettingsStore, "setValue").mockResolvedValue(undefined);
        const vm = new MessageDisplayViewModel();

        vm.setGroupSpacing(4);

        expect(vm.getSnapshot().groupSpacing).toBe(4);
        expect(setValue).toHaveBeenCalledWith("desktopMessageGroupSpacing", null, SettingLevel.ACCOUNT, 4);
        vm.dispose();
    });

    it("follows changes made elsewhere", () => {
        const values = { useCompactLayout: false, desktopMessageGroupSpacing: 16 };
        mockSettings(values);
        let notify: (() => void) | undefined;
        vi.spyOn(SettingsStore, "watchSetting").mockImplementation((setting, _room, callback) => {
            if (setting === "desktopMessageGroupSpacing")
                notify = () => callback(setting, null, SettingLevel.ACCOUNT, 0, 0);
            return setting;
        });
        vi.spyOn(SettingsStore, "unwatchSetting").mockImplementation(() => {});
        const vm = new MessageDisplayViewModel();

        values.desktopMessageGroupSpacing = 0;
        notify!();

        expect(vm.getSnapshot().groupSpacing).toBe(0);
        vm.dispose();
    });
});
