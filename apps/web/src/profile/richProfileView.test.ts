/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it, vi } from "vitest";

import { EMPTY_RICH_PROFILE } from "./richProfile";
import {
    appearanceFromRichProfile,
    boardFromRichProfile,
    linksFromRichProfile,
    localTimeFromRichProfile,
    nameStyleFromRichProfile,
} from "./richProfileView";

vi.mock("../customisations/Media", () => ({
    mediaFromMxc: (mxc: string) => ({
        srcHttp: `http://media/${mxc}`,
        getThumbnailOfSourceHttp: (width: number, height: number) => `http://thumb/${width}x${height}/${mxc}`,
    }),
}));

const BANNER = "mxc://example.org/banner";
const AVATAR = "mxc://example.org/avatar";

describe("appearanceFromRichProfile", () => {
    it("always offers a still banner, and the original only when it is animated", () => {
        const still = appearanceFromRichProfile({ ...EMPTY_RICH_PROFILE, bannerMxc: BANNER }, undefined);
        expect(still.bannerUrl).toContain("http://thumb/");
        expect(still.bannerAnimatedUrl).toBeUndefined();
        const animated = appearanceFromRichProfile(
            { ...EMPTY_RICH_PROFILE, bannerMxc: BANNER, bannerAnimated: true },
            undefined,
        );
        expect(animated.bannerAnimatedUrl).toBe(`http://media/${BANNER}`);
    });

    it("only plays an animated avatar that is still the person's avatar", () => {
        const profile = { ...EMPTY_RICH_PROFILE, animatedAvatarMxc: AVATAR };
        expect(appearanceFromRichProfile(profile, AVATAR).avatarAnimatedUrl).toBe(`http://media/${AVATAR}`);
        expect(appearanceFromRichProfile(profile, "mxc://example.org/newer").avatarAnimatedUrl).toBeUndefined();
        expect(appearanceFromRichProfile(profile, undefined).avatarAnimatedUrl).toBeUndefined();
    });

    it("resolves both kinds of nameplate", () => {
        expect(
            appearanceFromRichProfile({ ...EMPTY_RICH_PROFILE, nameplate: { preset: "tides" } }, undefined).nameplate,
        ).toEqual({ preset: "tides" });
        expect(
            appearanceFromRichProfile({ ...EMPTY_RICH_PROFILE, nameplate: { mxc: BANNER } }, undefined).nameplate,
        ).toEqual({ imageUrl: `http://thumb/480x96/${BANNER}` });
    });
});

describe("nameStyleFromRichProfile", () => {
    it("is undefined until something is set, then fills in the defaults", () => {
        expect(nameStyleFromRichProfile(EMPTY_RICH_PROFILE)).toBeUndefined();
        expect(nameStyleFromRichProfile({ ...EMPTY_RICH_PROFILE, nameColour: "#ff0000" })).toEqual({
            font: "default",
            effect: "none",
            colour: "#ff0000",
            colourEnd: undefined,
        });
    });
});

describe("linksFromRichProfile", () => {
    it("shows each link's real destination", () => {
        expect(
            linksFromRichProfile({
                ...EMPTY_RICH_PROFILE,
                links: [{ label: "My bank", url: "https://evil.example/login" }],
            }),
        ).toEqual([{ label: "My bank", url: "https://evil.example/login", host: "evil.example" }]);
    });
});

describe("boardFromRichProfile", () => {
    it("is undefined when empty, and gives every item its own identity", () => {
        expect(boardFromRichProfile(EMPTY_RICH_PROFILE)).toBeUndefined();
        const board = boardFromRichProfile({
            ...EMPTY_RICH_PROFILE,
            boardTitle: "Games",
            board: [{ title: "Same", mxc: BANNER }, { title: "Same", mxc: BANNER }, { title: "No image" }],
        });
        expect(board?.title).toBe("Games");
        expect(new Set(board?.items.map((item) => item.id)).size).toBe(3);
        expect(board?.items[2].imageUrl).toBeUndefined();
    });
});

describe("localTimeFromRichProfile", () => {
    it("formats the time in the person's timezone, and is undefined without one", () => {
        expect(localTimeFromRichProfile(EMPTY_RICH_PROFILE)).toBeUndefined();
        expect(
            localTimeFromRichProfile({ ...EMPTY_RICH_PROFILE, timezone: "UTC" }, new Date("2026-01-01T12:34:00Z")),
        ).toMatch(/12:34/);
    });
});
