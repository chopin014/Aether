/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type Room } from "matrix-js-sdk/src/matrix";

import { _t } from "../../languageHandler";
import { MatrixClientPeg } from "../../MatrixClientPeg";
import { getRoomNotifsState, RoomNotifState } from "../../RoomNotifs";
import { CallStore } from "../../stores/CallStore";
import { type RoomsResult, type Section } from "../../stores/room-list-v3/RoomListStoreV3";
import { DefaultTagID } from "../../stores/room-list-v3/skip-list/tag";
import SettingsStore from "../../settings/SettingsStore";
import {
    EMPTY_LAYOUT_READER,
    type LayoutStateReader,
    type ProjectedCategory,
    projectLayout,
} from "../../stores/space-layout/SpaceLayout";
import { SpaceLayoutStore } from "../../stores/space-layout/SpaceLayoutStore";

/** Presentation groups of a server's channel list, never written as Matrix room tags. */
const DESKTOP_CATEGORY_PREFIX = "desktop.category.";
/** The channels at the top of a server's list, outside any category. Shown without a header. */
export const DESKTOP_UNCATEGORIZED = "desktop.uncategorized";
/** The built-in categories, which every server has until someone changes them. */
export const DESKTOP_TEXT_CHANNELS = `${DESKTOP_CATEGORY_PREFIX}builtin.text`;
export const DESKTOP_VOICE_CHANNELS = `${DESKTOP_CATEGORY_PREFIX}builtin.voice`;

/** Home retains direct-message navigation; a real Space gets channel navigation. */
export function isDesktopChannelList(spaceId: string): boolean {
    return SettingsStore.getValue("feature_desktop_shell") && spaceId.startsWith("!");
}

/** The room list section tag of a server category. */
export function categoryTag(categoryId: string): string {
    return `${DESKTOP_CATEGORY_PREFIX}${categoryId}`;
}

/** The server category a room list section shows, or undefined if it shows something else. */
export function categoryIdOfTag(tag: string): string | undefined {
    return tag.startsWith(DESKTOP_CATEGORY_PREFIX) ? tag.slice(DESKTOP_CATEGORY_PREFIX.length) : undefined;
}

/** Whether a section is part of a server's channel layout, which no room tag can move a room into. */
export function isDesktopChannelSection(tag: string): boolean {
    return tag === DESKTOP_UNCATEGORIZED || tag.startsWith(DESKTOP_CATEGORY_PREFIX);
}

/** The name to show for a category: its own, or for an unrenamed built-in one, the viewer's language's. */
export function categoryTitle(category: Pick<ProjectedCategory, "name" | "builtin">): string {
    if (category.name !== undefined) return category.name;
    return category.builtin === "voice" ? _t("desktop|voice_channels") : _t("desktop|text_channels");
}

/** Whether this person muted a room. */
export function isRoomMuted(room: Room): boolean {
    const client = MatrixClientPeg.get();
    return !!client && getRoomNotifsState(client, room.roomId) === RoomNotifState.Mute;
}

/** Whether this person is in a call in a room. */
export function isConnectedTo(room: Room): boolean {
    return [...CallStore.instance.connectedCalls].some((call) => call.roomId === room.roomId);
}

/** What the channel list of a server needs to know beyond the room list. */
export interface DesktopChannelOptions {
    /** The room that is open, which is never hidden. */
    selectedRoomId?: string | null;
}

/** The Space a room list result belongs to, or null while the client does not have it yet. */
function channelListSpace(result: RoomsResult): Room | null {
    return MatrixClientPeg.get()?.getRoom(result.spaceId) ?? null;
}

/** The layout state of the Space a room list result belongs to. */
function layoutReader(space: Room | null): LayoutStateReader {
    return space ? SpaceLayoutStore.instance.reader(space) : EMPTY_LAYOUT_READER;
}

/**
 * Arrange a server's channels by its shared layout: the channels outside any category first, then each category in
 * order, each in the order its admins chose. Invitations, the person's favourites (their pinned channels) and direct
 * messages keep their own sections. Low priority and the person's own sections are not groups in a server; their
 * rooms sit in their server category. Outside a server, the room list is unchanged.
 */
export function getDesktopChannelSections(result: RoomsResult, options: DesktopChannelOptions = {}): Section[] {
    if (!isDesktopChannelList(result.spaceId)) return result.sections;
    const space = channelListSpace(result);
    const hideMuted = !!space && SpaceLayoutStore.instance.isHidingMutedChannels(space);
    const visible = (room: Room): boolean =>
        !hideMuted || room.roomId === options.selectedRoomId || isConnectedTo(room) || !isRoomMuted(room);

    const kept: Section[] = [];
    const pool = new Map<string, Room>();
    for (const section of result.sections) {
        if (section.tag === DefaultTagID.Invite || section.tag === DefaultTagID.DM) {
            kept.push(section);
        } else if (section.tag === DefaultTagID.Favourite) {
            kept.push({ tag: section.tag, rooms: section.rooms.filter(visible) });
        } else {
            for (const room of section.rooms) pool.set(room.roomId, room);
        }
    }

    const layout = projectLayout(layoutReader(space), space, [...pool.values()].filter(visible));
    const ordered = [DefaultTagID.Invite, DefaultTagID.Favourite, DefaultTagID.DM]
        .map((tag) => kept.find((section) => section.tag === tag))
        .filter((section): section is Section => !!section);
    return [
        ...ordered,
        { tag: DESKTOP_UNCATEGORIZED, rooms: layout.uncategorized },
        ...layout.categories.map((category) => ({ tag: categoryTag(category.id), rooms: category.rooms })),
    ];
}

/** The categories of the server a room list result belongs to, by section tag. */
export function getDesktopCategories(result: RoomsResult): Map<string, ProjectedCategory> {
    if (!isDesktopChannelList(result.spaceId)) return new Map();
    const space = channelListSpace(result);
    const layout = projectLayout(layoutReader(space), space, []);
    return new Map(layout.categories.map((category) => [categoryTag(category.id), category]));
}

/**
 * Every channel of each category of the server a room list result belongs to, by section tag, whatever the list
 * shows: muted channels it hides and the person's pinned favourites included. Muting or reading a category acts on
 * all of them.
 */
export function getDesktopCategoryMembers(result: RoomsResult): Map<string, Room[]> {
    if (!isDesktopChannelList(result.spaceId)) return new Map();
    const space = channelListSpace(result);
    const pool = new Map<string, Room>();
    for (const section of result.sections) {
        if (section.tag === DefaultTagID.Invite || section.tag === DefaultTagID.DM) continue;
        for (const room of section.rooms) pool.set(room.roomId, room);
    }
    const layout = projectLayout(layoutReader(space), space, [...pool.values()]);
    return new Map(layout.categories.map((category) => [categoryTag(category.id), category.rooms]));
}
