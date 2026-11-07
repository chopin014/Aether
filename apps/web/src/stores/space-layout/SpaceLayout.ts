/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { EventType, type Room } from "matrix-js-sdk/src/matrix";

import { validOrder } from "../spaces/childOrder";
import { compareRanks, isValidRank, virtualChannelRank } from "./rank";

/*
 * A server's channel layout: its categories and where each channel sits, shared by every member of the Space.
 * None of this is part of the Matrix specification; other clients ignore it and list the Space's rooms as usual.
 *
 * Each category and each channel placement is its own state event in the Space, so two people editing different
 * categories or channels never overwrite each other. Membership of the Space still comes only from `m.space.child`:
 * a placement never adds a channel, and a channel removed from the Space disappears whatever its placement says.
 */

/** A category: `{ v: 1, name?: string, order: string }`, keyed by category id. */
export const SPACE_CATEGORY_EVENT_TYPE = "io.aether.space.category";
/** Where a channel sits: `{ v: 1, category: string | null, order: string }`, keyed by the channel's room id. */
export const SPACE_CHANNEL_EVENT_TYPE = "io.aether.space.channel";
/**
 * A deleted category: `{ v: 1 }`, keyed by category id. A separate slot, so that renaming a category at the same
 * moment someone deletes it can't bring it back. Ids are never reused.
 */
export const SPACE_CATEGORY_DELETED_EVENT_TYPE = "io.aether.space.category.deleted";

/** Every state event type the layout is read from. */
export const SPACE_LAYOUT_EVENT_TYPES: readonly string[] = [
    SPACE_CATEGORY_EVENT_TYPE,
    SPACE_CHANNEL_EVENT_TYPE,
    SPACE_CATEGORY_DELETED_EVENT_TYPE,
];

/** The version of the layout events this client writes. */
export const SPACE_LAYOUT_VERSION = 1;

/**
 * The categories every server has until someone changes them: text channels and voice channels, sorted by kind.
 * Editing one writes its definition; deleting one moves its channels to the top of the list.
 */
export const BUILTIN_TEXT_CATEGORY = "builtin.text";
export const BUILTIN_VOICE_CATEGORY = "builtin.voice";
const BUILTIN_RANKS: Record<string, string> = { [BUILTIN_TEXT_CATEGORY]: "V", [BUILTIN_VOICE_CATEGORY]: "k" };

const CATEGORY_ID_PATTERN = /^c_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Longest category name, in code points, as in Discord. */
export const MAX_CATEGORY_NAME_LENGTH = 100;
/** Largest layout event content accepted, in bytes of its JSON. */
const MAX_CONTENT_BYTES = 4096;

/** Whether a string is a category id: one this client makes, or a built-in category's. */
export function isCategoryId(value: unknown): value is string {
    return (
        typeof value === "string" &&
        (CATEGORY_ID_PATTERN.test(value) || value === BUILTIN_TEXT_CATEGORY || value === BUILTIN_VOICE_CATEGORY)
    );
}

/** A new category id. */
export function newCategoryId(): string {
    return `c_${window.crypto.randomUUID()}`;
}

/** A category name, trimmed, or undefined if it is empty, too long or has control characters. */
export function normaliseCategoryName(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const name = value.trim();
    const length = Array.from(name).length;
    if (length === 0 || length > MAX_CATEGORY_NAME_LENGTH || /\p{Cc}/u.test(name)) return undefined;
    return name;
}

/** Reads the layout's state events in one Space, with any edits this client is still sending applied. */
export interface LayoutStateReader {
    /** The content of a state event, or undefined if there is none. */
    get(type: string, stateKey: string): Record<string, unknown> | undefined;
    /** The state keys present for a type. */
    keys(type: string): string[];
}

/** The layout of a Space whose state the client does not have yet: nothing placed, so the built-in categories. */
export const EMPTY_LAYOUT_READER: LayoutStateReader = { get: () => undefined, keys: () => [] };

/** A Space's state, read directly. */
export function roomStateReader(space: Room): LayoutStateReader {
    return {
        get: (type, stateKey) => space.currentState.getStateEvents(type, stateKey)?.getContent(),
        keys: (type) => space.currentState.getStateEvents(type).map((event) => event.getStateKey()!),
    };
}

/** Content that is an object of a supported size, or undefined. */
function usableContent(content: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    if (!content || typeof content !== "object" || Array.isArray(content) || Object.keys(content).length === 0) {
        return undefined;
    }
    if (new TextEncoder().encode(JSON.stringify(content)).length > MAX_CONTENT_BYTES) return undefined;
    return content;
}

/** A category of a server. */
export interface LayoutCategory {
    id: string;
    /** Its name, or undefined for a built-in category that nobody renamed, which is shown in the viewer's language. */
    name?: string;
    /** The kind of channel a built-in category holds. */
    builtin?: "text" | "voice";
    rank: string;
    /** Whether someone made or changed it, rather than it being a built-in category nobody touched. */
    defined: boolean;
}

/** Where a channel sits. */
export interface ChannelPlacement {
    /** Its category's id, or null at the top of the list, outside any category. */
    category: string | null;
    rank: string;
    /** Whether someone placed it, rather than its kind and Space order deciding. */
    explicit: boolean;
}

/** A channel of a Space, as its `m.space.child` event and its room's type describe it. */
export interface LayoutChild {
    roomId: string;
    /** The valid `order` of its `m.space.child` event. */
    childOrder?: string;
    kind: "text" | "voice";
    /** When its room was created, if this client has the room. */
    createdAt?: number;
}

