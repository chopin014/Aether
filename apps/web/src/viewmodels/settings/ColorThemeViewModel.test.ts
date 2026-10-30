/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ColorThemeViewModel } from "./ColorThemeViewModel";
import { type ColorThemeSetting } from "../../appearance/colorThemes";
import dis from "../../dispatcher/dispatcher";
import { Action } from "../../dispatcher/actions";
import { SettingLevel } from "../../settings/SettingLevel";
import SettingsStore from "../../settings/SettingsStore";
import ThemeWatcher from "../../settings/watchers/ThemeWatcher";

describe("ColorThemeViewModel", () => {
    let setting: ColorThemeSetting;
    let effectiveTheme: string;

    const flush = async (): Promise<void> => {
        await new Promise((resolve) => setTimeout(resolve));
    };

    beforeEach(() => {
        setting = { id: "aether" };
        effectiveTheme = "dark";
        document.body.className = "cpd-theme-dark";
        document.body.removeAttribute("style");
        vi.spyOn(ThemeWatcher.prototype, "getEffectiveTheme").mockImplementation(() => effectiveTheme);
        vi.spyOn(ThemeWatcher.prototype, "start").mockImplementation(() => {});
        vi.spyOn(ThemeWatcher.prototype, "stop").mockImplementation(() => {});
        vi.spyOn(SettingsStore, "getValue").mockImplementation(((name: string) =>
            name === "feature_desktop_shell" ? true : setting) as typeof SettingsStore.getValue);
        vi.spyOn(SettingsStore, "setValue").mockImplementation((async (name: string, _room, _level, value) => {
            if (name === "desktopColorTheme") setting = value as ColorThemeSetting;
        }) as typeof SettingsStore.setValue);
        vi.spyOn(dis, "dispatch").mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("should select Aether in the light or dark version in use", () => {
        expect(new ColorThemeViewModel().getSnapshot().selectedId).toBe("aether-dark");
        effectiveTheme = "light";
        expect(new ColorThemeViewModel().getSnapshot().selectedId).toBe("aether-light");
    });

    it("should select nothing under a high contrast theme", () => {
        effectiveTheme = "light-high-contrast";
        expect(new ColorThemeViewModel().getSnapshot().selectedId).toBeUndefined();
    });

    it("should fall back to Aether when the chosen theme's base isn't in use", () => {
        setting = { id: "discord-dark" };
        effectiveTheme = "light";
        expect(new ColorThemeViewModel().getSnapshot().selectedId).toBe("aether-light");
    });

    it("should save a preset, leave the system theme, and paint it", async () => {
        const vm = new ColorThemeViewModel();
        vm.selectTheme("discord-onyx");
        expect(vm.getSnapshot().selectedId).toBe("discord-onyx");
        await flush();

        expect(SettingsStore.setValue).toHaveBeenCalledWith("desktopColorTheme", null, SettingLevel.DEVICE, {
            id: "discord-onyx",
            custom: undefined,
        });
        expect(SettingsStore.setValue).toHaveBeenCalledWith("use_system_theme", null, SettingLevel.DEVICE, false);
        expect(SettingsStore.setValue).toHaveBeenCalledWith("theme", null, SettingLevel.DEVICE, "dark");
        expect(dis.dispatch).toHaveBeenCalledWith({ action: Action.RecheckTheme, forceTheme: "dark" });
        expect(document.body.style.getPropertyValue("--cpd-color-bg-canvas-default")).toBe("#000000");
    });

    it("should switch to the light theme for a light preset", async () => {
        const vm = new ColorThemeViewModel();
        vm.selectTheme("discord-light");
        await flush();
        expect(SettingsStore.setValue).toHaveBeenCalledWith("theme", null, SettingLevel.DEVICE, "light");
    });

    it("should start a custom theme from the colours on screen when one is edited", async () => {
        setting = { id: "discord-dark" };
        const vm = new ColorThemeViewModel();
        vm.setColor("accent", "#ff0000");

        expect(vm.getSnapshot().selectedId).toBe("custom");
        expect(vm.getSnapshot().colors).toMatchObject({ accent: "#ff0000", chat: "#1a1a1e" });
        await flush();
        expect(document.body.style.getPropertyValue("--ae-accent")).toBe("#ff0000");
    });

    it("should keep the custom colours when trying another theme", async () => {
        setting = { id: "discord-dark" };
        const vm = new ColorThemeViewModel();
        vm.setColor("accent", "#ff0000");
        await flush();
        vm.selectTheme("discord-ash");
        await flush();
        expect(setting.custom?.accent).toBe("#ff0000");

        vm.selectTheme("custom");
        expect(vm.getSnapshot().colors.accent).toBe("#ff0000");
    });

    it("should go back to Aether's colours", async () => {
        setting = { id: "discord-dark" };
        document.body.style.setProperty("--ae-accent", "#5865f2");
        const vm = new ColorThemeViewModel();
        vm.selectTheme("aether-dark");
        await flush();
        expect(setting.id).toBe("aether");
        expect(document.body.style.getPropertyValue("--ae-accent")).toBe("");
    });
});
