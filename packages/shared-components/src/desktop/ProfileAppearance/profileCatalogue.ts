/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/**
 * Everything a profile may ask to be drawn with. A profile stores only these identifiers: the art itself ships with
 * Aether, so another person's profile can never run markup, styles or scripts of their choosing.
 */
export const PROFILE_DECORATIONS = [
    "neon-ring",
    "flame-crown",
    "sakura-wreath",
    "frost-crown",
    "halo",
    "orbit",
    "thorn-rose",
    "cat-ears",
    "galaxy",
    "glitch",
] as const;
/** A built-in frame drawn around the avatar. */
export type ProfileDecorationId = (typeof PROFILE_DECORATIONS)[number];

export const PROFILE_EFFECTS = [
    "snow",
    "sakura",
    "stars",
    "embers",
    "fireflies",
    "rain",
    "aurora",
    "confetti",
] as const;
/** A built-in animation drawn over the whole profile card. */
export type ProfileEffectId = (typeof PROFILE_EFFECTS)[number];

export const PROFILE_NAMEPLATES = [
    "moonlit",
    "blossom",
    "roses",
    "nebula",
    "aurora",
    "embers",
    "tides",
    "circuit",
] as const;
/** A built-in scene drawn behind the name in member lists. */
export type ProfileNameplateId = (typeof PROFILE_NAMEPLATES)[number];

export const PROFILE_NAME_FONTS = ["default", "pixel", "medieval", "script", "scifi", "rounded", "horror"] as const;
/** A bundled font for the display name. */
export type ProfileNameFont = (typeof PROFILE_NAME_FONTS)[number];

export const PROFILE_NAME_EFFECTS = ["none", "gradient", "shimmer", "neon", "outline"] as const;
/** How the display name's colours are applied. */
export type ProfileNameEffect = (typeof PROFILE_NAME_EFFECTS)[number];

/** Colours of the two-tone profile theme, as `#rrggbb`. */
export interface ProfileTheme {
    primary: string;
    accent: string;
}

/** How a display name is drawn. */
export interface ProfileNameStyle {
    font: ProfileNameFont;
    effect: ProfileNameEffect;
    /** Main colour as `#rrggbb`; the surrounding text colour is used when omitted. */
    colour?: string;
    /** Second colour of a gradient as `#rrggbb`. */
    colourEnd?: string;
}

/** What is drawn behind the name in a member list: a built-in scene or the person's own image. */
export type ProfileNameplateValue = { preset: ProfileNameplateId } | { imageUrl: string };

/** Everything that changes how a person's profile looks. Each field is optional and falls back to the plain design. */
export interface DesktopProfileAppearance {
    /** A still banner image. */
    bannerUrl?: string;
    /** The original animated banner, played while the card is active. */
    bannerAnimatedUrl?: string;
    /** The original animated avatar, played while the card is active. */
    avatarAnimatedUrl?: string;
    theme?: ProfileTheme;
    decoration?: ProfileDecorationId;
    effect?: ProfileEffectId;
    nameplate?: ProfileNameplateValue;
    nameStyle?: ProfileNameStyle;
}
