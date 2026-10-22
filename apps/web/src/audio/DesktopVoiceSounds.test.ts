/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { playDesktopVoiceSound } from "./DesktopVoiceSounds";
import SettingsStore from "../settings/SettingsStore";
import MediaDeviceHandler from "../MediaDeviceHandler";

const play = vi.fn().mockResolvedValue(undefined);
const setSinkId = vi.fn().mockResolvedValue(undefined);
const createAudio = vi.fn();

describe("desktop voice feedback", () => {
    beforeEach(() => {
        vi.spyOn(SettingsStore, "getValue").mockReturnValue(true);
        vi.spyOn(MediaDeviceHandler, "getAudioOutput").mockReturnValue("headset");
        vi.stubGlobal(
            "Audio",
            class {
                public play = play;
                public setSinkId = setSinkId;
                public constructor(url: string) {
                    createAudio(url);
                }
            },
        );
    });
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.clearAllMocks();
    });
    it("routes the cue to the selected output before playing", async () => {
        await playDesktopVoiceSound("mute");
        expect(createAudio).toHaveBeenCalledWith(expect.stringContaining("mute.wav"));
        expect(setSinkId).toHaveBeenCalledWith("headset");
        expect(play).toHaveBeenCalledOnce();
    });
    it("respects the device sound preference", async () => {
        vi.mocked(SettingsStore.getValue).mockReturnValue(false);
        await playDesktopVoiceSound("mute");
        expect(createAudio).not.toHaveBeenCalled();
    });
    it("keeps transport and microphone actions independent of playback failures", async () => {
        play.mockRejectedValueOnce(new Error("Audio unavailable"));
        await expect(playDesktopVoiceSound("deafen")).resolves.toBeUndefined();
    });
});
