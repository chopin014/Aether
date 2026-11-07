/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import { EventType, MatrixEvent, Room } from "matrix-js-sdk/src/matrix";
import { createTestClient, mkStubRoom } from "test-utils";

import {
    BUILTIN_TEXT_CATEGORY,
    BUILTIN_VOICE_CATEGORY,
    getCategories,
    getPlacement,
    isCategoryId,
    type LayoutStateReader,
    normaliseCategoryName,
    projectLayout,
    roomStateReader,
    SPACE_CATEGORY_DELETED_EVENT_TYPE,
    SPACE_CATEGORY_EVENT_TYPE,
    SPACE_CHANNEL_EVENT_TYPE,
} from "./SpaceLayout";

const CATEGORY = "c_7e50cc0b-4fb5-4ed0-89db-769fb11c837e";
const OTHER = "c_00000000-0000-4000-8000-000000000001";

/** A layout reader over plain state, keyed by type then state key. */
function reader(state: Record<string, Record<string, Record<string, unknown>>>): LayoutStateReader {
    return {
        get: (type, key) => state[type]?.[key],
        keys: (type) => Object.keys(state[type] ?? {}),
    };
}

const client = createTestClient();

function channel(roomId: string, voice = false): Room {
    const room = mkStubRoom(roomId, roomId, client);
    vi.mocked(room.isCallRoom).mockReturnValue(voice);
    return room;
}

function space(children: Record<string, string | undefined> = {}): Room {
    const room = new Room("!space:example.org", client, "@me:example.org");
    room.currentState.setStateEvents(
        Object.entries(children).map(
            ([roomId, order]) =>
                new MatrixEvent({
                    type: EventType.SpaceChild,
                    state_key: roomId,
                    room_id: room.roomId,
                    sender: "@admin:example.org",
                    content: { via: ["example.org"], ...(order ? { order } : {}) },
                }),
        ),
    );
    return room;
}

