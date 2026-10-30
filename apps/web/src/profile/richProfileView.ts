/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    type DesktopProfileAppearance,
    type DesktopProfileBoard,
    type DesktopProfileLink,
    type ProfileNameStyle,
} from "@element-hq/web-shared-components";

import { mediaFromMxc } from "../customisations/Media";
import { parseProfileUrl, type RichProfile } from "./richProfile";

function thumbnail(mxc: string, width: number, height: number): string | undefined {
    return mediaFromMxc(mxc).getThumbnailOfSourceHttp(width, height, "scale") ?? undefined;
}

/** The name style, if any part of it was set. */
export function nameStyleFromRichProfile(profile: RichProfile): ProfileNameStyle | undefined {
    if (!profile.nameFont && !profile.nameEffect && !profile.nameColour) return undefined;
    return {
        font: profile.nameFont ?? "default",
        effect: profile.nameEffect ?? "none",
        colour: profile.nameColour,
        colourEnd: profile.nameColourEnd,
    };
}

/**
 * Resolve a validated profile into what the views draw.
 * @param avatarMxc The person's current avatar: their animated avatar is only played if it still is that image.
 */
export function appearanceFromRichProfile(
    profile: RichProfile,
    avatarMxc: string | undefined,
): DesktopProfileAppearance {
    const nameplate = profile.nameplate;
    return {
        bannerUrl: profile.bannerMxc && thumbnail(profile.bannerMxc, 960, 384),
        bannerAnimatedUrl:
            profile.bannerMxc && profile.bannerAnimated
                ? (mediaFromMxc(profile.bannerMxc).srcHttp ?? undefined)
                : undefined,
        avatarAnimatedUrl:
            avatarMxc && profile.animatedAvatarMxc === avatarMxc
                ? (mediaFromMxc(avatarMxc).srcHttp ?? undefined)
                : undefined,
        theme: profile.theme,
        decoration: profile.decoration,
        effect: profile.effect,
        nameplate:
            nameplate && "preset" in nameplate
                ? nameplate
                : nameplate
                  ? { imageUrl: thumbnail(nameplate.mxc, 480, 96) ?? "" }
                  : undefined,
        nameStyle: nameStyleFromRichProfile(profile),
    };
}

/** The person's links with the destinations shown beside them. */
export function linksFromRichProfile(profile: RichProfile): DesktopProfileLink[] {
    return profile.links.flatMap((link) => {
        const parsed = parseProfileUrl(link.url);
        return parsed ? [{ url: parsed.url, label: link.label, host: parsed.host }] : [];
    });
}

/** The person's board, or undefined when it is empty. */
export function boardFromRichProfile(profile: RichProfile): DesktopProfileBoard | undefined {
    if (!profile.board.length) return undefined;
    return {
        title: profile.boardTitle ?? "",
        items: profile.board.map((item, index) => ({
            id: `${index}-${item.mxc ?? item.title}`,
            title: item.title,
            caption: item.caption,
            imageUrl: item.mxc ? thumbnail(item.mxc, 320, 426) : undefined,
        })),
    };
}

/** The current time where the person is, in the viewer's format, or undefined without a known timezone. */
export function localTimeFromRichProfile(profile: RichProfile, now = new Date()): string | undefined {
    if (!profile.timezone) return undefined;
    return new Intl.DateTimeFormat(undefined, { timeZone: profile.timezone, timeStyle: "short" }).format(now);
}
