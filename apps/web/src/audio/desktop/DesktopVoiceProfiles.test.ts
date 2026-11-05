/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { migrateToAns } from "./DesktopVoiceProfiles";
import SettingsStore from "../../settings/SettingsStore";
import MediaDeviceHandler from "../../MediaDeviceHandler";

let values: Record<string, unknown>;

describe("migrateToAns", () => {
    beforeEach(() => {
        values = { desktopAnsMigrated: false, desktopInputProfile: "voice_isolation" };
        vi.spyOn(SettingsStore, "getValue").mockImplementation((name) => values[name] as never);
        vi.spyOn(SettingsStore, "setValue").mockImplementation(async (name, _room, _level, value) => {
            values[name] = value;
        });
        vi.spyOn(MediaDeviceHandler, "setAudioAutoGainControl").mockResolvedValue();
        vi.spyOn(MediaDeviceHandler, "setAudioEchoCancellation").mockResolvedValue();
    });
    afterEach(() => vi.restoreAllMocks());

    it("moves custom processing onto ANS with the processing Voice Isolation turns on", async () => {
        values.desktopInputProfile = "custom";
        await migrateToAns();
        expect(values.desktopInputProfile).toBe("voice_isolation");
        expect(MediaDeviceHandler.setAudioAutoGainControl).toHaveBeenCalledWith(true);
        expect(MediaDeviceHandler.setAudioEchoCancellation).toHaveBeenCalledWith(true);
        expect(values.desktopAnsMigrated).toBe(true);
    });

    it.each(["voice_isolation", "studio"])("leaves the %s profile as it is", async (profile) => {
        values.desktopInputProfile = profile;
        await migrateToAns();
        expect(values.desktopInputProfile).toBe(profile);
        expect(MediaDeviceHandler.setAudioEchoCancellation).not.toHaveBeenCalled();
        expect(values.desktopAnsMigrated).toBe(true);
    });

    it("runs only once, so a later custom choice is kept", async () => {
        await migrateToAns();
        values.desktopInputProfile = "custom";
        await migrateToAns();
        expect(values.desktopInputProfile).toBe("custom");
    });
});
