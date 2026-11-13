/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventType, MatrixEvent, Room } from "matrix-js-sdk/src/matrix";
import { createTestClient, mkStubRoom } from "test-utils";

import {
    categoryIdOfTag,
    categoryTag,
    categoryTitle,
    DESKTOP_TEXT_CHANNELS,
    DESKTOP_UNCATEGORIZED,
    DESKTOP_VOICE_CHANNELS,
    getDesktopCategories,
    getDesktopCategoryMembers,
    getDesktopChannelSections,
    isDesktopChannelSection,
} from "./DesktopChannelSections";
import SettingsStore from "../../settings/SettingsStore";
import { MatrixClientPeg } from "../../MatrixClientPeg";
import * as RoomNotifs from "../../RoomNotifs";
import { CHATS_TAG } from "../../stores/room-list-v3/section";
import { DefaultTagID } from "../../stores/room-list-v3/skip-list/tag";
import { SPACE_CATEGORY_EVENT_TYPE, SPACE_CHANNEL_EVENT_TYPE } from "../../stores/space-layout/SpaceLayout";
import { SpaceLayoutStore } from "../../stores/space-layout/SpaceLayoutStore";

const SPACE_ID = "!space:example.org";
const CATEGORY = "c_7e50cc0b-4fb5-4ed0-89db-769fb11c837e";

const client = createTestClient();
const text = mkStubRoom("!text:example.org", "general", client);
const voice = mkStubRoom("!voice:example.org", "Lounge", client);
const rules = mkStubRoom("!rules:example.org", "rules", client);

function enableDesktop(): void {
    const getValue = SettingsStore.getValue.bind(SettingsStore);
    vi.spyOn(SettingsStore, "getValue").mockImplementation((name, ...args) =>
        name === "feature_desktop_shell" ? true : getValue(name, ...args),
    );
    vi.mocked(voice.isCallRoom).mockReturnValue(true);
}

