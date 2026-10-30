/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DesktopCallRingtone } from "./DesktopCallRingtone";
import MediaDeviceHandler from "../MediaDeviceHandler";

const play = vi.fn().mockResolvedValue(undefined);
const pause = vi.fn();
const setSinkId = vi.fn().mockResolvedValue(undefined);
const createAudio = vi.fn();

describe("DesktopCallRingtone", () => {
    let ringtone: DesktopCallRingtone;
    beforeEach(() => {
        ringtone = new DesktopCallRingtone();
        vi.spyOn(MediaDeviceHandler, "getAudioOutput").mockReturnValue("headset");
        vi.stubGlobal(
            "Audio",
            class {
                public play = play;
                public pause = pause;
                public setSinkId = setSinkId;
                public constructor(url: string) {
                    createAudio(url);
                }
            },
        );
    });
    afterEach(() => {
        ringtone.setRinging(false);
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.clearAllMocks();
    });
    it("starts one custom ringback despite repeated presentation updates", async () => {
        ringtone.setRinging(true);
        ringtone.setRinging(true);
        await vi.waitFor(() => expect(play).toHaveBeenCalledOnce());
        expect(createAudio).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("ringback.mp3"));
        expect(setSinkId).toHaveBeenCalledWith("headset");
        ringtone.setRinging(false);
        expect(pause).toHaveBeenCalledOnce();
    });
    it("never starts a cancelled ringtone after output selection finishes", async () => {
        const routing = Promise.withResolvers<void>();
        setSinkId.mockReturnValueOnce(routing.promise);
        ringtone.setRinging(true);
        ringtone.setRinging(false);
        routing.resolve();
        await routing.promise;
        expect(play).not.toHaveBeenCalled();
    });
    it("pauses a pending play when the call stops ringing", async () => {
        const playing = Promise.withResolvers<void>();
        play.mockReturnValueOnce(playing.promise);
        ringtone.setRinging(true);
        await vi.waitFor(() => expect(play).toHaveBeenCalledOnce());
        ringtone.setRinging(false);
        pause.mockClear();
        playing.resolve();
        await vi.waitFor(() => expect(pause).toHaveBeenCalledOnce());
    });
    it("uses the default output when a selected device is unavailable", async () => {
        setSinkId.mockRejectedValueOnce(new Error("Output disconnected"));
        ringtone.setRinging(true);
        await vi.waitFor(() => expect(play).toHaveBeenCalledOnce());
    });
    it("contains autoplay failures and allows a later attempt", async () => {
        play.mockRejectedValueOnce(new Error("Autoplay denied"));
        ringtone.setRinging(true);
        await vi.waitFor(() => expect(play).toHaveBeenCalledOnce());
        ringtone.setRinging(true);
        await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(2));
    });
});
