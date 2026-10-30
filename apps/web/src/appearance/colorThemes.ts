/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type ColorThemeColors } from "@element-hq/web-shared-components";

import SettingsStore from "../settings/SettingsStore";

/** The Compound theme a colour theme is built on. */
export type ColorThemeBase = "dark" | "light";

/** Everything a theme paints. Colours left out keep their Compound value. */
interface ColorThemePalette extends ColorThemeColors {
    railIcon: string;
    /** The account dock. */
    dock: string;
    /** The accent where it is text or an icon rather than a fill, readable on the chat colour. */
    accentForeground: string;
    border: string;
    hover: string;
    selected: string;
    channelIcon: string;
    accentHovered: string;
    accentPressed: string;
    onAccent: string;
    /** Text and icons reporting success, such as an occupied voice channel. */
    positive?: string;
    /** The speaking ring and other solid success marks. */
    positiveSolid?: string;
    critical?: string;
    criticalSolid?: string;
    warning?: string;
}

/** The identifier of a theme that ships with Aether. */
export type ColorThemePresetId =
    | "discord-ash"
    | "discord-dark"
    | "discord-onyx"
    | "discord-light"
    | "discord-2023-dark"
    | "discord-2023-light"
    | "discord-2021-dark";

/**
 * The stored choice. `custom` holds the person's own colours and survives switching to another theme, so they can
 * come back to them.
 */
export type ColorThemeSetting = {
    id: "aether" | "custom" | ColorThemePresetId;
    custom?: ColorThemeColors;
};

interface ColorThemePreset {
    base: ColorThemeBase;
    palette: ColorThemePalette;
}

// Discord's translucent tints, as #rrggbbaa over the surface below them.
const DISCORD_TINT_12 = "#97979f1f";
const DISCORD_TINT_20 = "#97979f33";
const DISCORD_TINT_24 = "#97979f3d";
const DISCORD_TINT_28 = "#97979f47";

// The 2024 refresh shares one blurple and one set of solid status colours between its dark themes.
const DISCORD_REFRESH_DARK = {
    accent: "#5865f2",
    accentHovered: "#4452bb",
    accentPressed: "#3a48a3",
    onAccent: "#ffffff",
    positiveSolid: "#3d9e60",
    criticalSolid: "#da3e44",
    hover: DISCORD_TINT_12,
};

// The palette before the refresh. Dark and light use the same blurple and hover states.
const DISCORD_2023 = {
    accent: "#5865f2",
    accentHovered: "#4752c4",
    accentPressed: "#3c45a5",
    onAccent: "#ffffff",
};

/** The Aether identity colours, used as a starting point for a custom theme. */
const AETHER_COLORS: Record<ColorThemeBase, ColorThemeColors> = {
    dark: {
        rail: "#090a12",
        sidebar: "#090a12",
        chat: "#12142a",
        raised: "#1c1f38",
        text: "#eceaf6",
        mutedText: "#9a9cc0",
        accent: "#8ed8ea",
    },
    light: {
        rail: "#f6f5fb",
        sidebar: "#f6f5fb",
        chat: "#ffffff",
        raised: "#eceaf6",
        text: "#090a12",
        mutedText: "#4c5070",
        accent: "#1f6577",
    },
};

/**
 * Discord's themes, resolved from the tokens in its stylesheets: `.theme-dark` (Ash), `.theme-darker` (Dark),
 * `.theme-midnight` (Onyx) and `.theme-light`, and for the 2023 palette the `--primary-*` scale before the refresh.
 * The rail and sidebar are `--background-base-lowest`, the chat `--background-base-lower`, and raised surfaces
 * `--chat-background-default`, which paints the message composer. The dock is `--background-base-low`, and the
 * accent as text is `--text-brand`.
 */