describe("SpaceLayout", () => {
    it("recognises category ids", () => {
        expect(isCategoryId(CATEGORY)).toBe(true);
        expect(isCategoryId(BUILTIN_TEXT_CATEGORY)).toBe(true);
        expect(isCategoryId("c_not-a-uuid")).toBe(false);
        expect(isCategoryId(null)).toBe(false);
    });

    it("accepts names of 1 to 100 characters without control characters", () => {
        expect(normaliseCategoryName("  Geral  ")).toBe("Geral");
        expect(normaliseCategoryName("   ")).toBeUndefined();
        expect(normaliseCategoryName("a".repeat(101))).toBeUndefined();
        expect(normaliseCategoryName("👫".repeat(100))).toBe("👫".repeat(100));
        expect(normaliseCategoryName("a\nb")).toBeUndefined();
        expect(normaliseCategoryName(7)).toBeUndefined();
    });

    it("has the built-in text and voice categories until they are changed", () => {
        expect(getCategories(reader({}))).toEqual([
            { id: BUILTIN_TEXT_CATEGORY, builtin: "text", rank: "V" },
            { id: BUILTIN_VOICE_CATEGORY, builtin: "voice", rank: "k" },
        ]);
    });

    it("orders categories by rank, renames built-in ones and drops deleted ones", () => {
        const categories = getCategories(
            reader({
                [SPACE_CATEGORY_EVENT_TYPE]: {
                    [CATEGORY]: { v: 1, name: "Governo", order: "A" },
                    [BUILTIN_VOICE_CATEGORY]: { v: 1, name: "Canais de Voz", order: "z" },
                    [OTHER]: { v: 1, name: "Gone", order: "B" },
                },
                [SPACE_CATEGORY_DELETED_EVENT_TYPE]: { [OTHER]: { v: 1 }, [BUILTIN_TEXT_CATEGORY]: { v: 1 } },
            }),
        );
        expect(categories).toEqual([
            { id: CATEGORY, name: "Governo", builtin: undefined, rank: "A" },
            { id: BUILTIN_VOICE_CATEGORY, name: "Canais de Voz", builtin: "voice", rank: "z" },
        ]);
    });

    it("ignores categories with bad ids, names or ranks", () => {
        const categories = getCategories(
            reader({
                [SPACE_CATEGORY_EVENT_TYPE]: {
                    "not-an-id": { v: 1, name: "Bad id", order: "A" },
                    [CATEGORY]: { v: 1, name: "", order: "A" },
                    [OTHER]: { v: 1, name: "Bad order", order: "a0" },
                    [BUILTIN_TEXT_CATEGORY]: { v: 1, order: "bad order" },
                },
            }),
        );
        // A built-in category keeps its own place when its definition has no usable rank.
        expect(categories.map((category) => [category.id, category.rank])).toEqual([
            [BUILTIN_TEXT_CATEGORY, "V"],
            [BUILTIN_VOICE_CATEGORY, "k"],
        ]);
    });

    it("ignores content too large to be a layout event", () => {
        const categories = getCategories(
            reader({
                [SPACE_CATEGORY_EVENT_TYPE]: { [CATEGORY]: { v: 1, name: "Big", order: "A", pad: "x".repeat(5000) } },
            }),
        );
        expect(categories.some((category) => category.id === CATEGORY)).toBe(false);
    });

    describe("placement", () => {
        const categories = getCategories(
            reader({ [SPACE_CATEGORY_EVENT_TYPE]: { [CATEGORY]: { v: 1, name: "Governo", order: "A" } } }),
        );

        it("puts an unplaced channel in the built-in category of its kind", () => {
            expect(getPlacement(reader({}), categories, { roomId: "!t", kind: "text" }).category).toBe(
                BUILTIN_TEXT_CATEGORY,
            );
            expect(getPlacement(reader({}), categories, { roomId: "!v", kind: "voice" }).category).toBe(
                BUILTIN_VOICE_CATEGORY,
            );
        });

        it("puts an unplaced channel at the top when its built-in category was deleted", () => {
            const withoutText = categories.filter((category) => category.id !== BUILTIN_TEXT_CATEGORY);
            expect(getPlacement(reader({}), withoutText, { roomId: "!t", kind: "text" })).toMatchObject({
                category: null,
                explicit: false,
            });
        });

        it("uses a channel's own placement, falling back to the top for a missing category", () => {
            const state = reader({
                [SPACE_CHANNEL_EVENT_TYPE]: {
                    "!a": { v: 1, category: CATEGORY, order: "B" },
                    "!b": { v: 1, category: OTHER, order: "C" },
                    "!c": { v: 1, category: null, order: "D" },
                },
            });
            expect(getPlacement(state, categories, { roomId: "!a", kind: "text" })).toEqual({
                category: CATEGORY,
                rank: "B",
                explicit: true,
            });
            expect(getPlacement(state, categories, { roomId: "!b", kind: "text" }).category).toBeNull();
            expect(getPlacement(state, categories, { roomId: "!c", kind: "voice" }).category).toBeNull();
        });

        it("ignores a placement naming something that is not a category", () => {
            const state = reader({ [SPACE_CHANNEL_EVENT_TYPE]: { "!a": { v: 1, category: 42, order: "B" } } });
            expect(getPlacement(state, categories, { roomId: "!a", kind: "text" }).explicit).toBe(false);
        });

        it("keeps the place of a channel's predecessor after an upgrade", () => {
            const state = reader({ [SPACE_CHANNEL_EVENT_TYPE]: { "!old": { v: 1, category: CATEGORY, order: "B" } } });
            expect(getPlacement(state, categories, { roomId: "!new", kind: "text" }, "!old")).toMatchObject({
                category: CATEGORY,
                rank: "B",
            });
        });
    });

    it("projects rooms into the top of the list and categories, in rank order", () => {
        const general = channel("!general:example.org");
        const memes = channel("!memes:example.org");
        const lounge = channel("!lounge:example.org", true);
        const rules = channel("!rules:example.org");
        const secret = channel("!secret:example.org", true);
        const state = reader({
            [SPACE_CATEGORY_EVENT_TYPE]: { [CATEGORY]: { v: 1, name: "Governo", order: "z" } },
            [SPACE_CHANNEL_EVENT_TYPE]: {
                [rules.roomId]: { v: 1, category: null, order: "A" },
                [secret.roomId]: { v: 1, category: CATEGORY, order: "A" },
            },
        });
        // The Space order puts memes before general.
        const layout = projectLayout(
            state,
            space({ [general.roomId]: "b", [memes.roomId]: "a", [lounge.roomId]: undefined }),
            [general, lounge, secret, memes, rules],
        );
        expect(layout.uncategorized).toEqual([rules]);
        expect(layout.categories.map((category) => [category.id, category.rooms])).toEqual([
            [BUILTIN_TEXT_CATEGORY, [memes, general]],
            [BUILTIN_VOICE_CATEGORY, [lounge]],
            [CATEGORY, [secret]],
        ]);
    });

    it("lists unplaced channels in the order they were created", () => {
        const created = (room: Room, ts: number): Room => {
            vi.mocked(room.currentState.getStateEvents).mockImplementation(((type: string) =>
                type === EventType.RoomCreate ? { getTs: () => ts } : undefined) as never);
            return room;
        };
        const newest = created(channel("!a-newest:example.org"), 3000);
        const oldest = created(channel("!z-oldest:example.org"), 1000);
        const middle = created(channel("!m-middle:example.org"), 2000);
        const layout = projectLayout(reader({}), space(), [newest, oldest, middle]);
        expect(layout.categories[0].rooms).toEqual([oldest, middle, newest]);
    });

    it("reads a Space's own state", () => {
        const room = space();
        room.currentState.setStateEvents([
            new MatrixEvent({
                type: SPACE_CATEGORY_EVENT_TYPE,
                state_key: CATEGORY,
                room_id: room.roomId,
                sender: "@admin:example.org",
                content: { v: 1, name: "Governo", order: "A" },
            }),
        ]);
        const state = roomStateReader(room);
        expect(state.keys(SPACE_CATEGORY_EVENT_TYPE)).toEqual([CATEGORY]);
        expect(state.get(SPACE_CATEGORY_EVENT_TYPE, CATEGORY)).toMatchObject({ name: "Governo" });
    });
});
