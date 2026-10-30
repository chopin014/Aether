// @vitest-environment jsdom
/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";
import { unmockIntlDateTimeFormat } from "test-utils/date";

import {
    BANNER_FIELD,
    BIO_FIELD_COMMET,
    BIO_FIELD_MSC4440,
    BIO_FIELD_SABLE,
    buildProfileWrites,
    EMPTY_RICH_PROFILE,
    MAX_BIO_LENGTH,
    MAX_BOARD_ITEMS,
    MAX_LINKS,
    NAME_COLOUR_FIELD,
    parseProfileUrl,
    parseRichProfile,
    PRONOUNS_FIELD_STABLE,
    PRONOUNS_FIELD_UNSTABLE,
    RICH_PROFILE_FIELD,
    richFieldBytes,
    serialiseRichField,
    STATUS_FIELD,
    type RichProfile,
} from "./richProfile";

describe("parseRichProfile", () => {
    it("reads a complete Aether profile", () => {
        const profile = parseRichProfile({
            [BANNER_FIELD]: "mxc://example.org/banner",
            [RICH_PROFILE_FIELD]: {
                v: 1,
                banner_animated: true,
                theme: { primary: "#101018", accent: "#2a0a40" },
                decoration: "flame-crown",
                effect: "snow",
                nameplate: { preset: "moonlit" },
                name: { font: "pixel", effect: "neon", colour: "#ff0000", colour_end: "#00ff00" },
                links: [{ label: "Site", url: "https://example.org" }],
                board: { title: "Games", items: [{ title: "Squad", caption: "brrr", mxc: "mxc://example.org/a" }] },
                tag: "!space:example.org",
            },
        });
        expect(profile).toMatchObject({
            bannerMxc: "mxc://example.org/banner",
            bannerAnimated: true,
            theme: { primary: "#101018", accent: "#2a0a40" },
            decoration: "flame-crown",
            effect: "snow",
            nameplate: { preset: "moonlit" },
            nameFont: "pixel",
            nameEffect: "neon",
            nameColour: "#ff0000",
            nameColourEnd: "#00ff00",
            links: [{ label: "Site", url: "https://example.org/" }],
            boardTitle: "Games",
            board: [{ title: "Squad", caption: "brrr", mxc: "mxc://example.org/a" }],
            tagSpaceId: "!space:example.org",
        });
    });

    it("ignores everything malformed rather than passing it to the views", () => {
        const profile = parseRichProfile({
            [BANNER_FIELD]: "https://tracker.example/pixel.gif",
            [RICH_PROFILE_FIELD]: {
                theme: { primary: "red;background:url(https://tracker.example)", accent: "#2a0a40" },
                decoration: "../../evil",
                effect: { toString: "x" },
                nameplate: { mxc: "https://tracker.example/plate.png" },
                name: { font: "Comic Sans", effect: "expression(alert(1))", colour: "url(x)" },
                links: [
                    { label: "bad", url: "javascript:alert(1)" },
                    { label: "bad", url: "data:text/html,<script>alert(1)</script>" },
                    { label: "bad", url: "https://user:pass@example.org/" },
                    "not an object",
                ],
                board: { items: [{ mxc: "http://tracker.example/a.png" }, 7] },
                tag: "not a room id",
            },
        });
        expect(profile).toMatchObject({ links: [], board: [] });
        for (const key of [
            "bannerMxc",
            "theme",
            "decoration",
            "effect",
            "nameplate",
            "nameFont",
            "nameEffect",
            "nameColour",
            "tagSpaceId",
        ] as const) {
            expect(profile[key]).toBeUndefined();
        }
    });

    it.each([null, 5, "text", [], true])("survives an Aether field of %j", (value) => {
        expect(parseRichProfile({ [RICH_PROFILE_FIELD]: value })).toMatchObject({ links: [], board: [] });
    });

    it("caps lengths and counts", () => {
        const profile = parseRichProfile({
            [BIO_FIELD_MSC4440]: { "m.text": [{ body: "x".repeat(MAX_BIO_LENGTH * 2) }] },
            [RICH_PROFILE_FIELD]: {
                links: Array.from({ length: 50 }, (_, i) => ({ label: "a", url: `https://example.org/${i}` })),
                board: { items: Array.from({ length: 50 }, () => ({ title: "x", mxc: "mxc://example.org/a" })) },
            },
        });
        expect(profile.bio).toHaveLength(MAX_BIO_LENGTH);
        expect(profile.links).toHaveLength(MAX_LINKS);
        expect(profile.board).toHaveLength(MAX_BOARD_ITEMS);
    });

    it("removes bidirectional controls that could disguise a label", () => {
        const profile = parseRichProfile({
            [RICH_PROFILE_FIELD]: { links: [{ label: "safe‮txt.exe", url: "https://example.org" }] },
        });
        expect(profile.links[0].label).toBe("safetxt.exe");
    });

    describe("fields from other clients", () => {
        it("reads a banner and a bio written by Commet", () => {
            const profile = parseRichProfile({
                [BANNER_FIELD]: "mxc://example.org/b",
                [BIO_FIELD_COMMET]: { format: "org.matrix.custom.html", formatted_body: "Hello<br/><b>world</b>" },
            });
            expect(profile.bannerMxc).toBe("mxc://example.org/b");
            expect(profile.bio).toBe("Hello\nworld");
        });

        it("prefers the plain text of MSC4440 and reduces HTML to text", () => {
            expect(
                parseRichProfile({
                    [BIO_FIELD_MSC4440]: {
                        "m.text": [
                            { body: "<i>rich</i>", mimetype: "text/html" },
                            { body: "plain", mimetype: "text/plain" },
                        ],
                    },
                }).bio,
            ).toBe("plain");
            expect(
                parseRichProfile({
                    [BIO_FIELD_MSC4440]: { "m.text": [{ body: "<i>rich</i>", mimetype: "text/html" }] },
                }).bio,
            ).toBe("rich");
        });

        it("strips markup from a Sable bio without ever keeping it", () => {
            const bio = parseRichProfile({
                [BIO_FIELD_SABLE]: '<img src=x onerror="alert(1)">Hi<script>evil()</script>',
            }).bio;
            expect(bio).not.toContain("<");
            expect(bio).toContain("Hi");
        });

        it("reads pronouns from the stable field first, then the unstable one", () => {
            expect(parseRichProfile({ [PRONOUNS_FIELD_UNSTABLE]: [{ summary: "they/them" }] }).pronouns).toBe(
                "they/them",
            );
            expect(
                parseRichProfile({
                    [PRONOUNS_FIELD_STABLE]: [{ summary: "she/her" }],
                    [PRONOUNS_FIELD_UNSTABLE]: [{ summary: "they/them" }],
                }).pronouns,
            ).toBe("she/her");
        });

        it("uses a Sable name colour when Aether has none", () => {
            expect(parseRichProfile({ [NAME_COLOUR_FIELD]: "#123456" }).nameColour).toBe("#123456");
            expect(parseRichProfile({ [NAME_COLOUR_FIELD]: "pink" }).nameColour).toBeUndefined();
        });
    });

    it("reads a status and a usable timezone", () => {
        // The test setup replaces this with a version that pins every timezone to UTC.
        unmockIntlDateTimeFormat();
        const profile = parseRichProfile({
            [STATUS_FIELD]: { emoji: "🎧🎧", text: " Listening " },
            "m.tz": "America/Sao_Paulo",
        });
        expect(profile.status).toEqual({ emoji: "🎧", text: "Listening" });
        expect(profile.timezone).toBe("America/Sao_Paulo");
        expect(parseRichProfile({ "m.tz": "Mars/Olympus" }).timezone).toBeUndefined();
    });
});

