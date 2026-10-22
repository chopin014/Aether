/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestClient, mkStubRoom } from "test-utils";

import { getDesktopChannelSections, DESKTOP_TEXT_CHANNELS, DESKTOP_VOICE_CHANNELS } from "./DesktopChannelSections";
import SettingsStore from "../../settings/SettingsStore";
import { CHATS_TAG } from "../../stores/room-list-v3/section";
import { DefaultTagID } from "../../stores/room-list-v3/skip-list/tag";

const client = createTestClient();
const text = mkStubRoom("!text:example.org", "general", client);
const voice = mkStubRoom("!voice:example.org", "Lounge", client);

afterEach(() => vi.restoreAllMocks());

function enableDesktop(): void {
    const getValue = SettingsStore.getValue.bind(SettingsStore);
    vi.spyOn(SettingsStore, "getValue").mockImplementation((name, ...args) =>
        name === "feature_desktop_shell" ? true : getValue(name, ...args),
    );
    vi.spyOn(text, "isCallRoom").mockReturnValue(false);
    vi.spyOn(text, "isElementVideoRoom").mockReturnValue(false);
    vi.spyOn(voice, "isCallRoom").mockReturnValue(true);
}

describe("desktop channel sections", () => {
    it("groups persistent MatrixRTC rooms separately and keeps their Matrix IDs", () => {
        enableDesktop();
        const result = getDesktopChannelSections({
            spaceId: "!space:example.org",
            sections: [{ tag: CHATS_TAG, rooms: [voice, text] }],
        });
        expect(result).toEqual([
            { tag: DESKTOP_TEXT_CHANNELS, rooms: [text] },
            { tag: DESKTOP_VOICE_CHANNELS, rooms: [voice] },
        ]);
    });

    it("keeps invitations and custom categories intact", () => {
        enableDesktop();
        const sections = [
            { tag: DefaultTagID.Invite, rooms: [text] },
            { tag: "custom.design", rooms: [voice] },
        ];
        expect(getDesktopChannelSections({ spaceId: "!space:example.org", sections })).toEqual(sections);
    });

    it("retains the original list when viewing Home", () => {
        enableDesktop();
        const sections = [{ tag: CHATS_TAG, rooms: [text, voice] }];
        expect(getDesktopChannelSections({ spaceId: "home", sections })).toBe(sections);
    });

    it("retains the original list when the desktop feature is disabled", () => {
        vi.spyOn(SettingsStore, "getValue").mockReturnValue(false);
        const sections = [{ tag: CHATS_TAG, rooms: [text, voice] }];
        expect(getDesktopChannelSections({ spaceId: "!space:example.org", sections })).toBe(sections);
    });
});
