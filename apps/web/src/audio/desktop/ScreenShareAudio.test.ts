/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScreenShareAudioApi, ScreenShareAudioEvent, ScreenShareAudioRequest } from "shared-types";

import { captureScreenShareAudio } from "./ScreenShareAudio";
import { loadScreenShareAudioWorklet } from "./screenShareAudioWorkletFactory";
import { SCREEN_SHARE_AUDIO_MAX_PACKET_FRAMES } from "./ScreenShareAudioRingBuffer";

vi.mock("./screenShareAudioWorkletFactory", () => ({
    loadScreenShareAudioWorklet: vi.fn().mockResolvedValue(undefined),
}));

class FakeTrack extends EventTarget {
    public readyState: MediaStreamTrackState = "live";
    public stop = vi.fn(() => {
        this.readyState = "ended";
    });

    public constructor(public readonly kind: "audio" | "video") {
        super();
    }
}

class FakeMediaStream {
    public constructor(public readonly tracks: MediaStreamTrack[]) {}

    public getTracks(): MediaStreamTrack[] {
        return this.tracks;
    }

    public getVideoTracks(): MediaStreamTrack[] {
        return this.tracks.filter((track) => track.kind === "video");
    }

    public getAudioTracks(): MediaStreamTrack[] {
        return this.tracks.filter((track) => track.kind === "audio");
    }
}

interface FakeWorkletNode {
    name: string;
    port: {
        postMessage: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
        onmessage: ((event: MessageEvent<{ type: "received"; sequence: number }>) => void) | null;
    };
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    onprocessorerror: (() => void) | null;
}

const audioContexts: FakeAudioContext[] = [];
const worklets: FakeWorkletNode[] = [];

class FakeAudioContext {
    public readonly sampleRate = 48_000;
    public state: AudioContextState = "running";
    public onstatechange: ((this: BaseAudioContext, ev: Event) => void) | null = null;
    public audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
    public close = vi.fn(async () => {
        this.state = "closed";
    });
    public resume = vi.fn().mockResolvedValue(undefined);
    public destinationTrack = new FakeTrack("audio");
    public destination = {
        stream: new FakeMediaStream([this.destinationTrack as unknown as MediaStreamTrack]),
        disconnect: vi.fn(),
    };
    public createMediaStreamDestination = vi.fn(() => this.destination);

    public constructor(public readonly options?: AudioContextOptions) {
        audioContexts.push(this);
    }
}

class FakeAudioWorkletNode {
    public port = { postMessage: vi.fn(), close: vi.fn(), onmessage: null };
    public connect = vi.fn();
    public disconnect = vi.fn();
    public onprocessorerror: (() => void) | null = null;

    public constructor(
        _context: AudioContext,
        public readonly name: string,
        public readonly options: AudioWorkletNodeOptions,
    ) {
        worklets.push(this);
    }
}

interface TestApi extends ScreenShareAudioApi {
    emit: (event: ScreenShareAudioEvent) => void;
    listenerCount: () => number;
}

function makeApi(
    onStart: (request: ScreenShareAudioRequest, emit: TestApi["emit"]) => Promise<void> = async () => undefined,
): TestApi {
    const listeners = new Set<(event: ScreenShareAudioEvent) => void>();
    const emit = (event: ScreenShareAudioEvent): void => {
        for (const listener of listeners) listener(event);
    };
    return {
        capabilities: vi.fn().mockResolvedValue({ system: true, application: true, window: true }),
        applications: vi.fn().mockResolvedValue([]),
        start: vi.fn((request) => onStart(request, emit)),
        stop: vi.fn().mockResolvedValue(undefined),
        onEvent: vi.fn((listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        }),
        emit,
        listenerCount: () => listeners.size,
    };
}

function makeVideoStream(...tracks: FakeTrack[]): MediaStream {
    return new FakeMediaStream(tracks as unknown as MediaStreamTrack[]) as unknown as MediaStream;
}

function pcm(frameCount = 1): Uint8Array {
    return new Uint8Array(frameCount * 8);
}