describe("desktop channel sections", () => {
    let space: Room;

    function setState(type: string, stateKey: string, content: Record<string, unknown>): void {
        space.currentState.setStateEvents([
            new MatrixEvent({ type, state_key: stateKey, room_id: SPACE_ID, sender: "@a:example.org", content }),
        ]);
    }

    beforeEach(() => {
        space = new Room(SPACE_ID, client, "@userId:matrix.org");
        vi.spyOn(MatrixClientPeg, "get").mockReturnValue(client);
        vi.mocked(client.getRoom).mockImplementation((roomId) => (roomId === SPACE_ID ? space : null));
        SpaceLayoutStore.instance.watch(client);
    });

    afterEach(() => vi.restoreAllMocks());

    it("names its sections after server categories", () => {
        expect(categoryIdOfTag(categoryTag(CATEGORY))).toBe(CATEGORY);
        expect(categoryIdOfTag(CHATS_TAG)).toBeUndefined();
        expect(isDesktopChannelSection(DESKTOP_UNCATEGORIZED)).toBe(true);
        expect(isDesktopChannelSection(DESKTOP_TEXT_CHANNELS)).toBe(true);
        expect(isDesktopChannelSection(DefaultTagID.Favourite)).toBe(false);
        expect(categoryTitle({ name: "Governo" })).toBe("Governo");
        expect(categoryTitle({ builtin: "voice" })).toBe("Voice Channels");
    });

    it("splits channels into the built-in categories until the server has a layout", () => {
        enableDesktop();
        const result = getDesktopChannelSections({
            spaceId: SPACE_ID,
            sections: [{ tag: CHATS_TAG, rooms: [voice, text] }],
        });
        expect(result).toEqual([
            { tag: DESKTOP_UNCATEGORIZED, rooms: [] },
            { tag: DESKTOP_TEXT_CHANNELS, rooms: [text] },
            { tag: DESKTOP_VOICE_CHANNELS, rooms: [voice] },
        ]);
    });

    it("splits channels by kind even before the client has the Space", () => {
        enableDesktop();
        vi.mocked(client.getRoom).mockReturnValue(null);
        const result = getDesktopChannelSections({ spaceId: SPACE_ID, sections: [{ tag: CHATS_TAG, rooms: [voice] }] });
        expect(result.find((section) => section.tag === DESKTOP_VOICE_CHANNELS)?.rooms).toEqual([voice]);
    });

    it("lays channels out by the server's categories and placements", () => {
        enableDesktop();
        setState(SPACE_CATEGORY_EVENT_TYPE, CATEGORY, { v: 1, name: "Governo", order: "A" });
        setState(SPACE_CHANNEL_EVENT_TYPE, text.roomId, { v: 1, category: CATEGORY, order: "B" });
        setState(SPACE_CHANNEL_EVENT_TYPE, rules.roomId, { v: 1, category: null, order: "B" });
        const result = getDesktopChannelSections({
            spaceId: SPACE_ID,
            sections: [{ tag: CHATS_TAG, rooms: [voice, text, rules] }],
        });
        expect(result).toEqual([
            { tag: DESKTOP_UNCATEGORIZED, rooms: [rules] },
            { tag: categoryTag(CATEGORY), rooms: [text] },
            { tag: DESKTOP_TEXT_CHANNELS, rooms: [] },
            { tag: DESKTOP_VOICE_CHANNELS, rooms: [voice] },
        ]);
        expect([...getDesktopCategories({ spaceId: SPACE_ID, sections: [] }).keys()]).toEqual([
            categoryTag(CATEGORY),
            DESKTOP_TEXT_CHANNELS,
            DESKTOP_VOICE_CHANNELS,
        ]);
    });

    it("keeps invitations, favourites and direct messages, and files other sections' rooms by the layout", () => {
        enableDesktop();
        const dm = mkStubRoom("!dm:example.org", "Alice", client);
        const result = getDesktopChannelSections({
            spaceId: SPACE_ID,
            sections: [
                { tag: DefaultTagID.LowPriority, rooms: [rules] },
                { tag: "element.io.section.design", rooms: [voice] },
                { tag: DefaultTagID.DM, rooms: [dm] },
                { tag: DefaultTagID.Favourite, rooms: [text] },
                { tag: DefaultTagID.Invite, rooms: [] },
            ],
        });
        expect(result).toEqual([
            { tag: DefaultTagID.Invite, rooms: [] },
            { tag: DefaultTagID.Favourite, rooms: [text] },
            { tag: DefaultTagID.DM, rooms: [dm] },
            { tag: DESKTOP_UNCATEGORIZED, rooms: [] },
            { tag: DESKTOP_TEXT_CHANNELS, rooms: [rules] },
            { tag: DESKTOP_VOICE_CHANNELS, rooms: [voice] },
        ]);
    });

    it("hides muted channels when the person asked, except the open one", async () => {
        enableDesktop();
        vi.spyOn(RoomNotifs, "getRoomNotifsState").mockImplementation((_client, roomId) =>
            roomId === voice.roomId || roomId === rules.roomId ? RoomNotifs.RoomNotifState.Mute : null,
        );
        vi.mocked(client.setRoomAccountData).mockReturnValue(new Promise(() => {}));
        void SpaceLayoutStore.instance.setHidingMutedChannels(space, true);
        const result = getDesktopChannelSections(
            { spaceId: SPACE_ID, sections: [{ tag: CHATS_TAG, rooms: [voice, text, rules] }] },
            { selectedRoomId: rules.roomId },
        );
        expect(result.flatMap((section) => section.rooms)).toEqual([rules, text]);
    });

    it("counts every channel of a category, including pinned favourites and hidden muted ones", async () => {
        enableDesktop();
        vi.spyOn(RoomNotifs, "getRoomNotifsState").mockImplementation((_client, roomId) =>
            roomId === rules.roomId ? RoomNotifs.RoomNotifState.Mute : null,
        );
        vi.mocked(client.setRoomAccountData).mockReturnValue(new Promise(() => {}));
        void SpaceLayoutStore.instance.setHidingMutedChannels(space, true);
        const result = {
            spaceId: SPACE_ID,
            sections: [
                { tag: DefaultTagID.Favourite, rooms: [text] },
                { tag: CHATS_TAG, rooms: [rules, voice] },
            ],
        };
        expect(getDesktopChannelSections(result).flatMap((section) => section.rooms)).not.toContain(rules);
        const members = getDesktopCategoryMembers(result);
        expect(members.get(DESKTOP_TEXT_CHANNELS)).toEqual([rules, text]);
        expect(members.get(DESKTOP_VOICE_CHANNELS)).toEqual([voice]);
        expect(getDesktopCategoryMembers({ spaceId: "home", sections: [] }).size).toBe(0);
    });

    it("retains the original list when viewing Home", () => {
        enableDesktop();
        const sections = [{ tag: CHATS_TAG, rooms: [text, voice] }];
        expect(getDesktopChannelSections({ spaceId: "home", sections })).toBe(sections);
        expect(getDesktopCategories({ spaceId: "home", sections }).size).toBe(0);
    });

    it("retains the original list when the desktop feature is disabled", () => {
        vi.spyOn(SettingsStore, "getValue").mockReturnValue(false);
        const sections = [{ tag: CHATS_TAG, rooms: [text, voice] }];
        expect(getDesktopChannelSections({ spaceId: SPACE_ID, sections })).toBe(sections);
    });

    it("uses the same section for a Space's channel list as the Space's own events", () => {
        // A child event alone never adds a room to the list; the room list decides that.
        enableDesktop();
        setState(EventType.SpaceChild, "!other:example.org", { via: ["example.org"] });
        const result = getDesktopChannelSections({ spaceId: SPACE_ID, sections: [{ tag: CHATS_TAG, rooms: [] }] });
        expect(result.flatMap((section) => section.rooms)).toEqual([]);
    });
});