describe("parseProfileUrl", () => {
    it("shows an internationalised lookalike host in its real form", () => {
        expect(parseProfileUrl("https://аррӏе.com/")?.host).toMatch(/^xn--/);
    });

    it("rejects anything but plain http(s)", () => {
        for (const value of [
            "ftp://x.org",
            "javascript:alert(1)",
            "not a url",
            "",
            1,
            "https://a:b@x.org",
            `https://x.org/${"a".repeat(600)}`,
        ]) {
            expect(parseProfileUrl(value)).toBeUndefined();
        }
    });
});

describe("serialiseRichField", () => {
    const decorated: RichProfile = {
        ...EMPTY_RICH_PROFILE,
        decoration: "halo",
        nameFont: "pixel",
        nameEffect: "neon",
        links: [{ label: "Site", url: "https://example.org/" }],
    };

    it("stores nothing for an empty profile", () => {
        expect(serialiseRichField(EMPTY_RICH_PROFILE)).toBeUndefined();
    });

    it("round-trips through parsing", () => {
        const parsed = parseRichProfile({ [RICH_PROFILE_FIELD]: serialiseRichField(decorated) });
        expect(parsed).toMatchObject({
            decoration: "halo",
            nameFont: "pixel",
            nameEffect: "neon",
            links: decorated.links,
        });
    });

    it("keeps fields a newer client wrote and it does not understand", () => {
        const field = serialiseRichField(decorated, { future_thing: { a: 1 }, decoration: "orbit" });
        expect(field).toMatchObject({ future_thing: { a: 1 }, decoration: "halo" });
    });

    it("does not store the defaults", () => {
        const field = serialiseRichField({
            ...EMPTY_RICH_PROFILE,
            nameFont: "default",
            nameEffect: "none",
            decoration: "halo",
        });
        expect(field).toEqual({ v: 1, decoration: "halo" });
    });

    it("measures the stored size", () => {
        expect(richFieldBytes(EMPTY_RICH_PROFILE)).toBe(2);
        expect(richFieldBytes(decorated)).toBeGreaterThan(10);
    });
});

