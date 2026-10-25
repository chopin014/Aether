/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import type {
    ScreenShareAudioApi,
    ScreenShareAudioEvent,
    ScreenShareAudioRequest,
    ScreenShareAudioTarget,
} from "shared-types";

import { loadScreenShareAudioWorklet } from "./screenShareAudioWorkletFactory";
import { SCREEN_SHARE_AUDIO_MAX_PACKET_FRAMES, SCREEN_SHARE_AUDIO_SAMPLE_RATE } from "./ScreenShareAudioRingBuffer";

const BYTES_PER_STEREO_FRAME = 8;
const MAX_PENDING_WORKLET_PACKETS = 8;

/** The audio and video tracks that a call can share, plus its audio-only cleanup action. */
export interface ScreenShareAudioCapture {
    stream: MediaStream;
    stop: () => Promise<void>;
}

/** Optional lifecycle and preload API dependencies for {@link captureScreenShareAudio}. */
export interface ScreenShareAudioOptions {
    signal?: AbortSignal;
    api?: ScreenShareAudioApi;
}

interface TrackStopPatch {
    track: MediaStreamTrack;
    wrapper: () => void;
    descriptor?: PropertyDescriptor;
}

/**
 * Attach explicitly selected desktop playback to a shared video stream.
 * The API is available only in the desktop app; raw native PCM is routed through an audio worklet without opening a
 * microphone or browser display-audio capture. When the video stream already has live audio, that track is preserved
 * and the native path is skipped so the same playback cannot be sent twice.
 *
 * @param video The stream returned by the approved desktop video picker.
 * @param videoSourceId The source identifier associated with that picker grant.
 * @param target The user's explicit system, window, or application audio choice.
 * @param options Abort signal and optional preload bridge override.
 * @returns The video stream with the captured playback track and an idempotent audio cleanup action.
 */
