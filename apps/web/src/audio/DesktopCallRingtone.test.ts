/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DesktopCallRingtone } from "./DesktopCallRingtone";
import MediaDeviceHandler from "../MediaDeviceHandler";

const start = vi.fn();
const stop = vi.fn();
const close = vi.fn().mockResolvedValue(undefined);
const resume = vi.fn().mockResolvedValue(undefined);
const setSinkId = vi.fn().mockResolvedValue(undefined);
const decodeAudioData = vi.fn().mockResolvedValue({ duration: 6.56 });
const fetchAudio = vi.fn();
let source: {
    loop: boolean;
    buffer?: AudioBuffer;
    start: typeof start;
    stop: typeof stop;
    connect: ReturnType<typeof vi.fn>;
};

describe("DesktopCallRingtone", () => {
    let ringtone: DesktopCallRingtone;
    beforeEach(() => {
        ringtone = new DesktopCallRingtone();
        source = { loop: false, start, stop, connect: vi.fn() };
        fetchAudio.mockResolvedValue({ ok: true, arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(0)) });
        vi.spyOn(MediaDeviceHandler, "getAudioOutput").mockReturnValue("headset");
        vi.stubGlobal("fetch", fetchAudio);
        vi.stubGlobal(
            "AudioContext",
            class {
                public resume = resume;
                public close = close;
                public setSinkId = setSinkId;
                public decodeAudioData = decodeAudioData;
                public destination = {};
                public createGain = () => ({ gain: { value: 1 }, connect: vi.fn() });
                public createBufferSource = () => source;
            },
        );
    });
    afterEach(() => {
        ringtone.setRinging(false);
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.clearAllMocks();
    });
    it("decodes once and loops continuously despite repeated presentation updates", async () => {
        ringtone.setRinging(true);
        ringtone.setRinging(true);
        await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
        expect(source.loop).toBe(true);
        expect(fetchAudio).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("ringback.mp3"), expect.any(Object));
        expect(decodeAudioData).toHaveBeenCalledOnce();
        expect(setSinkId).toHaveBeenCalledWith("headset");
        ringtone.setRinging(true);
        expect(start).toHaveBeenCalledOnce();
        ringtone.setRinging(false);
        expect(stop).toHaveBeenCalledOnce();
        expect(close).toHaveBeenCalledOnce();
    });
    it("never starts a cancelled ringback after output selection finishes", async () => {
        const routing = Promise.withResolvers<void>();
        setSinkId.mockReturnValueOnce(routing.promise);
        ringtone.setRinging(true);
        await vi.waitFor(() => expect(setSinkId).toHaveBeenCalledOnce());
        ringtone.setRinging(false);
        routing.resolve();
        await routing.promise;
        expect(start).not.toHaveBeenCalled();
        expect(fetchAudio).not.toHaveBeenCalled();
    });
    it("never starts decoded audio after the call stops ringing", async () => {
        const decoding = Promise.withResolvers<AudioBuffer>();
        decodeAudioData.mockReturnValueOnce(decoding.promise);
        ringtone.setRinging(true);
        await vi.waitFor(() => expect(decodeAudioData).toHaveBeenCalledOnce());
        const signal = fetchAudio.mock.calls[0][1].signal as AbortSignal;
        ringtone.setRinging(false);
        expect(signal.aborted).toBe(true);
        decoding.resolve({} as AudioBuffer);
        await decoding.promise;
        expect(start).not.toHaveBeenCalled();
    });
    it("uses the default output when a selected device is unavailable", async () => {
        setSinkId.mockRejectedValueOnce(new Error("Output disconnected"));
        ringtone.setRinging(true);
        await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    });
    it("contains output failures and allows a later attempt", async () => {
        resume.mockRejectedValueOnce(new Error("Autoplay denied"));
        ringtone.setRinging(true);
        await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
        ringtone.setRinging(true);
        await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    });
    it("closes the output after a failed download", async () => {
        fetchAudio.mockResolvedValueOnce({ ok: false, status: 404 });
        ringtone.setRinging(true);
        await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
        expect(start).not.toHaveBeenCalled();
    });
});