/** The categories of a server, in order. */
export function getCategories(reader: LayoutStateReader): LayoutCategory[] {
    const deleted = new Set(reader.keys(SPACE_CATEGORY_DELETED_EVENT_TYPE).filter(isCategoryId));
    const categories = new Map<string, LayoutCategory>();

    for (const [id, builtin] of [
        [BUILTIN_TEXT_CATEGORY, "text"],
        [BUILTIN_VOICE_CATEGORY, "voice"],
    ] as const) {
        if (!deleted.has(id)) categories.set(id, { id, builtin, rank: BUILTIN_RANKS[id], defined: false });
    }

    for (const id of reader.keys(SPACE_CATEGORY_EVENT_TYPE)) {
        if (!isCategoryId(id) || deleted.has(id)) continue;
        const content = usableContent(reader.get(SPACE_CATEGORY_EVENT_TYPE, id));
        if (!content) continue;
        const builtin = categories.get(id)?.builtin;
        const name = normaliseCategoryName(content.name);
        // A category this client makes always has a name; a built-in one may leave it to each viewer's language.
        if (!name && !builtin) continue;
        const rank = isValidRank(content.order) ? content.order : (BUILTIN_RANKS[id] ?? undefined);
        if (!rank) continue;
        categories.set(id, { id, name, builtin, rank, defined: true });
    }

    return [...categories.values()].sort((a, b) => compareRanks(a.rank, b.rank) || compareRanks(a.id, b.id));
}

/** When a room was created, from its creation event, which never changes. */
function createdAt(room: Room): number | undefined {
    return room.currentState.getStateEvents(EventType.RoomCreate, "")?.getTs();
}

/** The kind of a channel: voice for call rooms, text for everything else. */
export function channelKind(room: Room): "text" | "voice" {
    return room.isCallRoom() || room.isElementVideoRoom() ? "voice" : "text";
}

/** The Space's direct children with a usable `m.space.child` event, whether or not this user has joined them. */
export function getLayoutChildren(space: Room): LayoutChild[] {
    return space.currentState
        .getStateEvents(EventType.SpaceChild)
        .filter((event) => {
            const via = event.getContent()?.via;
            return Array.isArray(via) && via.length > 0;
        })
        .map((event) => {
            const roomId = event.getStateKey()!;
            const room = space.client.getRoom(roomId);
            return {
                roomId,
                childOrder: validOrder(event.getContent().order),
                kind: room ? channelKind(room) : "text",
                createdAt: room ? createdAt(room) : undefined,
            };
        });
}

/**
 * Where a channel sits. One nobody placed goes to the built-in category of its kind, in its Space order; one placed
 * in a category that no longer exists goes to the top, so no channel is ever hidden by the layout.
 */
export function getPlacement(
    reader: LayoutStateReader,
    categories: LayoutCategory[],
    child: LayoutChild,
    predecessorId?: string,
): ChannelPlacement {
    const known = new Set(categories.map((category) => category.id));
    const content =
        usableContent(reader.get(SPACE_CHANNEL_EVENT_TYPE, child.roomId)) ??
        (predecessorId ? usableContent(reader.get(SPACE_CHANNEL_EVENT_TYPE, predecessorId)) : undefined);
    const virtualRank = virtualChannelRank(child.childOrder, child.roomId, child.createdAt);

    if (content && (content.category === null || isCategoryId(content.category))) {
        const category = content.category !== null && known.has(content.category) ? content.category : null;
        return { category, rank: isValidRank(content.order) ? content.order : virtualRank, explicit: true };
    }

    const builtin = child.kind === "voice" ? BUILTIN_VOICE_CATEGORY : BUILTIN_TEXT_CATEGORY;
    return { category: known.has(builtin) ? builtin : null, rank: virtualRank, explicit: false };
}

/** Compare two placed channels: by rank, then by room id, the same way on every client. */
export function compareChannels(a: { rank: string; roomId: string }, b: { rank: string; roomId: string }): number {
    return compareRanks(a.rank, b.rank) || compareRanks(a.roomId, b.roomId);
}

/** A category of the projected layout, with the rooms to show in it. */
export interface ProjectedCategory extends LayoutCategory {
    rooms: Room[];
}

/** The rooms of a Space's channel list arranged by its layout. */
export interface ProjectedLayout {
    /** Channels outside any category, listed first. */
    uncategorized: Room[];
    categories: ProjectedCategory[];
}

/**
 * Arrange rooms by the Space's layout. Rooms that are not direct children of the Space, such as a nested server's,
 * sit where a channel nobody placed would.
 * @param reader - The Space's layout state.
 * @param space - The Space, or null while the client does not have it.
 * @param rooms - The rooms to arrange, in any order.
 */
export function projectLayout(reader: LayoutStateReader, space: Room | null, rooms: Room[]): ProjectedLayout {
    const categories = getCategories(reader);
    const children = new Map((space ? getLayoutChildren(space) : []).map((child) => [child.roomId, child]));
    const placed = rooms.map((room) => {
        const child = children.get(room.roomId) ?? { roomId: room.roomId, kind: channelKind(room) };
        const predecessorId = room.findPredecessor()?.roomId;
        return {
            room,
            roomId: room.roomId,
            ...getPlacement(
                reader,
                categories,
                { ...child, kind: channelKind(room), createdAt: createdAt(room) },
                predecessorId,
            ),
        };
    });
    placed.sort(compareChannels);

    return {
        uncategorized: placed.filter((entry) => entry.category === null).map((entry) => entry.room),
        categories: categories.map((category) => ({
            ...category,
            rooms: placed.filter((entry) => entry.category === category.id).map((entry) => entry.room),
        })),
    };
}
