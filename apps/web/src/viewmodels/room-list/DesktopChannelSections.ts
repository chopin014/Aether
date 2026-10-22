/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { CHATS_TAG } from "../../stores/room-list-v3/section";
import { type RoomsResult, type Section } from "../../stores/room-list-v3/RoomListStoreV3";
import SettingsStore from "../../settings/SettingsStore";

/** Presentation groups, never written as Matrix room tags. */
export const DESKTOP_TEXT_CHANNELS = "desktop.text_channels";
export const DESKTOP_VOICE_CHANNELS = "desktop.voice_channels";

/** Home retains direct-message navigation; a real Space gets channel navigation. */
export function isDesktopChannelList(spaceId: string): boolean {
    return SettingsStore.getValue("feature_desktop_shell") && spaceId.startsWith("!");
}

/** Split ordinary Space rooms by their actual Matrix room type, retaining custom sections and invitations. */
export function getDesktopChannelSections(result: RoomsResult): Section[] {
    if (!isDesktopChannelList(result.spaceId)) return result.sections;
    return result.sections.flatMap((section) => {
        if (section.tag !== CHATS_TAG) return [section];
        const voice = section.rooms.filter((room) => room.isCallRoom() || room.isElementVideoRoom());
        const voiceIds = new Set(voice.map((room) => room.roomId));
        return [
            { tag: DESKTOP_TEXT_CHANNELS, rooms: section.rooms.filter((room) => !voiceIds.has(room.roomId)) },
            { tag: DESKTOP_VOICE_CHANNELS, rooms: voice },
        ];
    });
}

/** Derived channel groups cannot accept tag-based room moves. */
export function isDesktopChannelSection(tag: string): boolean {
    return tag === DESKTOP_TEXT_CHANNELS || tag === DESKTOP_VOICE_CHANNELS;
}
