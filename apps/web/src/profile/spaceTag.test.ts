/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";
import { type MatrixClient } from "matrix-js-sdk/src/matrix";
import { KnownMembership } from "matrix-js-sdk/src/types";

import { EMPTY_RICH_PROFILE } from "./richProfile";
import { parseSpaceTag, spaceTagOptions, SPACE_TAG_EVENT_TYPE, wornSpaceTag } from "./spaceTag";

const SPACE = "!space:example.org";
const ROBIN = "@robin:example.org";

function makeSpace({
    tag = { label: "ENG", colour: "#ff0000" } as Record<string, unknown> | null,
    isSpace = true,
    robin = KnownMembership.Join as string,
    mine = KnownMembership.Join as string,
} = {}): unknown {
    return {
        roomId: SPACE,
        name: "English Server",
        isSpaceRoom: () => isSpace,
        getMyMembership: () => mine,
        getMember: () => ({ membership: robin }),
        currentState: {
            getStateEvents: (type: string) => (type === SPACE_TAG_EVENT_TYPE && tag ? { getContent: () => tag } : null),
        },
    };
}

const client = (room: unknown): MatrixClient =>
    ({ getRoom: () => room, getRooms: () => (room ? [room] : []) }) as unknown as MatrixClient;
const wearing = { ...EMPTY_RICH_PROFILE, tagSpaceId: SPACE };

describe("parseSpaceTag", () => {
    it("reads a tag and limits the label to four characters", () => {
        expect(parseSpaceTag({ label: "ENGLISH", emoji: "💗💗", colour: "#112233" })).toEqual({
            label: "ENGL",
            emoji: "💗",
            colour: "#112233",
        });
    });

    it("rejects missing labels and drops a bad colour", () => {
        expect(parseSpaceTag(undefined)).toBeUndefined();
        expect(parseSpaceTag({ label: "   " })).toBeUndefined();
        expect(parseSpaceTag({ label: "OK", colour: "url(x)" })?.colour).toBeUndefined();
    });
});

describe("wornSpaceTag", () => {
    it("shows a tag read from the Space's own state", () => {
        expect(wornSpaceTag(client(makeSpace()), wearing, ROBIN)).toMatchObject({
            label: "ENG",
            spaceName: "English Server",
        });
    });

    it("refuses a claim the Space does not back up", () => {
        expect(wornSpaceTag(client(null), wearing, ROBIN)).toBeUndefined();
        expect(wornSpaceTag(client(makeSpace({ isSpace: false })), wearing, ROBIN)).toBeUndefined();
        expect(wornSpaceTag(client(makeSpace({ robin: KnownMembership.Leave })), wearing, ROBIN)).toBeUndefined();
        expect(wornSpaceTag(client(makeSpace({ tag: null })), wearing, ROBIN)).toBeUndefined();
    });

    it("shows nothing when no tag is worn", () => {
        expect(wornSpaceTag(client(makeSpace()), EMPTY_RICH_PROFILE, ROBIN)).toBeUndefined();
    });
});

describe("spaceTagOptions", () => {
    it("offers joined Spaces that define a tag", () => {
        expect(spaceTagOptions(client(makeSpace()))).toEqual([
            expect.objectContaining({ spaceId: SPACE, label: "ENG" }),
        ]);
        expect(spaceTagOptions(client(makeSpace({ mine: KnownMembership.Invite })))).toEqual([]);
        expect(spaceTagOptions(client(makeSpace({ tag: null })))).toEqual([]);
    });
});
