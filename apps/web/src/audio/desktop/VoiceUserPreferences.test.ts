/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import SettingsStore from "../../settings/SettingsStore";
import { SettingLevel } from "../../settings/SettingLevel";
import {
    clampUserVolume,
    MAX_USER_VOLUME,
    VoiceUserPreferences,
    type VoiceUserPreference,
} from "./VoiceUserPreferences";

describe("VoiceUserPreferences", () => {
    let stored: Record<string, VoiceUserPreference>;

    beforeEach(() => {
        stored = {};
        vi.spyOn(SettingsStore, "getValue").mockImplementation(((name: string) =>
            name === "desktopVoiceUserPreferences" ? stored : undefined) as unknown as typeof SettingsStore.getValue);
        vi.spyOn(SettingsStore, "setValue").mockImplementation(async (name, _room, level, value) => {
            expect(name).toBe("desktopVoiceUserPreferences");
            expect(level).toBe(SettingLevel.DEVICE);
            stored = value as Record<string, VoiceUserPreference>;
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("fills in defaults for someone who was never changed", () => {
        expect(VoiceUserPreferences.instance.get("@bob:example.org")).toEqual({
            volume: 1,
            muted: false,
            soundboardMuted: false,
            videoDisabled: false,
        });
        expect(VoiceUserPreferences.instance.effectiveVolume("@bob:example.org")).toBe(1);
    });

    it("keeps only what differs from the defaults and forgets a person back at them", async () => {
        const preferences = VoiceUserPreferences.instance;
        await preferences.setVolume("@bob:example.org", 1.75);
        expect(stored).toEqual({ "@bob:example.org": { volume: 1.75 } });

        await preferences.toggleMuted("@bob:example.org");
        expect(preferences.get("@bob:example.org")).toMatchObject({ volume: 1.75, muted: true });
        expect(preferences.effectiveVolume("@bob:example.org")).toBe(0);

        await preferences.update("@bob:example.org", { soundboardMuted: true, videoDisabled: true });
        expect(stored["@bob:example.org"]).toEqual({
            volume: 1.75,
            muted: true,
            soundboardMuted: true,
            videoDisabled: true,
        });

        await preferences.update("@bob:example.org", {
            volume: 1,
            muted: false,
            soundboardMuted: false,
            videoDisabled: false,
        });
        expect(stored).toEqual({});
    });

    it("unmutes someone when their volume is turned up, as Discord does, and caps it at 200%", async () => {
        const preferences = VoiceUserPreferences.instance;
        await preferences.update("@bob:example.org", { muted: true });
        await preferences.setVolume("@bob:example.org", 0);
        expect(preferences.get("@bob:example.org")).toMatchObject({ volume: 0, muted: true });
        await preferences.setVolume("@bob:example.org", 5);
        expect(preferences.get("@bob:example.org")).toMatchObject({ volume: MAX_USER_VOLUME, muted: false });
    });

    it("clamps unreadable or out of range volumes", () => {
        expect(clampUserVolume(Number.NaN)).toBe(1);
        expect(clampUserVolume(-1)).toBe(0);
        expect(clampUserVolume(3)).toBe(2);
        stored = { "@bob:example.org": { volume: 9 } };
        expect(VoiceUserPreferences.instance.get("@bob:example.org").volume).toBe(2);
    });
});
