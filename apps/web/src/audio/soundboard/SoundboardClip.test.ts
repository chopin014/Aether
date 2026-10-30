/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom
import type { MatrixClient } from "matrix-js-sdk/src/matrix";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SoundboardClip } from "./SoundboardClip";
import { SOUNDBOARD_MAX_BYTES } from "./Soundboard";

describe("SoundboardClip", () => {
    const close = vi.fn();
    const decode = vi.fn();
    const source = {
        buffer: null,
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        onended: null as (() => void) | null,
    };
    const samples = Float32Array.from({ length: 20 * 8000 }, (_, i) => (i < 5 * 8000 ? 0.1 : 0.5));
    function file(): File {
        const input = new File(["audio"], "long-original.mp3", { type: "audio/mpeg" });
        Object.assign(input, { arrayBuffer: async () => new ArrayBuffer(1) });
        return input;
    }
    beforeEach(() => {
        vi.clearAllMocks();
        decode.mockResolvedValue({
            duration: 20,
            sampleRate: 8000,
            numberOfChannels: 2,
            getChannelData: () => samples,
        });
        vi.stubGlobal(
            "AudioContext",
            class {
                public decodeAudioData = decode;
                public close = close;
                public resume = vi.fn().mockResolvedValue(undefined);
                public createBufferSource = () => source;
                public destination = {};
                public createGain = () => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() });
                public currentTime = 0;
            },
        );
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it("accepts a longer source locally and exports only the selected samples within upload limits", async () => {
        const clip = await SoundboardClip.load(file());
        expect(clip.duration).toBe(20);
        const exported = clip.export(5, 15);
        expect(exported.name).toBe("long-original.wav");
        expect(exported.type).toBe("audio/wav");
        expect(exported.size).toBeLessThan(SOUNDBOARD_MAX_BYTES);
        const data = await exported.arrayBuffer();
        const wav = new DataView(data);
        expect(wav.getUint16(22, true)).toBe(1);
        expect(wav.getUint32(24, true)).toBe(24000);
        expect(wav.getUint32(40, true) / 2 / 24000).toBe(10);
        expect(wav.getInt16(44, true)).toBe(16384);
        expect(wav.getInt16(data.byteLength - 2, true)).toBe(16384);
        expect(new DataView(await clip.export(5, 15, 50).arrayBuffer()).getInt16(44, true)).toBe(8192);
        expect(clip.waveform(4)).toEqual([expect.closeTo(0.2), 1, 1, 1]);
        clip.dispose();
        expect(close).toHaveBeenCalledOnce();
    });
    it("rejects invalid ranges rather than exporting unselected or overlong audio", async () => {
        const clip = await SoundboardClip.load(file());
        for (const [start, end] of [
            [-1, 5],
            [0, 11],
            [15, 25],
            [5, 5],
            [NaN, 10],
        ])
            expect(() => clip.export(start, end)).toThrow("selection");
        clip.dispose();
    });
    it("bounds source decoding and releases failed decoders", async () => {
        await expect(SoundboardClip.load(new File([], "empty.wav"))).rejects.toThrow("source size");
        await expect(SoundboardClip.load(new File([new Uint8Array(21 * 1024 * 1024)], "huge.wav"))).rejects.toThrow(
            "source size",
        );
        expect(decode).not.toHaveBeenCalled();
        decode.mockRejectedValueOnce(new Error("invalid audio"));
        await expect(SoundboardClip.load(file())).rejects.toThrow("invalid audio");
        decode.mockResolvedValueOnce({ duration: 601 });
        await expect(SoundboardClip.load(file())).rejects.toThrow("source duration");
        expect(close).toHaveBeenCalledTimes(2);
    });
    it("authenticates existing sound downloads and bounds their size", async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
        vi.stubGlobal("fetch", fetchMock);
        const client = {
            mxcUrlToHttp: vi.fn().mockReturnValue("https://provider.test/audio"),
            getAccessToken: () => "test-token",
        } as unknown as MatrixClient;
        const abort = new AbortController();
        const clip = await SoundboardClip.loadStored(client, "mxc://provider.test/audio", "Hello", abort.signal);
        expect(fetchMock).toHaveBeenCalledWith("https://provider.test/audio", {
            headers: { Authorization: "Bearer test-token" },
            signal: abort.signal,
        });
        expect(clip.name).toBe("Hello");
        clip.dispose();
        fetchMock.mockResolvedValueOnce(new Response(new Uint8Array(512001)));
        await expect(
            SoundboardClip.loadStored(client, "mxc://provider.test/audio", "Hello", abort.signal),
        ).rejects.toThrow("size");
    });
    it("previews exactly the selection and stops playback on completion or disposal", async () => {
        vi.useFakeTimers();
        const clip = await SoundboardClip.load(file());
        const update = vi.fn();
        await clip.preview(4, 9, update);
        expect(source.start).toHaveBeenCalledWith(0, 4, 5);
        expect(update).toHaveBeenCalledWith(4, true);
        source.onended!();
        expect(update).toHaveBeenLastCalledWith(4, false);
        expect(vi.getTimerCount()).toBe(0);
        await clip.preview(8, 18, update);
        clip.dispose();
        expect(source.stop).toHaveBeenCalledTimes(2);
        expect(source.disconnect).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
    });
});
