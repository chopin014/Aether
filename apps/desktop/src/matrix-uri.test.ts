/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";

import { findMatrixLink, getMatrixLinkHash, parseMatrixUri } from "./matrix-uri.js";

describe("parseMatrixUri", () => {
    it("reads a room alias with the servers to join through", () => {
        expect(parseMatrixUri("matrix:r/aether:example.org?via=example.org&via=other.net")).toEqual({
            kind: "room",
            roomIdOrAlias: "#aether:example.org",
            eventId: undefined,
            via: ["example.org", "other.net"],
        });
    });

    it("reads room IDs, with and without a server part", () => {
        expect(parseMatrixUri("matrix:roomid/opaque:example.org")).toMatchObject({
            roomIdOrAlias: "!opaque:example.org",
        });
        // Room version 12 room IDs are a hash with no server.
        expect(parseMatrixUri("matrix:roomid/Kt1jZBJ_fX0lUCZ7ycQ8mF4kQ9TzcJ3zfdRKaCq9t0k?via=example.org")).toEqual({
            kind: "room",
            roomIdOrAlias: "!Kt1jZBJ_fX0lUCZ7ycQ8mF4kQ9TzcJ3zfdRKaCq9t0k",
            eventId: undefined,
            via: ["example.org"],
        });
    });

    it("reads an event in a room, decoding its percent-encoded characters", () => {
        expect(parseMatrixUri("matrix:roomid/opaque:example.org/e/abc%2Bdef%2Fghi?via=example.org")).toEqual({
            kind: "room",
            roomIdOrAlias: "!opaque:example.org",
            eventId: "$abc+def/ghi",
            via: ["example.org"],
        });
        expect(parseMatrixUri("matrix:r/aether:example.org/e/event1:example.org")).toMatchObject({
            roomIdOrAlias: "#aether:example.org",
            eventId: "$event1:example.org",
        });
    });

    it("reads a user", () => {
        expect(parseMatrixUri("matrix:u/alice:example.org")).toEqual({ kind: "user", userId: "@alice:example.org" });
        expect(parseMatrixUri("matrix:u/_bridge%3Dbob:example.org:8448")).toEqual({
            kind: "user",
            userId: "@_bridge=bob:example.org:8448",
        });
    });

    it("accepts an upper-case scheme and ignores a fragment", () => {
        expect(parseMatrixUri("MATRIX:r/aether:example.org#ignored")).toMatchObject({
            roomIdOrAlias: "#aether:example.org",
        });
    });

    it("drops actions, so a link can only navigate", () => {
        expect(parseMatrixUri("matrix:r/aether:example.org?action=join&via=example.org")).toEqual({
            kind: "room",
            roomIdOrAlias: "#aether:example.org",
            eventId: undefined,
            via: ["example.org"],
        });
        expect(parseMatrixUri("matrix:u/alice:example.org?action=chat")).toEqual({
            kind: "user",
            userId: "@alice:example.org",
        });
    });

    it("keeps only well-formed servers to join through, at most ten", () => {
        const many = Array.from({ length: 15 }, (_, i) => `via=s${i}.example.org`).join("&");
        expect(parseMatrixUri(`matrix:r/a:example.org?${many}`)).toMatchObject({
            via: Array.from({ length: 10 }, (_, i) => `s${i}.example.org`),
        });
        expect(
            parseMatrixUri("matrix:r/a:example.org?via=good.org&via=bad%20host&via=evil.org/path&via=[::1]:8448&via="),
        ).toMatchObject({ via: ["good.org", "[::1]:8448"] });
    });

    it.each([
        ["another scheme", "https://matrix.to/#/#aether:example.org"],
        ["the app's own scheme", "aether://vector/webapp/#/room/!x:y"],
        ["an empty link", "matrix:"],
        ["an unknown type", "matrix:group/aether:example.org"],
        ["a bare event", "matrix:e/event:example.org"],
        ["an event of a user", "matrix:u/alice:example.org/e/event"],
        ["a sub-entity that is not an event", "matrix:r/aether:example.org/u/alice:example.org"],
        ["too many parts", "matrix:r/aether:example.org/e/event/x/y"],
        ["an authority", "matrix://example.org/r/aether:example.org"],
        ["an alias without a server", "matrix:r/aether"],
        ["an alias with an empty localpart", "matrix:r/:example.org"],
        ["an alias with a slash", "matrix:r/a%2Fb:example.org"],
        ["a user without a server", "matrix:u/alice"],
        ["a user with a bad server", "matrix:u/alice:exa mple.org"],
        ["a room ID with a bad server", "matrix:roomid/opaque:bad_server!"],
        ["a room ID with odd characters", "matrix:roomid/opa%3Cque:example.org"],
        ["an empty event", "matrix:r/aether:example.org/e/"],
        ["broken percent-encoding", "matrix:r/a%E0%A4%A:example.org"],
        ["an encoded control character", "matrix:u/al%0Aice:example.org"],
        ["an encoded space", "matrix:r/a%20b:example.org"],
        ["a text direction override", "matrix:u/al%E2%80%AEice:example.org"],
        ["an encoded route separator", "matrix:r/a%3Fb:example.org"],
        ["an encoded fragment marker", "matrix:u/a%23b:example.org"],
        ["an over-long identifier", `matrix:u/${"a".repeat(300)}:example.org`],
        ["an over-long link", `matrix:r/a:example.org?via=${"a".repeat(3000)}`],
    ])("rejects %s", (_name, uri) => {
        expect(parseMatrixUri(uri)).toBeUndefined();
    });

    it("rejects input that is not a string", () => {
        expect(parseMatrixUri(undefined as unknown as string)).toBeUndefined();
        expect(parseMatrixUri({ toString: () => "matrix:u/a:b.org" } as unknown as string)).toBeUndefined();
    });
});

describe("findMatrixLink", () => {
    it("finds the link among other command line arguments", () => {
        expect(findMatrixLink(["/opt/Aether/aether", "--hidden", "matrix:u/alice:example.org"])).toEqual({
            kind: "user",
            userId: "@alice:example.org",
        });
        expect(findMatrixLink(["/opt/Aether/aether", "matrix:nonsense", "--profile", "x"])).toBeUndefined();
    });
});

describe("getMatrixLinkHash", () => {
    it("percent-encodes identifiers into the app's room and user routes", () => {
        expect(
            getMatrixLinkHash({
                kind: "room",
                roomIdOrAlias: "#aether:example.org",
                eventId: "$abc+d/e",
                via: ["example.org", "[::1]:8448"],
            }),
        ).toBe("#/room/%23aether%3Aexample.org/%24abc%2Bd%2Fe?via=example.org&via=%5B%3A%3A1%5D%3A8448");
        expect(getMatrixLinkHash({ kind: "room", roomIdOrAlias: "!opaque:example.org", via: [] })).toBe(
            "#/room/!opaque%3Aexample.org",
        );
        expect(getMatrixLinkHash({ kind: "user", userId: "@_bridge=bob:example.org" })).toBe(
            "#/user/%40_bridge%3Dbob%3Aexample.org",
        );
    });
});
