/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type Room } from "matrix-js-sdk/src/matrix";

import {
    compareChannels,
    getCategories,
    getLayoutChildren,
    getPlacement,
    type LayoutCategory,
    type LayoutStateReader,
    newCategoryId,
    normaliseCategoryName,
    SPACE_CATEGORY_DELETED_EVENT_TYPE,
    SPACE_CATEGORY_EVENT_TYPE,
    SPACE_CHANNEL_EVENT_TYPE,
    SPACE_LAYOUT_VERSION,
} from "./SpaceLayout";
import { SpaceLayoutStore } from "./SpaceLayoutStore";
import { rankBetween } from "./rank";

/*
 * Edits to a server's channel layout. Each one reads the latest state, changes one state event and keeps whatever
 * else that event holds, so fields a newer client added survive.
 */

/** Where an item goes: before or after another one, or at the end when `anchor` is left out. */
export interface Position {
    anchor?: string;
    side?: "before" | "after";
}

function store(): SpaceLayoutStore {
    return SpaceLayoutStore.instance;
}

/** Where an item goes, and the items around it that need a new key first because they shared one. */
interface Insertion {
    rank: string;
    repairs: { id: string; rank: string }[];
}

/**
 * The key that puts an item at `position` among `ordered`, which excludes the item itself. Two admins acting at the
 * same moment can give two items the same key; there is no key between those, so the items from the insertion point
 * that share its neighbour's key get new ones, spread up to the next different key.
 */
export function planInsert(ordered: { id: string; rank: string }[], position: Position): Insertion {
    const index = position.anchor === undefined ? -1 : ordered.findIndex((item) => item.id === position.anchor);
    const insertAt = index === -1 ? ordered.length : position.side === "before" ? index : index + 1;
    const before = ordered[insertAt - 1]?.rank;
    const after = ordered[insertAt]?.rank;
    if (before === undefined || after === undefined || before !== after) {
        return { rank: rankBetween(before, after), repairs: [] };
    }

    let end = insertAt;
    while (ordered[end]?.rank === before) end++;
    const limit = ordered[end]?.rank;
    const rank = rankBetween(before, limit);
    let cursor = rank;
    const repairs = ordered.slice(insertAt, end).map((item) => {
        cursor = rankBetween(cursor, limit);
        return { id: item.id, rank: cursor };
    });
    return { rank, repairs };
}

function categoryContent(reader: LayoutStateReader, category: LayoutCategory): Record<string, unknown> {
    return {
        ...reader.get(SPACE_CATEGORY_EVENT_TYPE, category.id),
        v: SPACE_LAYOUT_VERSION,
        order: category.rank,
        ...(category.name !== undefined ? { name: category.name } : {}),
    };
}

/**
 * Create a category at the end of the server's list.
 * @returns the new category's id.
 * @throws when the name is unusable or the server refuses the edit.
 */
export async function createCategory(space: Room, name: string): Promise<string> {
    const validName = normaliseCategoryName(name);
    if (!validName) throw new Error("createCategory: invalid name");
    const reader = store().reader(space);
    const categories = getCategories(reader);
    const id = newCategoryId();
    const order = rankBetween(categories.at(-1)?.rank, undefined);
    await store().send(space, SPACE_CATEGORY_EVENT_TYPE, id, { v: SPACE_LAYOUT_VERSION, name: validName, order });
    return id;
}

/** Rename a category, including a built-in one. */
export async function renameCategory(space: Room, id: string, name: string): Promise<void> {
    const validName = normaliseCategoryName(name);
    if (!validName) throw new Error("renameCategory: invalid name");
    const reader = store().reader(space);
    const category = getCategories(reader).find((item) => item.id === id);
    if (!category) throw new Error("renameCategory: unknown category");
    await store().send(space, SPACE_CATEGORY_EVENT_TYPE, id, { ...categoryContent(reader, category), name: validName });
}

/** Delete a category. Its channels move to the top of the list, outside any category. */
export async function deleteCategory(space: Room, id: string): Promise<void> {
    await store().send(space, SPACE_CATEGORY_DELETED_EVENT_TYPE, id, { v: SPACE_LAYOUT_VERSION });
}

/** Move a category before or after another, or to the end. */
export async function moveCategory(space: Room, id: string, position: Position): Promise<void> {
    const reader = store().reader(space);
    const categories = getCategories(reader);
    const category = categories.find((item) => item.id === id);
    if (!category || position.anchor === id) return;
    const others = categories.filter((item) => item.id !== id);
    const { rank: order, repairs } = planInsert(others, position);
    // Every edit shows at once, so the neighbours' new keys and the move go out together.
    await Promise.all([
        ...repairs.map((repair) =>
            store().send(space, SPACE_CATEGORY_EVENT_TYPE, repair.id, {
                ...categoryContent(
                    reader,
                    others.find((item) => item.id === repair.id)!,
                ),
                order: repair.rank,
            }),
        ),
        store().send(space, SPACE_CATEGORY_EVENT_TYPE, id, { ...categoryContent(reader, category), order }),
    ]);
}

/** The channels of a category, or of the top of the list for null, in order, whether or not this user can see them. */
function channelsIn(space: Room, reader: LayoutStateReader, category: string | null): { id: string; rank: string }[] {
    const categories = getCategories(reader);
    return getLayoutChildren(space)
        .map((child) => ({ roomId: child.roomId, ...getPlacement(reader, categories, child) }))
        .filter((placed) => placed.category === category)
        .sort(compareChannels)
        .map((placed) => ({ id: placed.roomId, rank: placed.rank }));
}

/**
 * Move a channel into a category (null for the top of the list), before or after another channel or at the end.
 * Moving it within its own category reorders it.
 */
export async function moveChannel(
    space: Room,
    roomId: string,
    category: string | null,
    position: Position = {},
): Promise<void> {
    const reader = store().reader(space);
    if (category !== null && !getCategories(reader).some((item) => item.id === category)) {
        throw new Error("moveChannel: unknown category");
    }
    const others = channelsIn(space, reader, category).filter((item) => item.id !== roomId);
    const { rank: order, repairs } = planInsert(others, position);
    const repaired = repairs.map((repair) =>
        store().send(space, SPACE_CHANNEL_EVENT_TYPE, repair.id, {
            ...reader.get(SPACE_CHANNEL_EVENT_TYPE, repair.id),
            v: SPACE_LAYOUT_VERSION,
            category,
            order: repair.rank,
        }),
    );
    const moved = store().send(space, SPACE_CHANNEL_EVENT_TYPE, roomId, {
        ...reader.get(SPACE_CHANNEL_EVENT_TYPE, roomId),
        v: SPACE_LAYOUT_VERSION,
        category,
        order,
    });
    await Promise.all([...repaired, moved]);
}