describe("buildProfileWrites", () => {
    it("writes nothing when nothing changed", () => {
        const raw = { [RICH_PROFILE_FIELD]: { v: 1, decoration: "halo" } };
        const current = parseRichProfile(raw);
        expect(buildProfileWrites(raw, current, current, "en")).toEqual([]);
    });

    it("writes nothing when the server returned the same field with its keys reordered", () => {
        const raw = { [RICH_PROFILE_FIELD]: { decoration: "halo", name: { font: "pixel", effect: "neon" }, v: 1 } };
        const current = parseRichProfile(raw);
        expect(buildProfileWrites(raw, current, current, "en")).toEqual([]);
    });

    it("writes a bio to every field other clients read, with its markup escaped", () => {
        const writes = buildProfileWrites({}, EMPTY_RICH_PROFILE, { ...EMPTY_RICH_PROFILE, bio: "a<b>\nc" }, "en");
        expect(writes).toEqual([
            { key: BIO_FIELD_MSC4440, value: { "m.text": [{ body: "a<b>\nc", mimetype: "text/plain" }] } },
            { key: BIO_FIELD_COMMET, value: { format: "org.matrix.custom.html", formatted_body: "a&lt;b&gt;<br/>c" } },
            { key: BIO_FIELD_SABLE, value: "a&lt;b&gt;<br/>c" },
        ]);
    });

    it("deletes what was cleared", () => {
        const raw = {
            [BANNER_FIELD]: "mxc://example.org/b",
            [PRONOUNS_FIELD_UNSTABLE]: [{ summary: "they/them" }],
            [RICH_PROFILE_FIELD]: { v: 1, decoration: "halo" },
        };
        const writes = buildProfileWrites(raw, parseRichProfile(raw), EMPTY_RICH_PROFILE, "en");
        expect(writes).toEqual(
            expect.arrayContaining([
                { key: RICH_PROFILE_FIELD, value: null },
                { key: BANNER_FIELD, value: null },
                { key: PRONOUNS_FIELD_UNSTABLE, value: null },
            ]),
        );
    });

    it("records pronouns with the editing language", () => {
        expect(
            buildProfileWrites({}, EMPTY_RICH_PROFILE, { ...EMPTY_RICH_PROFILE, pronouns: "ela/dela" }, "pt-BR"),
        ).toContainEqual({
            key: PRONOUNS_FIELD_UNSTABLE,
            value: [{ language: "pt-BR", summary: "ela/dela" }],
        });
    });
});
