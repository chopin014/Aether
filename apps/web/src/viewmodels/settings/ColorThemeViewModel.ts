/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    BaseViewModel,
    type ColorThemeColors,
    type ColorThemeOption,
    type ColorThemeViewActions,
    type ColorThemeViewSnapshot,
} from "@element-hq/web-shared-components";
import { logger } from "matrix-js-sdk/src/logger";

import {
    applyColorTheme,
    COLOR_THEME_PRESETS,
    getColorThemeBase,
    getEditableColors,
    type ColorThemeBase,
    type ColorThemePresetId,
    type ColorThemeSetting,
} from "../../appearance/colorThemes";
import dis from "../../dispatcher/dispatcher";
import { Action } from "../../dispatcher/actions";
import { type RecheckThemePayload } from "../../dispatcher/payloads/RecheckThemePayload";
import { SettingLevel } from "../../settings/SettingLevel";
import SettingsStore from "../../settings/SettingsStore";
import ThemeWatcher, { ThemeWatcherEvent } from "../../settings/watchers/ThemeWatcher";

const AETHER_DARK = "aether-dark";
const AETHER_LIGHT = "aether-light";

function presetOption(id: ColorThemePresetId): ColorThemeOption {
    return { id, colors: getEditableColors({ id }, COLOR_THEME_PRESETS[id].base) };
}

/** Every theme to choose from. Aether appears twice because it has a light and a dark version. */
function themeOptions(custom: ColorThemeColors | undefined, base: ColorThemeBase): ColorThemeViewSnapshot["groups"] {
    return [
        {
            id: "aether",
            themes: [
                { id: AETHER_DARK, colors: getEditableColors({ id: "aether" }, "dark") },
                { id: AETHER_LIGHT, colors: getEditableColors({ id: "aether" }, "light") },
                { id: "custom", colors: custom ?? getEditableColors({ id: "aether" }, base) },
            ],
        },
        {
            id: "discord",
            themes: (["discord-light", "discord-ash", "discord-dark", "discord-onyx"] as const).map(presetOption),
        },
        {
            id: "discord-legacy",
            themes: (["discord-2023-light", "discord-2023-dark", "discord-2021-dark"] as const).map(presetOption),
        },
    ];
}

/** The light or dark theme in use, or `undefined` for a high contrast or custom theme, which have no colour theme. */
function plainBase(theme: string): ColorThemeBase | undefined {
    return theme === "dark" || theme === "light" ? theme : undefined;
}

/** Lists the colour themes, and applies the one chosen or the colours edited. */
export class ColorThemeViewModel
    extends BaseViewModel<ColorThemeViewSnapshot, undefined>
    implements ColorThemeViewActions
{
    private readonly themeWatcher = new ThemeWatcher();

    public constructor() {
        super(
            undefined,
            ColorThemeViewModel.computeSnapshot(
                SettingsStore.getValue("desktopColorTheme"),
                new ThemeWatcher().getEffectiveTheme(),
            ),
        );

        this.themeWatcher.start();
        this.themeWatcher.on(ThemeWatcherEvent.Change, this.onThemeChanged);
        this.disposables.track(() => {
            this.themeWatcher.off(ThemeWatcherEvent.Change, this.onThemeChanged);
            this.themeWatcher.stop();
        });
    }

    private static computeSnapshot(setting: ColorThemeSetting, theme: string): ColorThemeViewSnapshot {
        const base = plainBase(theme);
        return {
            groups: themeOptions(setting.custom, base ?? "dark"),
            selectedId: ColorThemeViewModel.selectedId(setting, base),
            colors: getEditableColors(setting, base ?? "dark"),
        };
    }

    /** A theme only counts as selected while it applies, otherwise the page would not match the choice shown. */
    private static selectedId(setting: ColorThemeSetting, base: ColorThemeBase | undefined): string | undefined {
        if (!base) return undefined;
        if (setting.id !== "aether" && getColorThemeBase(setting) === base) return setting.id;
        return base === "dark" ? AETHER_DARK : AETHER_LIGHT;
    }

    private readonly onThemeChanged = (theme: string): void => {
        this.snapshot.set(ColorThemeViewModel.computeSnapshot(SettingsStore.getValue("desktopColorTheme"), theme));
    };

    /** Saves the choice, and switches to the light or dark theme it is built on. */
    private async apply(setting: ColorThemeSetting, base: ColorThemeBase): Promise<void> {
        // Updated before saving: a colour input snaps back if its value hasn't changed when its event ends.
        this.snapshot.set(ColorThemeViewModel.computeSnapshot(setting, base));
        try {
            await Promise.all([
                SettingsStore.setValue("desktopColorTheme", null, SettingLevel.DEVICE, setting),
                SettingsStore.setValue("use_system_theme", null, SettingLevel.DEVICE, false),
                SettingsStore.setValue("theme", null, SettingLevel.DEVICE, base),
            ]);
        } catch (error) {
            logger.error("Failed to save the colour theme", error);
        }
        // The theme watcher only reports a change of light or dark, so the colours are replaced here as well.
        dis.dispatch<RecheckThemePayload>({ action: Action.RecheckTheme, forceTheme: base });
        applyColorTheme(base);
    }

    /** Switches to one of the listed themes. */
    public selectTheme = (id: string): void => {
        const { custom } = SettingsStore.getValue("desktopColorTheme");
        if (id === AETHER_DARK || id === AETHER_LIGHT) {
            void this.apply({ id: "aether", custom }, id === AETHER_DARK ? "dark" : "light");
        } else if (id === "custom") {
            this.setCustomColors(custom ?? this.snapshot.current.colors);
        } else {
            const presetId = id as ColorThemePresetId;
            void this.apply({ id: presetId, custom }, COLOR_THEME_PRESETS[presetId].base);
        }
    };

    /** Changes one colour, starting a custom theme from whatever is on screen. */
    public setColor = (role: keyof ColorThemeColors, color: string): void => {
        this.setCustomColors({ ...this.snapshot.current.colors, [role]: color });
    };

    private setCustomColors(custom: ColorThemeColors): void {
        const setting: ColorThemeSetting = { id: "custom", custom };
        void this.apply(setting, getColorThemeBase(setting)!);
    }
}
