/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ColorThemeColors } from "@element-hq/web-shared-components";

import {
    applyColorTheme,
    COLOR_THEME_PRESETS,
    getColorThemeBase,
    getEditableColors,
    type ColorThemeSetting,
} from "./colorThemes";
import SettingsStore from "../settings/SettingsStore";

const custom: ColorThemeColors = {
    rail: "#101010",
    sidebar: "#202020",
    chat: "#303030",
    raised: "#404040",
    text: "#fafafa",
    mutedText: "#a0a0a0",
    accent: "#ffcc00",
};

describe("colorThemes", () => {
    let setting: ColorThemeSetting;
    let shellEnabled: boolean;

    beforeEach(() => {
        setting = { id: "aether" };
        shellEnabled = true;
        document.body.className = "cpd-theme-dark";
        document.body.removeAttribute("style");
        vi.spyOn(SettingsStore, "getValue").mockImplementation(((name: string) =>
            name === "feature_desktop_shell" ? shellEnabled : setting) as typeof SettingsStore.getValue);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    const variable = (name: string): string => document.body.style.getPropertyValue(name);

    it("should paint Discord's Dark theme with the values from its stylesheets", () => {
        setting = { id: "discord-dark" };
        applyColorTheme("dark");
        expect(variable("--mx-desktop-rail-background")).toBe("#121214");
        expect(variable("--mx-desktop-shell-frame")).toBe("#121214");
        expect(variable("--cpd-color-bg-canvas-default")).toBe("#1a1a1e");
        expect(variable("--ae-accent")).toBe("#5865f2");
    });

    it("should give the 2023 Discord theme its separate rail and sidebar colours", () => {
        setting = { id: "discord-2023-dark" };
        applyColorTheme("dark");
        expect(variable("--mx-desktop-rail-background")).toBe("#1e1f22");
        expect(variable("--mx-desktop-shell-frame")).toBe("#2b2d31");
        expect(variable("--cpd-color-bg-canvas-default")).toBe("#313338");
    });

    it("should remove the previous colours when going back to Aether", () => {
        setting = { id: "discord-dark" };
        applyColorTheme("dark");
        setting = { id: "aether" };
        applyColorTheme("dark");
        expect(variable("--mx-desktop-rail-background")).toBe("");
        expect(variable("--ae-accent")).toBe("");
    });

    it("should leave other inline variables alone", () => {
        document.body.style.setProperty("--font-family", "Inter");
        setting = { id: "discord-dark" };
        applyColorTheme("dark");
        setting = { id: "aether" };
        applyColorTheme("dark");
        expect(variable("--font-family")).toBe("Inter");
    });

    it.each([
        ["the base theme differs", "cpd-theme-light", "light"],
        ["high contrast is in use", "cpd-theme-dark-hc", "dark"],
        ["a custom theme is in use", "cpd-theme-dark", "custom-mine"],
    ])("should not apply when %s", (_reason, className, theme) => {
        document.body.className = className;
        setting = { id: "discord-dark" };
        applyColorTheme(theme);
        expect(variable("--ae-accent")).toBe("");
    });

    it("should not apply outside the desktop shell", () => {
        shellEnabled = false;
        setting = { id: "discord-dark" };
        applyColorTheme("dark");
        expect(variable("--ae-accent")).toBe("");
    });

    it("should work out a custom theme's base from its chat colour", () => {
        expect(getColorThemeBase({ id: "custom", custom })).toBe("dark");
        expect(getColorThemeBase({ id: "custom", custom: { ...custom, chat: "#f0f0f0" } })).toBe("light");
    });

    it("should choose readable text on a custom accent", () => {
        document.body.className = "cpd-theme-dark";
        setting = { id: "custom", custom };
        applyColorTheme("dark");
        expect(variable("--ae-on-accent")).toBe("#000000");

        setting = { id: "custom", custom: { ...custom, accent: "#101040" } };
        applyColorTheme("dark");
        expect(variable("--ae-on-accent")).toBe("#ffffff");
    });

    it("should start editing from the current theme's colours", () => {
        expect(getEditableColors({ id: "discord-onyx" }, "dark").chat).toBe("#000000");
        expect(getEditableColors({ id: "aether" }, "light").chat).toBe("#ffffff");
        expect(getEditableColors({ id: "custom", custom }, "dark")).toBe(custom);
    });

    it("should only use plain or eight digit hex values in the presets", () => {
        for (const { palette } of Object.values(COLOR_THEME_PRESETS)) {
            for (const color of Object.values(palette)) {
                expect(color).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/);
            }
        }
    });
});
