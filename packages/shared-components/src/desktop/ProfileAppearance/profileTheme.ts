/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type CSSProperties } from "react";

import { type ProfileTheme } from "./profileCatalogue";

/** The WCAG AA contrast ratio for body text, which every themed card must reach. */
const MIN_CONTRAST = 4.5;
const MIN_OVERLAY = 0.2;
const MAX_OVERLAY = 0.9;
const OVERLAY_STEP = 0.05;

type Rgb = readonly [number, number, number];

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];

/** Whether the value is a colour in the only format a profile may store. */
export function isHexColour(value: unknown): value is string {
    return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

function toRgb(hex: string): Rgb {
    return [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16)) as unknown as Rgb;
}

function luminance(rgb: Rgb): number {
    const [r, g, b] = rgb.map((channel) => {
        const value = channel / 255;
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: Rgb, b: Rgb): number {
    const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (light + 0.05) / (dark + 0.05);
}

function blend(colour: Rgb, over: Rgb, amount: number): Rgb {
    return colour.map((channel, index) => channel * (1 - amount) + over[index] * amount) as unknown as Rgb;
}

/** Text colour family of a themed surface. */
export type ProfileTone = "light" | "dark";

/** How a theme is applied so its text stays readable. */
export interface ProfileThemeStyle {
    /** `dark` means a dark surface with light text. */
    tone: ProfileTone;
    /** Custom properties consumed by the card's CSS. */
    style: CSSProperties;
}

/**
 * Work out how to draw two arbitrary colours as a readable card. The surface is washed towards black or white only
 * as far as needed for text to reach WCAG AA against both ends of the gradient, however extreme the colours are.
 */
export function profileThemeStyle(theme: ProfileTheme): ProfileThemeStyle {
    const primary = toRgb(theme.primary);
    const accent = toRgb(theme.accent);
    const tone: ProfileTone = (luminance(primary) + luminance(accent)) / 2 > 0.3 ? "light" : "dark";
    const [wash, text] = tone === "dark" ? [BLACK, WHITE] : [WHITE, BLACK];

    let overlay = MIN_OVERLAY;
    while (
        overlay < MAX_OVERLAY &&
        Math.min(contrast(text, blend(primary, wash, overlay)), contrast(text, blend(accent, wash, overlay))) <
            MIN_CONTRAST
    ) {
        overlay += OVERLAY_STEP;
    }
    const percent = `${Math.round(overlay * 100)}%`;
    return {
        tone,
        style: {
            "--profile-primary": theme.primary,
            "--profile-accent": theme.accent,
            "--profile-wash": percent,
        } as CSSProperties,
    };
}
