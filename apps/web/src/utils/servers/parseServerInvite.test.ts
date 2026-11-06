/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";

import { parseServerInvite } from "./parseServerInvite";

describe("parseServerInvite", () => {
    it("reads matrix.to links with their servers", () => {
        expect(parseServerInvite(" https://matrix.to/#/#aether:matrix.org ")).toEqual({
            roomAlias: "#aether:matrix.org",
            viaServers: [],
        });
        expect(parseServerInvite("https://matrix.to/#/!abc:matrix.org?via=matrix.org&via=example.org")).toEqual({
            roomId: "!abc:matrix.org",
            viaServers: ["matrix.org", "example.org"],
        });
    });

    it("reads addresses, with or without the leading #", () => {
        expect(parseServerInvite("#aether:matrix.org")).toEqual({ roomAlias: "#aether:matrix.org", viaServers: [] });
        expect(parseServerInvite("aether:matrix.org")).toEqual({ roomAlias: "#aether:matrix.org", viaServers: [] });
        expect(parseServerInvite("!abc:matrix.org")).toEqual({ roomId: "!abc:matrix.org", viaServers: [] });
    });

    it("rejects anything else", () => {
        expect(parseServerInvite("")).toBeNull();
        expect(parseServerInvite("hello")).toBeNull();
        expect(parseServerInvite("https://example.org/page")).toBeNull();
        expect(parseServerInvite("https://matrix.to/#/@bob:matrix.org")).toBeNull();
    });
});
