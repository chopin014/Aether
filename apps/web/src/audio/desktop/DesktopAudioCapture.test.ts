/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopAudioPacket } from "shared-types";

import { decodeDesktopAudio, installDesktopAudioCapture } from "./DesktopAudioCapture";
import SettingsStore from "../../settings/SettingsStore";

function audioContext() {
    const output = [new Float32Array(2), new Float32Array(2)];
    const createBuffer = vi.fn(() => ({ getChannelData: (channel: number) => output[channel], duration: 2 / 48000 }));
    const audio = { kind: "audio", contentHint: "", stop: vi.fn(), addEventListener: vi.fn() };
    const destination = { stream: { getAudioTracks: () => [audio] } };
    const clockSource = { offset: { value: 0 }, connect: vi.fn(), start: vi.fn() };
    const context = {
        createBuffer,
        currentTime: 0,
        destination: {},
        createConstantSource: vi.fn(() => clockSource),
        createMediaStreamDestination: () => destination,
        resume: vi.fn(),
        close: vi.fn(),
        createBufferSource: vi.fn(() => ({
            connect: vi.fn(),
            disconnect: vi.fn(),
            start: vi.fn(),
            stop: vi.fn(),
            onended: null,
        })),
    };
    return { context, output, audio, clockSource };
}

describe("DesktopAudioCapture", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it("decodes stereo PCM without mixing the channels or applying voice processing", () => {
        const { context, output } = audioContext();
        const data = new Uint8Array(8);
        const view = new DataView(data.buffer);
        [32767, -32768, 16384, -16384].forEach((sample, index) => view.setInt16(index * 2, sample, true));
        decodeDesktopAudio(
            { data, channels: 2, sampleRate: 48000, bitsPerSample: 16, isFloat: false, sessionId: "one" },
            context as unknown as AudioContext,
        );
        expect([...output[0]]).toEqual([32767 / 32768, 0.5]);
        expect([...output[1]]).toEqual([-1, -0.5]);
    });

    it("preserves native float32 audio", () => {
        const { context, output } = audioContext();
        decodeDesktopAudio(
            {
                data: new Uint8Array(new Float32Array([0.5, -0.5, 0.25, -0.25]).buffer),
                channels: 2,
                sampleRate: 48000,
                bitsPerSample: 32,
                isFloat: true,
                sessionId: "one",
            },
            context as unknown as AudioContext,
        );
        expect([...output[0]]).toEqual([0.5, 0.25]);
        expect([...output[1]]).toEqual([-0.5, -0.25]);
    });

    it.each([true, false])("attaches only authorized audio (%s) and releases resources", async (authorized) => {
        vi.spyOn(SettingsStore, "getValue").mockReturnValue(true);
        const { context, audio, clockSource } = audioContext();
        vi.stubGlobal(
            "AudioContext",
            vi.fn(function () {
                return context;
            }),
        );
        const video = { kind: "video", stop: vi.fn(), addEventListener: vi.fn() };
        const tracks = [video];
        const stream = { getTracks: () => tracks, addTrack: vi.fn((track) => tracks.push(track)) };
        const getDisplayMedia = vi.fn().mockResolvedValue(stream);
        Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getDisplayMedia } });
        let listener: (packet: DesktopAudioPacket) => void;
        const unsubscribe = vi.fn();
        const api = {
            prepare: vi.fn().mockResolvedValue(undefined),
            start: vi.fn().mockResolvedValue(authorized),
            stop: vi.fn().mockResolvedValue(undefined),
            onData: vi.fn((callback) => {
                listener = callback;
                return unsubscribe;
            }),
        };
        installDesktopAudioCapture(api);
        expect(await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })).toBe(stream);
        expect(getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: false });
        if (authorized) {
            expect(stream.addTrack).toHaveBeenCalledWith(audio);
            // Packets are scheduled against this context's clock, so it must stay on the audio device.
            expect(clockSource.connect).toHaveBeenCalledWith(context.destination);
            expect(clockSource.start).toHaveBeenCalledOnce();
            listener!({ sessionId: "stale" } as DesktopAudioPacket);
            expect(context.createBuffer).not.toHaveBeenCalled();
            listener!({
                sessionId: api.start.mock.calls[0][0],
                data: new Uint8Array(new Float32Array([0.5, -0.5, 0.25, -0.25]).buffer),
                channels: 2,
                sampleRate: 48000,
                bitsPerSample: 32,
                isFloat: true,
            });
            expect(context.createBufferSource).toHaveBeenCalledOnce();
            expect(context.createBufferSource.mock.results[0].value.connect).toHaveBeenCalledWith(
                context.createMediaStreamDestination(),
            );
            video.stop();
            expect(context.createBufferSource.mock.results[0].value.stop).toHaveBeenCalledOnce();
        } else expect(stream.addTrack).not.toHaveBeenCalled();
        expect(unsubscribe).toHaveBeenCalledOnce();
        expect(api.stop).toHaveBeenCalledWith(api.start.mock.calls[0][0]);
        expect(context.close).toHaveBeenCalledOnce();
    });
});