describe("captureScreenShareAudio", () => {
    let videoTrack: FakeTrack;

    beforeEach(() => {
        audioContexts.length = 0;
        worklets.length = 0;
        vi.mocked(loadScreenShareAudioWorklet).mockReset().mockResolvedValue(undefined);
        vi.stubGlobal("AudioContext", FakeAudioContext);
        vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);
        vi.stubGlobal("MediaStream", FakeMediaStream);
        vi.stubGlobal("crypto", { randomUUID: vi.fn().mockReturnValue("request-1") });
        videoTrack = new FakeTrack("video");
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("subscribes before native start and combines raw 48 kHz PCM with the selected video", async () => {
        const api = makeApi(async (request, emit) => {
            emit({ type: "data", id: request.id, sequence: 1, pcm: pcm() });
        });
        const video = makeVideoStream(videoTrack);

        const capture = await captureScreenShareAudio(video, "screen:7:0", { kind: "system" }, { api });

        expect(vi.mocked(api.onEvent).mock.invocationCallOrder[0]).toBeLessThan(
            vi.mocked(api.start).mock.invocationCallOrder[0],
        );
        expect(api.start).toHaveBeenCalledWith({
            id: "request-1",
            videoSourceId: "screen:7:0",
            target: { kind: "system" },
        });
        expect(audioContexts[0].options).toEqual({ sampleRate: 48_000, latencyHint: "interactive" });
        expect(audioContexts[0].createMediaStreamDestination).toHaveBeenCalledOnce();
        expect(worklets[0].name).toBe("aether-screen-share-audio");
        expect(worklets[0].port.postMessage).toHaveBeenCalledWith(
            { type: "pcm", sequence: 1, pcm: expect.any(ArrayBuffer) },
            [expect.any(ArrayBuffer)],
        );
        expect(capture.stream.getTracks()).toEqual([videoTrack, audioContexts[0].destinationTrack]);

        await capture.stop();
        expect(api.stop).toHaveBeenCalledWith("request-1");
        expect(api.listenerCount()).toBe(0);
        expect(audioContexts[0].destinationTrack.readyState).toBe("ended");
        expect(audioContexts[0].close).toHaveBeenCalledOnce();
        expect(worklets[0].disconnect).toHaveBeenCalledOnce();
    });

    it("ignores unrelated, duplicate, and oversized native packets", async () => {
        const api = makeApi(async (request, emit) => {
            emit({ type: "data", id: "other-request", sequence: 1, pcm: pcm() });
            emit({ type: "data", id: request.id, sequence: 1, pcm: pcm() });
            emit({ type: "data", id: request.id, sequence: 1, pcm: pcm() });
            emit({
                type: "data",
                id: request.id,
                sequence: 2,
                pcm: pcm(SCREEN_SHARE_AUDIO_MAX_PACKET_FRAMES + 1),
            });
        });

        const capture = await captureScreenShareAudio(
            makeVideoStream(videoTrack),
            "screen:7:0",
            { kind: "window" },
            { api },
        );

        expect(worklets[0].port.postMessage).toHaveBeenCalledOnce();
        await capture.stop();
    });

    it("bounds queued worklet messages and resumes forwarding after an acknowledgement", async () => {
        const api = makeApi();
        const capture = await captureScreenShareAudio(
            makeVideoStream(videoTrack),
            "screen:7:0",
            { kind: "system" },
            { api },
        );

        for (let sequence = 1; sequence <= 12; sequence++) {
            api.emit({ type: "data", id: "request-1", sequence, pcm: pcm() });
        }
        expect(worklets[0].port.postMessage).toHaveBeenCalledTimes(8);

        worklets[0].port.onmessage?.({ data: { type: "received", sequence: 1 } } as MessageEvent<{
            type: "received";
            sequence: number;
        }>);
        api.emit({ type: "data", id: "request-1", sequence: 13, pcm: pcm() });

        expect(worklets[0].port.postMessage).toHaveBeenCalledTimes(9);
        expect(worklets[0].port.postMessage).toHaveBeenLastCalledWith(
            { type: "pcm", sequence: 13, pcm: expect.any(ArrayBuffer) },
            [expect.any(ArrayBuffer)],
        );
        await capture.stop();
    });

    it("stops native capture and closes the graph when startup fails", async () => {
        const api = makeApi(async () => {
            throw new Error("native capture rejected");
        });

        await expect(
            captureScreenShareAudio(
                makeVideoStream(videoTrack),
                "screen:7:0",
                { kind: "application", id: "42" },
                { api },
            ),
        ).rejects.toThrow("native capture rejected");

        expect(api.stop).toHaveBeenCalledWith("request-1");
        expect(api.listenerCount()).toBe(0);
        expect(audioContexts[0].destinationTrack.readyState).toBe("ended");
        expect(audioContexts[0].close).toHaveBeenCalledOnce();
        expect(worklets[0].disconnect).toHaveBeenCalledOnce();
    });

    it("cancels a pending native start and stops again if it resolves late", async () => {
        let resolveStart!: () => void;
        const api = makeApi(
            () =>
                new Promise<void>((resolve) => {
                    resolveStart = resolve;
                }),
        );
        const controller = new AbortController();
        const pending = captureScreenShareAudio(
            makeVideoStream(videoTrack),
            "screen:7:0",
            { kind: "system" },
            {
                api,
                signal: controller.signal,
            },
        );
        await vi.waitFor(() => expect(api.start).toHaveBeenCalledOnce());

        controller.abort();
        await expect(pending).rejects.toMatchObject({ name: "AbortError" });
        expect(api.stop).toHaveBeenCalledTimes(1);

        resolveStart();
        await vi.waitFor(() => expect(api.stop).toHaveBeenCalledTimes(2));
        expect(audioContexts[0].close).toHaveBeenCalledOnce();
    });

    it("races worklet loading against abort and never starts native capture", async () => {
        let resolveWorklet!: () => void;
        vi.mocked(loadScreenShareAudioWorklet).mockReturnValue(
            new Promise<void>((resolve) => {
                resolveWorklet = resolve;
            }),
        );
        const api = makeApi();
        const controller = new AbortController();
        const pending = captureScreenShareAudio(
            makeVideoStream(videoTrack),
            "screen:7:0",
            { kind: "system" },
            {
                api,
                signal: controller.signal,
            },
        );
        await vi.waitFor(() => expect(loadScreenShareAudioWorklet).toHaveBeenCalledOnce());

        controller.abort();
        await expect(pending).rejects.toMatchObject({ name: "AbortError" });
        resolveWorklet();
        expect(api.start).not.toHaveBeenCalled();
        expect(audioContexts[0].close).toHaveBeenCalledOnce();
    });

    it("stops on the video ended event and on explicit share-track stop", async () => {
        const api = makeApi();
        const capture = await captureScreenShareAudio(
            makeVideoStream(videoTrack),
            "screen:7:0",
            { kind: "system" },
            { api },
        );

        videoTrack.dispatchEvent(new Event("ended"));
        await capture.stop();
        expect(api.stop).toHaveBeenCalledOnce();

        const secondApi = makeApi();
        const secondVideoTrack = new FakeTrack("video");
        const secondCapture = await captureScreenShareAudio(
            makeVideoStream(secondVideoTrack),
            "screen:8:0",
            { kind: "system" },
            { api: secondApi },
        );
        secondVideoTrack.stop();
        await secondCapture.stop();
        expect(secondApi.stop).toHaveBeenCalledOnce();
        expect(audioContexts[1].close).toHaveBeenCalledOnce();
    });

    it("stops the native capture when the returned share audio track is stopped", async () => {
        const api = makeApi();
        const capture = await captureScreenShareAudio(
            makeVideoStream(videoTrack),
            "screen:7:0",
            { kind: "system" },
            { api },
        );

        capture.stream.getAudioTracks()[0].stop();
        await capture.stop();

        expect(api.stop).toHaveBeenCalledOnce();
        expect(audioContexts[0].close).toHaveBeenCalledOnce();
    });

    it("keeps an existing video audio track without adding or starting another one", async () => {
        const existingAudioTrack = new FakeTrack("audio");
        const video = makeVideoStream(videoTrack, existingAudioTrack);
        const api = makeApi();

        const capture = await captureScreenShareAudio(video, "screen:7:0", { kind: "system" }, { api });

        expect(capture.stream).toBe(video);
        expect(api.start).not.toHaveBeenCalled();
        expect(audioContexts).toHaveLength(0);
    });

    it("stops on native failure after capture has started", async () => {
        const api = makeApi();
        const capture = await captureScreenShareAudio(
            makeVideoStream(videoTrack),
            "screen:7:0",
            { kind: "system" },
            { api },
        );
        api.emit({ type: "stopped", id: "request-1", error: "provider exited" });
        await capture.stop();

        expect(api.stop).toHaveBeenCalledOnce();
        expect(audioContexts[0].destinationTrack.readyState).toBe("ended");
        expect(audioContexts[0].close).toHaveBeenCalledOnce();
    });
});
