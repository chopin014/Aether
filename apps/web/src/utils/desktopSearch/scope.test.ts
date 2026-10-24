/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";

import { parseQuery } from "./query";
import { resolveScope } from "./scope";

const space = { roomId: "!space:x", name: "Guizika", roomIds: new Set(["!gen:x", "!dev:x"]) };

describe("resolveScope", () => {
    it("searches every room of the active space when viewing one of its rooms", () => {
        expect(resolveScope({ currentRoomId: "!gen:x", space }, [])).toEqual({
            kind: "space",
            roomIds: ["!gen:x", "!dev:x"],
        });
    });

    it("searches only the current room for a DM or a room outside the space", () => {
        expect(resolveScope({ currentRoomId: "!dm:x", space }, [])).toEqual({ kind: "room", roomIds: ["!dm:x"] });
        expect(resolveScope({ currentRoomId: "!dm:x" }, [])).toEqual({ kind: "room", roomIds: ["!dm:x"] });
    });

    it("narrows a space search with in:", () => {
        const { filters } = parseQuery("in:!dev:x");
        expect(resolveScope({ currentRoomId: "!gen:x", space }, filters).roomIds).toEqual(["!dev:x"]);
    });

    it("never widens the scope beyond the space", () => {
        const { filters } = parseQuery("in:!dev:x in:!elsewhere:x");
        expect(resolveScope({ currentRoomId: "!gen:x", space }, filters).roomIds).toEqual(["!dev:x"]);
        expect(resolveScope({ currentRoomId: "!gen:x", space }, parseQuery("in:!elsewhere:x").filters).roomIds).toEqual(
            [],
        );
    });

    it("keeps a single-room search inside that room", () => {
        expect(resolveScope({ currentRoomId: "!dm:x" }, parseQuery("in:!dm:x").filters).roomIds).toEqual(["!dm:x"]);
    });
});
