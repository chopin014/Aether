/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseSound, SoundboardAudio, SOUNDBOARD_MAX_BYTES } from "./Soundboard";

const sound = { name: "Hello", emoji: "👋", url: "mxc://example.org/audio", duration_ms: 2000 };
describe("soundboard media", () => {
    afterEach(() => vi.unstubAllGlobals());
    it("rejects malformed metadata and arbitrary remote URLs", () => {
        expect(parseSound(sound)).toEqual(sound);
        expect(parseSound({ ...sound, duration_ms: 10_000 })?.duration_ms).toBe(10_000);
        for (const change of [
            { name: "" },
            { duration_ms: 10_001 },
            { duration_ms: NaN },
            { duration_ms: 1.5 },
            { emoji: "x".repeat(17) },
            { url: "https://evil.example/audio" },
        ]) {
            expect(parseSound({ ...sound, ...change })).toBeUndefined();
        }
        expect(parseSound({})).toBeUndefined();
    });
    it("rejects oversized files before decoding and long files before upload", async () => {
        await expect(SoundboardAudio.duration(new Blob([new Uint8Array(SOUNDBOARD_MAX_BYTES + 1)]))).rejects.toThrow(
            "size",
        );
        const close = vi.fn().mockResolvedValue(undefined);
        const decode = vi.fn().mockResolvedValue({ duration: 10 });
        vi.stubGlobal(
            "AudioContext",
            class {
                public close = close;
                public decodeAudioData = decode;
            },
        );
        const blob = new Blob(["audio"]);
        Object.assign(blob, { arrayBuffer: async () => new ArrayBuffer(1) });
        await expect(SoundboardAudio.duration(blob)).resolves.toBe(10);
        decode.mockResolvedValue({ duration: 10.001 });
        await expect(SoundboardAudio.duration(blob)).rejects.toThrow("duration");
        expect(close).toHaveBeenCalledTimes(2);
    });
});

