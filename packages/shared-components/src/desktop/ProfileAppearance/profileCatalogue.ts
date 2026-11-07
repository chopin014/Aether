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
    "ringed",
    "event-horizon",
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
    "comets",
    "nebula",
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
    "synthwave",
    "orbit",
    "singularity",
    "grove",
] as const;
/** A built-in scene drawn behind the name in member lists. */
export type ProfileNameplateId = (typeof PROFILE_NAMEPLATES)[number];

/**
 * The colour each nameplate tints its row with, so the scene bleeds into the row instead of sitting on it like a
 * sticker. Discord does the same with a palette per nameplate.
 */
export const PROFILE_NAMEPLATE_PALETTES: Record<ProfileNameplateId, string> = {
    moonlit: "#7f93e6",
    blossom: "#ff8fb8",
    roses: "#d4246a",
    nebula: "#5b8fe0",
    aurora: "#2be8a6",
    embers: "#ff6a1f",
    tides: "#f2a07a",
    circuit: "#28f0d8",
    synthwave: "#ff3fa4",
    orbit: "#8ed8ea",
    singularity: "#8ed8ea",
    grove: "#a7f0c9",
};

export const PROFILE_NAME_FONTS = [
    "default",
    "pixel",
    "medieval",
    "script",
    "scifi",
    "rounded",
    "horror",
    "bubbly",
    "slab",
    "handwritten",
    "rock",
    "modern",
    "jelly",
] as const;
/** A bundled font for the display name. */
export type ProfileNameFont = (typeof PROFILE_NAME_FONTS)[number];

export const PROFILE_NAME_EFFECTS = [
    "none",
    "gradient",
    "shimmer",
    "neon",
    "outline",
    "glow",
    "toon",
    "pop",
    "prism",
    "gummy",
] as const;
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

/**
 * What is drawn behind the name in a member list: a built-in scene or the person's own image. An animated image has a
 * still version shown at rest and the original played while the row is active.
 */
export type ProfileNameplateValue =
    | { preset: ProfileNameplateId }
    | {
          imageUrl: string;
          animatedUrl?: string;
      };

/** The part of an image to show, as fractions of its width and height from the top-left corner. */
export interface ProfileImageFrame {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * CSS that shows only the framed part of an image, without redrawing it, so an animated image keeps moving. The
 * thumbnail and the original share their proportions, so one frame fits both.
 */
export function imageFrameStyle(frame: ProfileImageFrame | undefined): Record<string, string> | undefined {
    if (!frame) return undefined;
    const percent = (n: number): string => `${(Math.max(0, n) * 100).toFixed(2)}%`;
    return {
        objectViewBox: `inset(${percent(frame.y)} ${percent(1 - frame.x - frame.width)} ${percent(
            1 - frame.y - frame.height,
        )} ${percent(frame.x)})`,
    };
}

/** Everything that changes how a person's profile looks. Each field is optional and falls back to the plain design. */
export interface DesktopProfileAppearance {
    /** A still banner image. */
    bannerUrl?: string;
    /** The original animated banner, played while the card is active. */
    bannerAnimatedUrl?: string;
    /** The part of the banner to show, for an animated banner framed without redrawing it. */
    bannerFrame?: ProfileImageFrame;
    /** The original animated avatar, played while the card is active. */
    avatarAnimatedUrl?: string;
    theme?: ProfileTheme;
    decoration?: ProfileDecorationId;
    effect?: ProfileEffectId;
    nameplate?: ProfileNameplateValue;
    nameStyle?: ProfileNameStyle;
}
