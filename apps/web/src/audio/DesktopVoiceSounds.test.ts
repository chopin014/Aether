/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    DESKTOP_VOICE_SOUNDS,
    getDesktopVoiceSoundToggles,
    isDesktopVoiceSoundEnabled,
    playDesktopVoiceSound,
    setDesktopVoiceSoundEnabled,
    stopDesktopVoiceSound,
} from "./DesktopVoiceSounds";
import SettingsStore from "../settings/SettingsStore";
import { SettingLevel } from "../settings/SettingLevel";
import MediaDeviceHandler from "../MediaDeviceHandler";

const play = vi.fn().mockResolvedValue(undefined);
const setSinkId = vi.fn().mockResolvedValue(undefined);
const createAudio = vi.fn();
const pause = vi.fn();
const audios: Array<{ onended?: () => void }> = [];

/** What the device level holds for each setting; a missing key is a setting that was never written. */
function storeDeviceValues(values: Record<string, unknown>): void {
    vi.spyOn(SettingsStore, "getValueAt").mockImplementation((_level, name) => values[name] as never);
}

describe("desktop voice feedback", () => {
    beforeEach(() => {
        storeDeviceValues({});
        vi.spyOn(MediaDeviceHandler, "getAudioOutput").mockReturnValue("headset");
        vi.stubGlobal(
            "Audio",
            class {
                public play = play;
                public pause = pause;
                public onended?: () => void;
                public setSinkId = setSinkId;
                public constructor(url: string) {
                    createAudio(url);
                    audios.push(this);
                }
            },
        );
    });
    afterEach(() => {
        stopDesktopVoiceSound();
        audios.length = 0;
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
    it("skips a cue the user switched off, but still plays the others", async () => {
        storeDeviceValues({ desktopVoiceSoundToggles: { mute: false } });
        await playDesktopVoiceSound("mute");
        expect(createAudio).not.toHaveBeenCalled();
        await playDesktopVoiceSound("unmute");
        expect(createAudio).toHaveBeenCalledWith(expect.stringContaining("unmute.wav"));
    });
    it("plays a preview of a cue that is switched off", async () => {
        storeDeviceValues({ desktopVoiceSoundToggles: { join: false } });
        await playDesktopVoiceSound("join", { preview: true });
        expect(createAudio).toHaveBeenCalledWith(expect.stringContaining("join.wav"));
    });
    it("has an asset for every cue", async () => {
        for (const { id } of DESKTOP_VOICE_SOUNDS) await playDesktopVoiceSound(id, { preview: true });
        expect(createAudio).toHaveBeenCalledTimes(DESKTOP_VOICE_SOUNDS.length);
        expect(new Set(createAudio.mock.calls.map(([url]) => url)).size).toBe(DESKTOP_VOICE_SOUNDS.length);
    });
    it("coalesces duplicate events but allows the cue again after it ends", async () => {
        await playDesktopVoiceSound("mute");
        await playDesktopVoiceSound("mute");
        expect(play).toHaveBeenCalledTimes(1);
        audios[0].onended?.();
        await playDesktopVoiceSound("mute");
        expect(play).toHaveBeenCalledTimes(2);
    });
    it("interrupts old feedback when a new state arrives", async () => {
        await playDesktopVoiceSound("mute");
        await playDesktopVoiceSound("unmute");
        expect(pause).toHaveBeenCalledOnce();
        expect(play).toHaveBeenCalledTimes(2);
    });
    it("does not play an obsolete cue after device routing resolves", async () => {
        const routing = Promise.withResolvers<void>();
        setSinkId.mockReturnValueOnce(routing.promise);
        const muted = playDesktopVoiceSound("mute");
        await playDesktopVoiceSound("unmute");
        routing.resolve();
        await muted;
        expect(play).toHaveBeenCalledTimes(1);
    });
    it("keeps participant activity from interrupting a control confirmation", async () => {
        await playDesktopVoiceSound("deafen");
        await playDesktopVoiceSound("userJoined");
        expect(play).toHaveBeenCalledTimes(1);
        expect(pause).not.toHaveBeenCalled();
    });
    it("drops a cue if selecting the output takes too long", async () => {
        const routing = Promise.withResolvers<void>();
        vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(1500);
        setSinkId.mockReturnValueOnce(routing.promise);
        const playing = playDesktopVoiceSound("mute");
        routing.resolve();
        await playing;
        expect(play).not.toHaveBeenCalled();
    });
    it("falls back to the default output when the selected device disappears", async () => {
        setSinkId.mockRejectedValueOnce(new Error("Device removed"));
        await playDesktopVoiceSound("mute");
        expect(play).toHaveBeenCalledOnce();
    });
    it("cancels feedback that is still selecting an output", async () => {
        const routing = Promise.withResolvers<void>();
        setSinkId.mockReturnValueOnce(routing.promise);
        const playing = playDesktopVoiceSound("mute");
        stopDesktopVoiceSound();
        routing.resolve();
        await playing;
        expect(play).not.toHaveBeenCalled();
    });
    describe("migrating the single sounds switch", () => {
        it("keeps every cue on when the old switch was never changed", () => {
            storeDeviceValues({});
            expect(getDesktopVoiceSoundToggles()).toEqual({});
            expect(isDesktopVoiceSoundEnabled("deafen")).toBe(true);
        });
        it("keeps every cue on when the old switch was on", () => {
            storeDeviceValues({ desktopVoiceSounds: true });
            expect(isDesktopVoiceSoundEnabled("join")).toBe(true);
        });
        it("turns every cue off when the old switch was off", () => {
            storeDeviceValues({ desktopVoiceSounds: false });
            for (const { id } of DESKTOP_VOICE_SOUNDS) expect(isDesktopVoiceSoundEnabled(id)).toBe(false);
        });
        it("prefers per-cue choices once they exist", () => {
            storeDeviceValues({ desktopVoiceSounds: false, desktopVoiceSoundToggles: { join: true } });
            expect(isDesktopVoiceSoundEnabled("join")).toBe(true);
            expect(isDesktopVoiceSoundEnabled("leave")).toBe(true);
        });
        it("seeds the per-cue choices from the old switch when one cue is changed", async () => {
            storeDeviceValues({ desktopVoiceSounds: false });
            const setValue = vi.spyOn(SettingsStore, "setValue").mockResolvedValue(undefined);
            await setDesktopVoiceSoundEnabled("join", true);
            const [, , level, toggles] = setValue.mock.calls[0];
            expect(level).toBe(SettingLevel.DEVICE);
            expect(toggles).toMatchObject({ join: true, leave: false, mute: false });
        });
    });
    it("keeps transport and microphone actions independent of playback failures", async () => {
        play.mockRejectedValueOnce(new Error("Audio unavailable"));
        await expect(playDesktopVoiceSound("deafen")).resolves.toBeUndefined();
    });
});
