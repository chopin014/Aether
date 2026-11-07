/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventType, MatrixEvent, Room } from "matrix-js-sdk/src/matrix";
import { createTestClient } from "test-utils";

import {
    BUILTIN_TEXT_CATEGORY,
    BUILTIN_VOICE_CATEGORY,
    getCategories,
    projectLayout,
    SPACE_CATEGORY_DELETED_EVENT_TYPE,
    SPACE_CATEGORY_EVENT_TYPE,
    SPACE_CHANNEL_EVENT_TYPE,
} from "./SpaceLayout";
import { SpaceLayoutStore } from "./SpaceLayoutStore";
import { createCategory, deleteCategory, moveCategory, moveChannel, renameCategory } from "./spaceLayoutActions";
import { compareRanks } from "./rank";

const CATEGORY = "c_7e50cc0b-4fb5-4ed0-89db-769fb11c837e";

describe("spaceLayoutActions", () => {
    let client: ReturnType<typeof createTestClient>;
    let space: Room;
    let sent: { type: string; stateKey: string; content: Record<string, unknown> }[];

    function setState(type: string, stateKey: string, content: Record<string, unknown>): void {
        space.currentState.setStateEvents([
            new MatrixEvent({
                type,
                state_key: stateKey,
                room_id: space.roomId,
                sender: "@admin:example.org",
                event_id: `$${type}${stateKey}`,
                content,
            }),
        ]);
    }

    function addChild(roomId: string, voice = false): void {
        setState(EventType.SpaceChild, roomId, { via: ["example.org"] });
        const room = new Room(roomId, client, "@userId:matrix.org");
        vi.spyOn(room, "isCallRoom").mockReturnValue(voice);
        rooms.set(roomId, room);
    }

    const rooms = new Map<string, Room>();

    /** The Space's layout as everyone would see it once the edits being sent arrive. */
    function layout(): ReturnType<typeof projectLayout> {
        return projectLayout(SpaceLayoutStore.instance.reader(space), space, [...rooms.values()]);
    }

    beforeEach(() => {
        client = createTestClient();
        rooms.clear();
        vi.mocked(client.getRoom).mockImplementation((roomId) => rooms.get(roomId!) ?? null);
        space = new Room("!space:example.org", client, "@userId:matrix.org");
        sent = [];
        // Edits stay pending, so each next edit reads the previous one through the store's echo.
        vi.mocked(client.sendStateEvent).mockImplementation((_roomId, type, content, stateKey) => {
            sent.push({ type, stateKey: stateKey!, content: content as Record<string, unknown> });
            return new Promise(() => {});
        });
        SpaceLayoutStore.instance.watch(client);
    });

    afterEach(() => vi.restoreAllMocks());

    it("creates a named category after the last one", async () => {
        void createCategory(space, "  Governo  ");
        await Promise.resolve();
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({ type: SPACE_CATEGORY_EVENT_TYPE, content: { v: 1, name: "Governo" } });
        expect(sent[0].stateKey).toMatch(/^c_[0-9a-f-]{36}$/);
        const categories = getCategories(SpaceLayoutStore.instance.reader(space));
        expect(categories.at(-1)).toMatchObject({ id: sent[0].stateKey, name: "Governo" });
    });

    it("refuses a category without a usable name", async () => {
        await expect(createCategory(space, "   ")).rejects.toThrow();
        await expect(renameCategory(space, CATEGORY, "")).rejects.toThrow();
        expect(sent).toHaveLength(0);
    });

    it("renames a category, keeping its place and fields it does not know", async () => {
        setState(SPACE_CATEGORY_EVENT_TYPE, CATEGORY, { v: 1, name: "Old", order: "A", future: true });
        void renameCategory(space, CATEGORY, "New");
        expect(sent[0]).toEqual({
            type: SPACE_CATEGORY_EVENT_TYPE,
            stateKey: CATEGORY,
            content: { v: 1, name: "New", order: "A", future: true },
        });
    });

    it("renames a built-in category, fixing its place", async () => {
        void renameCategory(space, BUILTIN_VOICE_CATEGORY, "Canais de Voz");
        expect(sent[0].content).toEqual({ v: 1, name: "Canais de Voz", order: "k" });
        await expect(renameCategory(space, CATEGORY, "Missing")).rejects.toThrow();
    });

    it("deletes a category with a separate marker", async () => {
        void deleteCategory(space, CATEGORY);
        expect(sent[0]).toEqual({ type: SPACE_CATEGORY_DELETED_EVENT_TYPE, stateKey: CATEGORY, content: { v: 1 } });
    });

    it("moves a category before or after another", async () => {
        setState(SPACE_CATEGORY_EVENT_TYPE, CATEGORY, { v: 1, name: "Governo", order: "z" });
        void moveCategory(space, CATEGORY, { anchor: BUILTIN_TEXT_CATEGORY, side: "before" });
        expect(getCategories(SpaceLayoutStore.instance.reader(space)).map((c) => c.id)).toEqual([
            CATEGORY,
            BUILTIN_TEXT_CATEGORY,
            BUILTIN_VOICE_CATEGORY,
        ]);
        void moveCategory(space, CATEGORY, { anchor: BUILTIN_TEXT_CATEGORY, side: "after" });
        expect(getCategories(SpaceLayoutStore.instance.reader(space)).map((c) => c.id)).toEqual([
            BUILTIN_TEXT_CATEGORY,
            CATEGORY,
            BUILTIN_VOICE_CATEGORY,
        ]);
        // Moving a built-in category writes its definition, without a name of its own.
        void moveCategory(space, BUILTIN_VOICE_CATEGORY, { anchor: BUILTIN_TEXT_CATEGORY, side: "before" });
        expect(sent.at(-1)?.content).toEqual({ v: 1, order: expect.any(String) });
        expect(compareRanks(sent.at(-1)!.content.order as string, "V")).toBe(-1);
    });

    it("moves a channel into a category, at the end or next to another channel", async () => {
        setState(SPACE_CATEGORY_EVENT_TYPE, CATEGORY, { v: 1, name: "Governo", order: "z" });
        for (const id of ["!a:example.org", "!b:example.org", "!c:example.org"]) addChild(id);

        void moveChannel(space, "!b:example.org", CATEGORY);
        void moveChannel(space, "!c:example.org", CATEGORY);
        expect(
            layout()
                .categories.find((c) => c.id === CATEGORY)
                ?.rooms.map((r) => r.roomId),
        ).toEqual(["!b:example.org", "!c:example.org"]);

        void moveChannel(space, "!a:example.org", CATEGORY, { anchor: "!c:example.org", side: "before" });
        expect(
            layout()
                .categories.find((c) => c.id === CATEGORY)
                ?.rooms.map((r) => r.roomId),
        ).toEqual(["!b:example.org", "!a:example.org", "!c:example.org"]);
        expect(sent.at(-1)).toMatchObject({ type: SPACE_CHANNEL_EVENT_TYPE, stateKey: "!a:example.org" });
    });

    it("reorders a channel among unplaced ones in its built-in category", async () => {
        for (const id of ["!a:example.org", "!b:example.org", "!c:example.org"]) addChild(id);
        void moveChannel(space, "!c:example.org", BUILTIN_TEXT_CATEGORY, { anchor: "!a:example.org", side: "before" });
        expect(layout().categories[0].rooms.map((r) => r.roomId)).toEqual([
            "!c:example.org",
            "!a:example.org",
            "!b:example.org",
        ]);
    });

    it("moves a channel to the top of the list, outside any category", async () => {
        addChild("!a:example.org");
        setState(SPACE_CHANNEL_EVENT_TYPE, "!a:example.org", {
            v: 1,
            category: BUILTIN_TEXT_CATEGORY,
            order: "B",
            x: 1,
        });
        void moveChannel(space, "!a:example.org", null);
        expect(sent[0].content).toEqual({ v: 1, category: null, order: expect.any(String), x: 1 });
        expect(layout().uncategorized.map((r) => r.roomId)).toEqual(["!a:example.org"]);
    });

    it("refuses to move a channel into a category that does not exist", async () => {
        await expect(moveChannel(space, "!a:example.org", CATEGORY)).rejects.toThrow();
        expect(sent).toHaveLength(0);
    });
});
