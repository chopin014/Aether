/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type ChangeEvent, type JSX } from "react";
import { Text } from "@vector-im/compound-web";
import { CheckIcon } from "@vector-im/compound-design-tokens/assets/web/icons";

import { type ViewModel, useViewModel } from "../../core/viewmodel";
import { useI18n } from "../../core/i18n/i18nContext";
import { _td } from "../../core/i18n/i18n";
import styles from "./ColorThemeView.module.css";

/** The colours of a theme a person can see and edit, each a `#rrggbb` value. */
export interface ColorThemeColors {
    rail: string;
    sidebar: string;
    chat: string;
    raised: string;
    text: string;
    mutedText: string;
    accent: string;
}

/** A theme to choose from. */
export interface ColorThemeOption {
    id: string;
    colors: ColorThemeColors;
}

/** A titled set of themes. */
export interface ColorThemeGroup {
    id: string;
    themes: ColorThemeOption[];
}

export interface ColorThemeViewSnapshot {
    groups: ColorThemeGroup[];
    /** The theme in use. Absent under a high contrast or custom theme, where colour themes don't apply. */
    selectedId?: string;
    /** The colours shown in the editor. */
    colors: ColorThemeColors;
}

export interface ColorThemeViewActions {
    /** Switch to one of the listed themes. */
    selectTheme: (id: string) => void;
    /** Change one colour, which moves to the custom theme. */
    setColor: (role: keyof ColorThemeColors, color: string) => void;
}

export type ColorThemeViewModel = ViewModel<ColorThemeViewSnapshot, ColorThemeViewActions>;

interface ColorThemeViewProps {
    /** The view model providing the themes and applying the choice. */
    vm: ColorThemeViewModel;
}

const GROUP_TITLES: Record<string, TranslationKey> = {
    "aether": _td("desktop|color_theme|group_aether"),
    "discord": _td("desktop|color_theme|group_discord"),
    "discord-legacy": _td("desktop|color_theme|group_discord_legacy"),
};

const THEME_NAMES: Record<string, TranslationKey> = {
    "aether-dark": _td("desktop|color_theme|aether_dark"),
    "aether-light": _td("desktop|color_theme|aether_light"),
    "custom": _td("desktop|color_theme|custom"),
    "discord-light": _td("desktop|color_theme|discord_light"),
    "discord-ash": _td("desktop|color_theme|discord_ash"),
    "discord-dark": _td("desktop|color_theme|discord_dark"),
    "discord-onyx": _td("desktop|color_theme|discord_onyx"),
    "discord-2023-light": _td("desktop|color_theme|discord_2023_light"),
    "discord-2023-dark": _td("desktop|color_theme|discord_2023_dark"),
    "discord-2021-dark": _td("desktop|color_theme|discord_2021_dark"),
};

const COLOR_ROLES: { role: keyof ColorThemeColors; label: TranslationKey }[] = [
    { role: "rail", label: _td("desktop|color_theme|role_rail") },
    { role: "sidebar", label: _td("desktop|color_theme|role_sidebar") },
    { role: "chat", label: _td("desktop|color_theme|role_chat") },
    { role: "raised", label: _td("desktop|color_theme|role_raised") },
    { role: "text", label: _td("desktop|color_theme|role_text") },
    { role: "mutedText", label: _td("desktop|color_theme|role_muted_text") },
    { role: "accent", label: _td("desktop|color_theme|role_accent") },
];

/** A miniature of the app in a theme's colours. */
function ThemePreview({ colors }: Readonly<{ colors: ColorThemeColors }>): JSX.Element {
    return (
        <span className={styles.preview} style={{ background: colors.chat }} aria-hidden="true">
            <span className={styles.previewRail} style={{ background: colors.rail }}>
                <span className={styles.previewDot} style={{ background: colors.accent }} />
            </span>
            <span className={styles.previewSidebar} style={{ background: colors.sidebar }}>
                <span className={styles.previewLine} style={{ background: colors.mutedText }} />
                <span className={styles.previewLine} style={{ background: colors.mutedText }} />
            </span>
            <span className={styles.previewChat}>
                <span className={styles.previewLine} style={{ background: colors.text }} />
                <span className={styles.previewComposer} style={{ background: colors.raised }} />
            </span>
        </span>
    );
}

/**
 * Lets a person pick the app's colours from a set of themes, or set their own.
 *
 * @example
 * ```tsx
 * <ColorThemeView vm={colorThemeViewModel} />
 * ```
 */
export function ColorThemeView({ vm }: Readonly<ColorThemeViewProps>): JSX.Element {
    const { translate: _t } = useI18n();
    const { groups, selectedId, colors } = useViewModel(vm);

    return (
        <section className={styles.root} data-testid="colorThemePanel">
            <Text as="h3" size="lg" weight="semibold" className={styles.heading}>
                {_t("desktop|color_theme|title")}
            </Text>
            {groups.map((group) => (
                <div key={group.id} role="radiogroup" aria-label={_t(GROUP_TITLES[group.id])}>
                    <Text as="div" size="sm" weight="medium" className={styles.groupTitle}>
                        {_t(GROUP_TITLES[group.id])}
                    </Text>
                    <div className={styles.grid}>
                        {group.themes.map((theme) => (
                            <label key={theme.id} className={styles.tile} data-selected={theme.id === selectedId}>
                                <input
                                    type="radio"
                                    name="colorTheme"
                                    className={styles.visuallyHidden}
                                    value={theme.id}
                                    checked={theme.id === selectedId}
                                    onChange={() => vm.selectTheme(theme.id)}
                                />
                                <ThemePreview colors={theme.colors} />
                                <span className={styles.name}>
                                    {_t(THEME_NAMES[theme.id])}
                                    {theme.id === selectedId && <CheckIcon className={styles.check} aria-hidden />}
                                </span>
                            </label>
                        ))}
                    </div>
                </div>
            ))}
            <div>
                <Text as="div" size="sm" weight="medium" className={styles.groupTitle}>
                    {_t("desktop|color_theme|customize")}
                </Text>
                <Text as="p" size="sm" className={styles.description}>
                    {_t("desktop|color_theme|customize_description")}
                </Text>
                <div className={styles.colors}>
                    {COLOR_ROLES.map(({ role, label }) => (
                        <label key={role} className={styles.color}>
                            <input
                                type="color"
                                className={styles.colorInput}
                                value={colors[role]}
                                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                                    vm.setColor(role, event.target.value)
                                }
                            />
                            <span className={styles.colorLabel}>
                                {_t(label)}
                                <span className={styles.colorValue}>{colors[role]}</span>
                            </span>
                        </label>
                    ))}
                </div>
            </div>
        </section>
    );
}
