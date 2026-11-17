/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";

import { userIdFromUsername } from "./userIdFromUsername";

describe("userIdFromUsername", () => {
    it("places a bare username on the searcher's own homeserver", () => {
        expect(userIdFromUsername("alice", "matrix.org")).toBe("@alice:matrix.org");
        expect(userIdFromUsername(" @alice ", "matrix.org")).toBe("@alice:matrix.org");
        expect(userIdFromUsername("Alice", "matrix.org")).toBe("@alice:matrix.org");
        expect(userIdFromUsername("andre.m_99", "matrix.org")).toBe("@andre.m_99:matrix.org");
    });

    it("reads a username with its server, with or without the leading @", () => {
        expect(userIdFromUsername("alice:example.org", "matrix.org")).toBe("@alice:example.org");
        expect(userIdFromUsername("alice:localhost:8448", "matrix.org")).toBe("@alice:localhost:8448");
        expect(userIdFromUsername("@Alice:example.org", "matrix.org")).toBe("@Alice:example.org");
    });

    it("ignores text that is not a username", () => {
        expect(userIdFromUsername("", "matrix.org")).toBeNull();
        expect(userIdFromUsername("@", "matrix.org")).toBeNull();
        expect(userIdFromUsername("alice smith", "matrix.org")).toBeNull();
        expect(userIdFromUsername("alice@example.org", "matrix.org")).toBeNull();
        expect(userIdFromUsername("#room:example.org", "matrix.org")).toBeNull();
        expect(userIdFromUsername("!room:example.org", "matrix.org")).toBeNull();
        expect(userIdFromUsername("alice:", "matrix.org")).toBeNull();
        expect(userIdFromUsername("ålice", "matrix.org")).toBeNull();
        // Signed out, so there is no homeserver to look on.
        expect(userIdFromUsername("alice", "")).toBeNull();
    });
});