export const COLOR_THEME_PRESETS: Record<ColorThemePresetId, ColorThemePreset> = {
    "discord-ash": {
        base: "dark",
        palette: {
            ...DISCORD_REFRESH_DARK,
            rail: "#2c2d32",
            sidebar: "#2c2d32",
            chat: "#323339",
            raised: "#393a41",
            railIcon: "#323339",
            dock: "#36373e",
            accentForeground: "#94a8ff",
            border: DISCORD_TINT_12,
            selected: DISCORD_TINT_20,
            text: "#f3f3f4",
            mutedText: "#abacb2",
            channelIcon: "#999aa1",
            positive: "#7ecb94",
            critical: "#ffa09b",
            warning: "#fcb529",
        },
    },
    "discord-dark": {
        base: "dark",
        palette: {
            ...DISCORD_REFRESH_DARK,
            rail: "#121214",
            sidebar: "#121214",
            chat: "#1a1a1e",
            raised: "#222327",
            railIcon: "#1a1a1e",
            dock: "#202024",
            accentForeground: "#798df9",
            border: DISCORD_TINT_12,
            selected: DISCORD_TINT_20,
            text: "#efeff1",
            mutedText: "#96979e",
            channelIcon: "#81828a",
            positive: "#5eb479",
            critical: "#f87e7a",
            warning: "#ea9800",
        },
    },
    "discord-onyx": {
        base: "dark",
        palette: {
            ...DISCORD_REFRESH_DARK,
            rail: "#000000",
            sidebar: "#000000",
            chat: "#000000",
            raised: "#101013",
            railIcon: "#000000",
            dock: "#000000",
            accentForeground: "#6374f4",
            border: DISCORD_TINT_20,
            selected: DISCORD_TINT_24,
            text: "#d4d5d8",
            mutedText: "#81828a",
            channelIcon: "#7a7b83",
            positive: "#41a063",
            critical: "#eb5f5e",
            warning: "#ce8100",
        },
    },
    "discord-light": {
        base: "light",
        palette: {
            accent: "#5865f2",
            accentHovered: "#4452bb",
            accentPressed: "#3a48a3",
            onAccent: "#ffffff",
            rail: "#f3f3f4",
            sidebar: "#f3f3f4",
            chat: "#fbfbfb",
            raised: "#ffffff",
            railIcon: "#fbfbfb",
            dock: "#fbfbfb",
            accentForeground: "#525fe0",
            border: DISCORD_TINT_28,
            hover: DISCORD_TINT_12,
            selected: DISCORD_TINT_24,
            text: "#2e2e34",
            mutedText: "#6c6d76",
            channelIcon: "#666770",
            positive: "#01713a",
            positiveSolid: "#269153",
            critical: "#b92733",
            criticalSolid: "#d6363f",
            warning: "#945300",
        },
    },
    "discord-2023-dark": {
        base: "dark",
        palette: {
            ...DISCORD_2023,
            rail: "#1e1f22",
            sidebar: "#2b2d31",
            chat: "#313338",
            raised: "#383a40",
            railIcon: "#313338",
            dock: "#232428",
            accentForeground: "#949cf7",
            border: "#4e50587a",
            hover: "#4e50584d",
            selected: "#4e505899",
            text: "#dbdee1",
            mutedText: "#949ba4",
            channelIcon: "#80848e",
            positive: "#23a55a",
            positiveSolid: "#23a55a",
            critical: "#fa777b",
            criticalSolid: "#da373c",
            warning: "#f0b232",
        },
    },
    "discord-2023-light": {
        base: "light",
        palette: {
            ...DISCORD_2023,
            rail: "#e3e5e8",
            sidebar: "#f2f3f5",
            chat: "#ffffff",
            raised: "#ebedef",
            railIcon: "#ffffff",
            dock: "#ebedef",
            accentForeground: "#4752c4",
            border: "#6d6f783d",
            hover: "#6d6f7829",
            selected: "#6d6f783d",
            text: "#313338",
            mutedText: "#5c5e66",
            channelIcon: "#6d6f78",
            positive: "#24934e",
            positiveSolid: "#24934e",
            critical: "#da373c",
            criticalSolid: "#da373c",
            warning: "#f0b232",
        },
    },
    "discord-2021-dark": {
        base: "dark",
        palette: {
            ...DISCORD_2023,
            rail: "#202225",
            sidebar: "#2f3136",
            chat: "#36393f",
            raised: "#40444b",
            railIcon: "#36393f",
            dock: "#292b2f",
            accentForeground: "#949cf7",
            border: "#4f545c7a",
            hover: "#4f545c29",
            selected: "#4f545c52",
            text: "#dcddde",
            mutedText: "#a3a6aa",
            channelIcon: "#96989d",
            positive: "#3ba55d",
            positiveSolid: "#3ba55d",
            critical: "#fa777b",
            criticalSolid: "#ed4245",
            warning: "#faa81a",
        },
    },
};