export async function captureScreenShareAudio(
    video: MediaStream,
    videoSourceId: string,
    target: ScreenShareAudioTarget,
    options: ScreenShareAudioOptions = {},
): Promise<ScreenShareAudioCapture> {
    const { signal } = options;
    if (signal?.aborted) throw abortError(signal.reason);

    const videoTracks = video.getVideoTracks();
    if (videoTracks.every((track) => track.readyState === "ended")) {
        throw new Error("A live shared video track is required for screen audio capture");
    }
    if (!videoSourceId) throw new Error("A video source identifier is required for screen audio capture");

    const existingAudioTracks = video.getAudioTracks().filter((track) => track.readyState !== "ended");
    if (existingAudioTracks.length > 0) return { stream: video, stop: async () => undefined };

    const api = options.api ?? window.electron?.screenShareAudio;
    if (!api) throw new Error("Screen audio capture is unavailable in this desktop session");

    const request: ScreenShareAudioRequest = {
        id: crypto.randomUUID(),
        videoSourceId,
        target,
    };

    let audioContext: AudioContext | undefined;
    let destination: MediaStreamAudioDestinationNode | undefined;
    let worklet: AudioWorkletNode | undefined;
    let audioTrack: MediaStreamTrack | undefined;
    let stopAudioTrack: (() => void) | undefined;
    let unsubscribe: (() => void) | undefined;
    let cleanupPromise: Promise<void> | undefined;
    let nativeStopPromise: Promise<void> | undefined;
    let starting = false;
    let startRequested = false;
    let startSettled = false;
    let stopped = false;
    let startupError: Error | undefined;
    let lastSequence = -1;
    const pendingWorkletSequences = new Set<number>();
    let rejectCancellation: (reason: Error) => void = () => undefined;
    const cancellation = new Promise<never>((_resolve, reject) => {
        rejectCancellation = reject;
    });
    // A cancellation can happen while the worklet module is loading, before Promise.race observes it.
    void cancellation.catch(() => undefined);

    const nativeStop = (): Promise<void> => {
        if (!startRequested) return Promise.resolve();
        if (!startSettled) {
            // This stop cancels a main-process start that is still resolving; a second stop follows a late success.
            return Promise.resolve()
                .then(() => api.stop(request.id))
                .catch(() => undefined);
        }
        nativeStopPromise ??= Promise.resolve()
            .then(() => api.stop(request.id))
            .catch(() => undefined);
        return nativeStopPromise;
    };

    const waitForCancellation = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, cancellation]);

    const trackStopPatches: TrackStopPatch[] = [];
    const trackEndedHandlers = new Map<MediaStreamTrack, () => void>();

    const restoreVideoTrackStops = (): void => {
        for (const { track, wrapper, descriptor } of trackStopPatches) {
            if (track.stop !== wrapper) continue;
            if (descriptor) Object.defineProperty(track, "stop", descriptor);
            else delete (track as unknown as { stop?: () => void }).stop;
        }
        trackStopPatches.length = 0;
    };

    const cleanup = (reason?: Error): Promise<void> => {
        if (cleanupPromise) return cleanupPromise;
        stopped = true;
        startupError ??= reason;
        if (starting) rejectCancellation(startupError ?? abortError());

        try {
            unsubscribe?.();
        } catch {
            // Listener removal is best effort; the stopped guard ignores any queued callbacks.
        }
        unsubscribe = undefined;
        signal?.removeEventListener("abort", onAbort);
        for (const [track, listener] of trackEndedHandlers) track.removeEventListener("ended", listener);
        trackEndedHandlers.clear();
        restoreVideoTrackStops();

        if (worklet) {
            worklet.port.onmessage = null;
            worklet.onprocessorerror = null;
            try {
                worklet.port.postMessage({ type: "stop" });
                worklet.port.close();
            } catch {
                // The audio context may already have closed the worklet port.
            }
            worklet.disconnect();
            worklet = undefined;
        }
        pendingWorkletSequences.clear();
        destination?.disconnect();
        destination = undefined;
        if (audioTrack) {
            audioTrack.removeEventListener("ended", onVideoTrackEnded);
            audioTrack.onended = null;
            try {
                (stopAudioTrack ?? audioTrack.stop.bind(audioTrack))();
            } catch {
                // Stopping an already-ended generated track is harmless.
            }
            audioTrack = undefined;
            stopAudioTrack = undefined;
        }

        const context = audioContext;
        audioContext = undefined;
        if (context) context.onstatechange = null;
        const nativeStopPromise = nativeStop();
        cleanupPromise = Promise.allSettled([
            nativeStopPromise,
            context && context.state !== "closed" ? context.close() : Promise.resolve(),
        ]).then(() => undefined);
        return cleanupPromise;
    };

    const onAbort = (): void => {
        void cleanup(abortError(signal?.reason));
    };

    const stopTrackOnFinish = (track: MediaStreamTrack): void => {
        const descriptor = Object.getOwnPropertyDescriptor(track, "stop");
        const originalStop = track.stop.bind(track);
        const wrapper = (): void => {
            try {
                originalStop();
            } finally {
                void cleanup(abortError());
            }
        };
        try {
            Object.defineProperty(track, "stop", {
                configurable: true,
                enumerable: descriptor?.enumerable ?? false,
                writable: true,
                value: wrapper,
            });
            trackStopPatches.push({ track, wrapper, descriptor });
        } catch {
            // Ended listeners and the returned stop action still cover non-extensible browser tracks.
        }
    };

    const onVideoTrackEnded = (): void => {
        void cleanup(abortError());
    };

    const onNativeEvent = (event: ScreenShareAudioEvent): void => {
        if (stopped || event.id !== request.id) return;
        if (event.type === "stopped") {
            void cleanup(event.error ? new Error(event.error) : undefined);
            return;
        }

        if (!worklet || !Number.isSafeInteger(event.sequence) || event.sequence < 0 || event.sequence <= lastSequence) {
            return;
        }
        const pcm = event.pcm;
        if (
            !(pcm instanceof Uint8Array) ||
            pcm.byteLength === 0 ||
            pcm.byteLength > SCREEN_SHARE_AUDIO_MAX_PACKET_FRAMES * BYTES_PER_STEREO_FRAME ||
            pcm.byteLength % BYTES_PER_STEREO_FRAME !== 0
        ) {
            return;
        }

        lastSequence = event.sequence;
        if (pendingWorkletSequences.size >= MAX_PENDING_WORKLET_PACKETS) return;
        const packet = new Uint8Array(pcm.byteLength);
        packet.set(pcm);
        try {
            pendingWorkletSequences.add(event.sequence);
            worklet.port.postMessage({ type: "pcm", sequence: event.sequence, pcm: packet.buffer }, [packet.buffer]);
        } catch {
            pendingWorkletSequences.delete(event.sequence);
            void cleanup(new Error("Screen audio could not reach the audio thread"));
        }
    };

    const onWorkletMessage = (event: MessageEvent<{ type: "received"; sequence: number }>): void => {
        if (event.data.type === "received") pendingWorkletSequences.delete(event.data.sequence);
    };

    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    for (const track of videoTracks) {
        const listener = onVideoTrackEnded;
        trackEndedHandlers.set(track, listener);
        track.addEventListener("ended", listener, { once: true });
        stopTrackOnFinish(track);
    }
    if (signal?.aborted || videoTracks.some((track) => track.readyState === "ended")) {
        await cleanup(signal?.aborted ? abortError(signal.reason) : abortError());
        throw startupError ?? abortError();
    }

    starting = true;
    try {
        audioContext = new AudioContext({ sampleRate: SCREEN_SHARE_AUDIO_SAMPLE_RATE, latencyHint: "interactive" });
        if (audioContext.sampleRate !== SCREEN_SHARE_AUDIO_SAMPLE_RATE) {
            throw new Error("Screen audio requires a 48 kHz audio context");
        }
        audioContext.onstatechange = (): void => {
            if (audioContext?.state === "closed" && !stopped) {
                void cleanup(new Error("The screen audio context closed unexpectedly"));
            }
        };

        await waitForCancellation(loadScreenShareAudioWorklet(audioContext));
        if (stopped) throw startupError ?? abortError();
        await waitForCancellation(audioContext.resume());
        if (stopped) throw startupError ?? abortError();

        worklet = new AudioWorkletNode(audioContext, "aether-screen-share-audio", {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [2],
            channelCount: 2,
            channelCountMode: "explicit",
        });
        destination = audioContext.createMediaStreamDestination();
        audioTrack = destination.stream.getAudioTracks()[0];
        if (!audioTrack) throw new Error("Screen audio did not produce an output track");
        const outputTrack = audioTrack;
        const rawAudioTrackStop = outputTrack.stop.bind(outputTrack);
        stopAudioTrack = rawAudioTrackStop;
        outputTrack.stop = (): void => {
            void cleanup(abortError());
        };
        outputTrack.addEventListener("ended", onVideoTrackEnded, { once: true });
        worklet.onprocessorerror = (): void => {
            void cleanup(new Error("The screen audio worklet stopped unexpectedly"));
        };
        worklet.port.onmessage = onWorkletMessage;
        worklet.connect(destination);

        unsubscribe = api.onEvent(onNativeEvent);
        if (stopped) throw startupError ?? abortError();

        const stream = new MediaStream([...video.getTracks(), outputTrack]);
        startRequested = true;
        const startPromise = api.start(request);
        void startPromise.then(
            () => {
                startSettled = true;
                if (stopped) void nativeStop();
            },
            () => {
                startSettled = true;
                if (stopped) void nativeStop();
            },
        );

        await Promise.race([startPromise, cancellation]);
        starting = false;
        if (stopped) throw startupError ?? abortError();

        return { stream, stop: () => cleanup() };
    } catch (error) {
        starting = false;
        await cleanup(toError(error));
        throw startupError ?? toError(error);
    }
}

function abortError(reason?: unknown): Error {
    if (reason instanceof Error) return reason;
    return new DOMException("Screen audio capture was cancelled", "AbortError");
}

function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error("Screen audio capture failed");
}