describe("soundboard playback", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });
    function playback() {
        vi.useFakeTimers();
        const pause = vi.fn();
        const play = vi.fn().mockResolvedValue(undefined);
        const sink = vi.fn().mockResolvedValue(undefined);
        const load = vi.fn();
        const release = vi.fn();
        const elements: {
            volume: number;
            currentTime: number;
            sinkId: string;
            pause: () => void;
            onended: (() => void) | null;
        }[] = [];
        vi.stubGlobal(
            "Audio",
            class {
                public onended: (() => void) | null = null;
                public volume = 1;
                public currentTime = 0;
                public sinkId = "";
                public pause = pause;
                public play = play;
                public load = load;
                public removeAttribute = release;
                public setSinkId = async (output: string): Promise<void> => {
                    await sink(output);
                    this.sinkId = output;
                };
                public constructor() {
                    elements.push(this);
                }
            },
        );
        return { pause, play, sink, elements, load, release };
    }
    it("tracks actual playback through end, restart, stop, failure and the duration limit", async () => {
        const { elements, play } = playback();
        const client = {} as import("matrix-js-sdk/src/matrix").MatrixClient;
        const audio = new SoundboardAudio();
        const ended = vi.fn();
        const started = vi.fn(() => ended);
        await audio.play(client, "/first.wav", 1, "", started);
        expect(started).toHaveBeenCalledOnce();
        elements[0].onended?.();
        expect(ended).toHaveBeenCalledOnce();
        await audio.play(client, "/first.wav", 1, "", started);
        await audio.play(client, "/first.wav", 1, "", started);
        expect(ended).toHaveBeenCalledTimes(2);
        audio.stop();
        expect(ended).toHaveBeenCalledTimes(3);
        play.mockRejectedValueOnce(new Error("device"));
        await expect(audio.play(client, "/first.wav", 1, "", started)).rejects.toThrow("device");
        expect(started).toHaveBeenCalledTimes(3);
        await audio.play(client, "/first.wav", 1, "", started);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(ended).toHaveBeenCalledTimes(4);
        audio.dispose();
    });

    it("uses the selected speaker, clamps volume, and stops after ten seconds", async () => {
        const { pause, play, sink, elements } = playback();
        const audio = new SoundboardAudio();
        // Built-in assets are trusted URLs and never use Matrix downloads.
        await audio.play({} as import("matrix-js-sdk/src/matrix").MatrixClient, "/soundboard.wav", 2, "headset");
        expect(sink).toHaveBeenCalledWith("headset");
        expect(elements[0].volume).toBe(1);
        expect(play).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(9999);
        expect(pause).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(pause).toHaveBeenCalledOnce();
    });
    it("cancels a pending speaker selection before it can start playback", async () => {
        const { play, sink } = playback();
        let selected!: () => void;
        sink.mockReturnValue(
            new Promise<void>((resolve) => {
                selected = resolve;
            }),
        );
        const audio = new SoundboardAudio();
        const pending = audio.play(
            {} as import("matrix-js-sdk/src/matrix").MatrixClient,
            "/soundboard.wav",
            1,
            "headset",
        );
        await vi.waitFor(() => expect(sink).toHaveBeenCalledOnce());
        audio.stop();
        selected();
        await pending;
        expect(play).not.toHaveBeenCalled();
    });
    it("overlaps different sounds, restarts only the repeated sound, and keeps independent time limits", async () => {
        const { elements, play } = playback();
        const client = {} as import("matrix-js-sdk/src/matrix").MatrixClient;
        const audio = new SoundboardAudio();
        await audio.play(client, "/first.wav", 1, "");
        const firstPause = vi.fn();
        elements[0].pause = firstPause;
        await vi.advanceTimersByTimeAsync(1000);
        await audio.play(client, "/second.wav", 1, "");
        const secondPause = vi.fn();
        elements[1].pause = secondPause;
        expect(firstPause).not.toHaveBeenCalled();
        elements[0].currentTime = 0.8;
        const originalEnd = elements[0].onended;
        await audio.play(client, "/first.wav", 1, "");
        expect(elements).toHaveLength(2);
        expect(elements[0].currentTime).toBe(0);
        expect(firstPause).toHaveBeenCalledOnce();
        expect(secondPause).not.toHaveBeenCalled();
        expect(play).toHaveBeenCalledTimes(3);
        originalEnd?.();
        await vi.advanceTimersByTimeAsync(9000);
        expect(firstPause).toHaveBeenCalledOnce();
        expect(secondPause).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1000);
        expect(firstPause).toHaveBeenCalledTimes(2);
        expect(secondPause).toHaveBeenCalledOnce();
        audio.dispose();
    });
    it("stops all overlapping sounds and cancels pending starts", async () => {
        const { elements, play } = playback();
        const client = {} as import("matrix-js-sdk/src/matrix").MatrixClient;
        const audio = new SoundboardAudio();
        await Promise.all([audio.play(client, "/first.wav", 1, ""), audio.play(client, "/second.wav", 1, "")]);
        expect(play).toHaveBeenCalledTimes(2);
        const firstPause = vi.fn();
        const secondPause = vi.fn();
        elements[0].pause = firstPause;
        elements[1].pause = secondPause;
        const pending = audio.play(client, "/third.wav", 1, "");
        audio.stop();
        await pending;
        expect(firstPause).toHaveBeenCalledOnce();
        expect(secondPause).toHaveBeenCalledOnce();
        expect(play).toHaveBeenCalledTimes(2);
        audio.dispose();
    });
    it("starts only the latest repeat when speaker selection is still pending", async () => {
        const { play, sink, elements } = playback();
        let selected!: () => void;
        sink.mockReturnValue(
            new Promise<void>((resolve) => {
                selected = resolve;
            }),
        );
        const client = {} as import("matrix-js-sdk/src/matrix").MatrixClient;
        const audio = new SoundboardAudio();
        const first = audio.play(client, "/first.wav", 1, "headset");
        await vi.waitFor(() => expect(sink).toHaveBeenCalledOnce());
        const repeat = audio.play(client, "/first.wav", 1, "headset");
        // Both sink selections share the same pending device operation.
        await vi.waitFor(() => expect(sink).toHaveBeenCalledTimes(2));
        selected();
        await Promise.all([first, repeat]);
        expect(elements).toHaveLength(1);
        expect(play).toHaveBeenCalledOnce();
        audio.dispose();
    });
    it("downloads and validates Matrix media once, reuses it, and releases it on disposal", async () => {
        const { pause, play, elements } = playback();
        const cancel = vi.fn().mockResolvedValue(undefined);
        const read = vi
            .fn()
            .mockResolvedValueOnce({ done: false, value: new Uint8Array([1, 2]) })
            .mockResolvedValueOnce({ done: true });
        const fetcher = vi.fn().mockResolvedValue({ ok: true, body: { getReader: () => ({ read, cancel }) } });
        vi.stubGlobal("fetch", fetcher);
        vi.spyOn(SoundboardAudio, "duration").mockResolvedValue(1);
        vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:audio");
        const revoke = vi.spyOn(URL, "revokeObjectURL");
        const client = {
            mxcUrlToHttp: vi.fn().mockReturnValue("https://matrix.example.org/media"),
            getAccessToken: () => "test-token",
        } as unknown as import("matrix-js-sdk/src/matrix").MatrixClient;
        const audio = new SoundboardAudio();
        await audio.play(client, "mxc://example.org/audio", 0.4, "");
        expect(fetcher).toHaveBeenCalledWith(
            "https://matrix.example.org/media",
            expect.objectContaining({ headers: { Authorization: "Bearer test-token" } }),
        );
        expect(cancel).toHaveBeenCalled();
        expect(play).toHaveBeenCalledOnce();
        audio.stop();
        expect(pause).toHaveBeenCalled();
        expect(revoke).not.toHaveBeenCalled();
        elements[0].currentTime = 0.7;
        await audio.play(client, "mxc://example.org/audio", 0.7, "");
        expect(elements).toHaveLength(1);
        expect(elements[0].currentTime).toBe(0);
        expect(fetcher).toHaveBeenCalledOnce();
        expect(SoundboardAudio.duration).toHaveBeenCalledOnce();
        expect(play).toHaveBeenCalledTimes(2);
        audio.dispose();
        expect(revoke).toHaveBeenCalledWith("blob:audio");
    });
    it("preloads a bounded library without playing and reuses the selected speaker on click", async () => {
        const { play, sink, load, elements, release } = playback();
        const client = {} as import("matrix-js-sdk/src/matrix").MatrixClient;
        const audio = new SoundboardAudio();
        const sources = Array.from({ length: 40 }, (_, i) => `/sound-${i}.wav`);
        audio.preload(client, sources, "headset");
        await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(24));
        expect(play).not.toHaveBeenCalled();
        await audio.play(client, sources[0], 1, "headset");
        expect(elements).toHaveLength(24);
        expect(sink).toHaveBeenCalledTimes(24);
        expect(play).toHaveBeenCalledOnce();
        await audio.play(client, sources[24], 1, "");
        expect(release).toHaveBeenCalledOnce();
        audio.dispose();
        expect(release).toHaveBeenCalledTimes(25);
        await expect(audio.play(client, sources[0], 1, "")).rejects.toThrow("disposed");
    });
    it("cancels in-flight prefetches on disposal and shares them with a click", async () => {
        const { play } = playback();
        const signals: AbortSignal[] = [];
        const fetcher = vi.fn((_url: string, { signal }: { signal: AbortSignal }) => {
            signals.push(signal);
            return new Promise((_resolve, reject) => {
                signal.addEventListener("abort", () => reject(new Error("cancelled")));
            });
        });
        vi.stubGlobal("fetch", fetcher);
        const client = {
            mxcUrlToHttp: (source: string) => source.replace("mxc://", "https://"),
            getAccessToken: () => "test-token",
        } as unknown as import("matrix-js-sdk/src/matrix").MatrixClient;
        const audio = new SoundboardAudio();
        audio.preload(client, ["mxc://example.org/first", "mxc://example.org/second", "mxc://example.org/third"], "");
        expect(fetcher).toHaveBeenCalledTimes(2);
        const pending = audio.play(client, "mxc://example.org/first", 1, "");
        expect(fetcher).toHaveBeenCalledTimes(2);
        audio.dispose();
        await pending;
        expect(signals.every((signal) => signal.aborted)).toBe(true);
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(play).not.toHaveBeenCalled();
    });
    it("rejects oversized remote media before decoding or playing it", async () => {
        const { play } = playback();
        const cancel = vi.fn().mockResolvedValue(undefined);
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue({
                ok: true,
                body: {
                    getReader: () => ({
                        read: async () => ({ value: new Uint8Array(SOUNDBOARD_MAX_BYTES + 1), done: false }),
                        cancel,
                    }),
                },
            }),
        );
        const client = {
            mxcUrlToHttp: () => "https://matrix.example.org/media",
            getAccessToken: () => "test-token",
        } as unknown as import("matrix-js-sdk/src/matrix").MatrixClient;
        const audio = new SoundboardAudio();
        await expect(audio.play(client, "mxc://example.org/audio", 1, "")).rejects.toThrow("size");
        expect(cancel).toHaveBeenCalled();
        expect(play).not.toHaveBeenCalled();
        audio.stop();
    });
});