/** The relative luminance of a `#rrggbb` colour, as defined by WCAG. */
function luminance(color: string): number {
    const [red, green, blue] = [1, 3, 5].map((start) => {
        const channel = parseInt(color.slice(start, start + 2), 16) / 255;
        return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** Whichever of black and white is easier to read on the given colour. */
function readableOn(color: string): string {
    return (luminance(color) + 0.05) / 0.05 > 1.05 / (luminance(color) + 0.05) ? "#000000" : "#ffffff";
}

/** The contrast ratio between two `#rrggbb` colours, as defined by WCAG. */
export function contrast(first: string, second: string): number {
    const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
    return (lighter + 0.05) / (darker + 0.05);
}

/** Mixes two `#rrggbb` colours, where an amount of 1 gives all of the second. */
function mix(from: string, to: string, amount: number): string {
    const channels = [1, 3, 5].map((start) => {
        const [a, b] = [from, to].map((color) => parseInt(color.slice(start, start + 2), 16));
        return Math.round(a + (b - a) * amount)
            .toString(16)
            .padStart(2, "0");
    });
    return `#${channels.join("")}`;
}

/** The accent, moved towards the text colour only as far as it takes to be readable on the chat colour. */
function readableAccent({ accent, text, chat }: ColorThemeColors): string {
    for (let amount = 0; amount < 1; amount += 0.1) {
        const color = mix(accent, text, amount);
        if (contrast(color, chat) >= 4.5) return color;
    }
    return text;
}

/** A custom theme is dark or light according to its chat background. */
function customBase(colors: ColorThemeColors): ColorThemeBase {
    return readableOn(colors.chat) === "#ffffff" ? "dark" : "light";
}

/** Fills in the colours a custom theme doesn't ask for, so that any choice stays consistent. */
function customPalette(colors: ColorThemeColors): ColorThemePalette {
    const shade = customBase(colors) === "dark" ? "black" : "white";
    return {
        ...colors,
        railIcon: colors.raised,
        dock: colors.raised,
        accentForeground: readableAccent(colors),
        border: `color-mix(in srgb, ${colors.text} 14%, transparent)`,
        hover: `color-mix(in srgb, ${colors.text} 6%, transparent)`,
        selected: `color-mix(in srgb, ${colors.text} 12%, transparent)`,
        channelIcon: colors.mutedText,
        accentHovered: `color-mix(in srgb, ${colors.accent} 85%, ${shade})`,
        accentPressed: `color-mix(in srgb, ${colors.accent} 75%, ${shade})`,
        onAccent: readableOn(colors.accent),
    };
}

/**
 * The light or dark theme a colour theme needs, or `undefined` for Aether's own colours, which work with either.
 */
export function getColorThemeBase(setting: ColorThemeSetting): ColorThemeBase | undefined {
    if (setting.id === "aether") return undefined;
    if (setting.id === "custom") return setting.custom ? customBase(setting.custom) : undefined;
    return COLOR_THEME_PRESETS[setting.id]?.base;
}

/**
 * The colours to start editing from when a person customises the given theme.
 * @param setting - the current choice
 * @param base - the light or dark theme in use, which decides the colours of Aether's own theme
 */
export function getEditableColors(setting: ColorThemeSetting, base: ColorThemeBase): ColorThemeColors {
    if (setting.id === "custom" && setting.custom) return setting.custom;
    const preset = setting.id === "aether" || setting.id === "custom" ? undefined : COLOR_THEME_PRESETS[setting.id];
    if (!preset) return AETHER_COLORS[base];
    const { rail, sidebar, chat, raised, text, mutedText, accent } = preset.palette;
    return { rail, sidebar, chat, raised, text, mutedText, accent };
}

/** Maps a palette onto the variables the desktop shell and Compound read. */
function paletteVariables(palette: ColorThemePalette): Record<string, string | undefined> {
    return {
        "--mx-desktop-rail-background": palette.rail,
        "--mx-desktop-rail-icon-background": palette.railIcon,
        "--mx-desktop-dock-background": palette.dock,
        "--mx-desktop-shell-frame": palette.sidebar,
        "--cpd-color-bg-subtle-secondary": palette.sidebar,
        "--cpd-color-bg-canvas-default": palette.chat,
        "--ae-surface-raised": palette.raised,
        "--ae-border": palette.border,
        "--cpd-color-bg-action-tertiary-hovered": palette.hover,
        "--cpd-color-bg-action-tertiary-selected": palette.selected,
        "--ae-text": palette.text,
        "--ae-text-muted": palette.mutedText,
        "--cpd-color-icon-tertiary": palette.channelIcon,
        "--ae-accent": palette.accent,
        "--ae-accent-foreground": palette.accentForeground,
        "--ae-focus": palette.accent,
        "--ae-accent-hovered": palette.accentHovered,
        "--ae-accent-pressed": palette.accentPressed,
        "--ae-on-accent": palette.onAccent,
        "--cpd-color-text-success-primary": palette.positive,
        "--cpd-color-icon-success-primary": palette.positive,
        "--cpd-color-border-success-primary": palette.positiveSolid,
        "--cpd-color-text-critical-primary": palette.critical,
        "--cpd-color-icon-critical-primary": palette.critical,
        "--cpd-color-bg-critical-primary": palette.criticalSolid,
        "--cpd-color-icon-warning-primary": palette.warning,
    };
}

const THEME_VARIABLES = Object.keys(paletteVariables(customPalette(AETHER_COLORS.dark)));

function getPalette(setting: ColorThemeSetting): ColorThemePalette | undefined {
    if (setting.id === "aether") return undefined;
    if (setting.id === "custom") return setting.custom && customPalette(setting.custom);
    return COLOR_THEME_PRESETS[setting.id]?.palette;
}

/**
 * Paints the chosen colour theme onto the page, if it applies: a theme needs its own light or dark base, and high
 * contrast and custom themes keep their colours.
 *
 * Inline variables on the body win over the theme stylesheets and reach everything, including portalled dialogs.
 *
 * @param theme - the theme in use, as given to `setTheme`
 */
export function paintColorTheme(theme: string): void {
    if (!SettingsStore.getValue("feature_desktop_shell") || theme.startsWith("custom-")) return;
    const setting = SettingsStore.getValue("desktopColorTheme");
    const palette = getPalette(setting);
    if (!palette || !document.body.classList.contains(`cpd-theme-${getColorThemeBase(setting)}`)) return;

    for (const [variable, value] of Object.entries(paletteVariables(palette))) {
        if (value) document.body.style.setProperty(variable, value);
    }
}

/**
 * Replaces the colours on the page with the chosen colour theme's, for when the choice changes without `setTheme`
 * running, which only happens on a change of light or dark.
 *
 * @param theme - the theme in use, as given to `setTheme`
 */
export function applyColorTheme(theme: string): void {
    for (const variable of THEME_VARIABLES) document.body.style.removeProperty(variable);
    paintColorTheme(theme);
}
