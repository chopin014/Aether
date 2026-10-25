/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import MediaDeviceHandler from "../../MediaDeviceHandler";
import SettingsStore from "../../settings/SettingsStore";
import { getBrowserNoiseSuppression, getMicrophoneGateConfig } from "./DesktopVoicePipeline";
import { type DenoiserStatusListener, type MicrophoneLevelListener, MicrophoneProcessor } from "./MicrophoneProcessor";

/** Why a media test could not start. */
export type MediaTestError = "denied" | "unavailable";

/** Turns a failed `getUserMedia` into the reason shown to the user. */
export function mediaTestError(error: unknown): MediaTestError {
    const name = error instanceof DOMException || error instanceof Error ? error.name : "";
    return name === "NotAllowedError" || name === "SecurityError" ? "denied" : "unavailable";
}

/**
 * Runs the microphone through the same noise suppression, volume and sensitivity a call applies and reports its
 * loudness, optionally playing it back through the speakers. Everything it opens is closed by {@link stop}, which
 * the settings call when the user leaves the page.
 */
export class MicrophoneTest {
    private stream?: MediaStream;
    private playback?: HTMLAudioElement;
    private processor?: MicrophoneProcessor;
    private generation = 0;
    private playbackGeneration = 0;
    private opening?: Promise<void>;
    private startingPlayback?: Promise<void>;

    /**
     * @param onLevel called with the loudness in dB, whether it would be sent and the threshold in use.
     * @param onDenoiserStatus called when noise suppression starts, or stops because it failed or was too slow.
     */
    public constructor(
        private readonly onLevel: MicrophoneLevelListener,
        private readonly onDenoiserStatus?: DenoiserStatusListener,
    ) {}

    public get active(): boolean {
        return !!this.stream;
    }

    /** Whether the microphone is being played back, rather than only measured. */
    public get playing(): boolean {
        return !!this.playback;
    }

    /**
     * Opens the microphone, playing it back unless only its level is wanted.
     * @throws the reason from `getUserMedia` when the microphone cannot be opened.
     */
    public async start({ playback = true }: { playback?: boolean } = {}): Promise<void> {
        const generation = this.generation;
        const playbackGeneration = this.playbackGeneration;
        // A second caller, such as the user starting the test while the level is being set up, shares the first.
        const opening = (this.opening ??= this.open(generation));
        try {
            await opening;
        } finally {
            if (this.opening === opening) this.opening = undefined;
        }
        if (generation !== this.generation || playbackGeneration !== this.playbackGeneration) return;
        if (playback) await this.setPlayback(true);
    }

    private async open(generation: number): Promise<void> {
        if (this.stream) return;
        try {
            const deviceId = MediaDeviceHandler.getAudioInput();
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    deviceId: deviceId && deviceId !== "default" ? { exact: deviceId } : undefined,
                    echoCancellation: MediaDeviceHandler.getAudioEchoCancellation(),
                    autoGainControl: MediaDeviceHandler.getAudioAutoGainControl(),
                    noiseSuppression: getBrowserNoiseSuppression(),
                },
            });
            // The user may have stopped the test while the browser was asking for permission.
            if (generation !== this.generation) {
                stream.getTracks().forEach((track) => track.stop());
                return;
            }
            this.stream = stream;
            const processor = new MicrophoneProcessor(this.gateConfig());
            processor.onLevel = (...level) => {
                if (generation === this.generation) this.onLevel(...level);
            };
            processor.onDenoiserStatus = (status) => {
                if (generation === this.generation) this.onDenoiserStatus?.(status);
            };
            this.processor = processor;
            await processor.init({ kind: "audio", track: stream.getAudioTracks()[0] });
        } catch (error) {
            // A cancelled opener must not close a newer microphone or report its cancellation as a failure.
            if (generation !== this.generation) return;
            this.stop();
            throw error;
        }
    }

    /** Applies changed volume or sensitivity settings to the running test. */
    public update(): void {
        this.processor?.setConfig(this.gateConfig());
        if (this.playback) this.playback.volume = this.speakerVolume();
    }

    /** Starts or stops hearing yourself, while the level keeps being measured. */
    public async setPlayback(enabled: boolean): Promise<void> {
        if (!enabled) {
            this.stopPlayback();
            return;
        }
        const generation = this.generation;
        const playbackGeneration = this.playbackGeneration;
        await this.opening;
        if (generation !== this.generation || playbackGeneration !== this.playbackGeneration) return;
        if (this.startingPlayback) return this.startingPlayback;
        if (this.playback || !this.processor?.processedTrack) return;
        const starting = (this.startingPlayback = this.play(
            this.processor.processedTrack,
            generation,
            playbackGeneration,
        ));
        try {
            await starting;
        } catch (error) {
            if (generation !== this.generation || playbackGeneration !== this.playbackGeneration) return;
            this.stop();
            throw error;
        } finally {
            if (this.startingPlayback === starting) this.startingPlayback = undefined;
        }
    }

    public stop(): void {
        ++this.generation;
        this.opening = undefined;
        this.stream?.getTracks().forEach((track) => track.stop());
        void this.processor?.destroy();
        this.stopPlayback();
        this.stream = this.processor = undefined;
    }

    private stopPlayback(): void {
        ++this.playbackGeneration;
        this.startingPlayback = undefined;
        if (this.playback) {
            this.playback.pause();
            this.playback.srcObject = null;
        }
        this.playback = undefined;
    }

    /** Push to talk is for calls; the test always shows what the sensitivity would let through. */
    private gateConfig(): ReturnType<typeof getMicrophoneGateConfig> {
        return { ...getMicrophoneGateConfig(), pushToTalk: false };
    }

    private speakerVolume(): number {
        return SettingsStore.getValue("desktopSpeakerVolume") / 100;
    }

    private async play(track: MediaStreamTrack, generation: number, playbackGeneration: number): Promise<void> {
        const audio = new Audio();
        audio.srcObject = new MediaStream([track]);
        audio.volume = this.speakerVolume();
        this.playback = audio;
        try {
            const output = MediaDeviceHandler.getAudioOutput();
            if (output && audio.setSinkId) await audio.setSinkId(output).catch(() => {});
            if (generation !== this.generation || playbackGeneration !== this.playbackGeneration) return;
            await audio.play();
        } catch (error) {
            if (generation !== this.generation || playbackGeneration !== this.playbackGeneration) return;
            throw error;
        } finally {
            // Sink selection and playback can finish after stop, or after another test has started.
            if (generation !== this.generation || playbackGeneration !== this.playbackGeneration) {
                audio.pause();
                audio.srcObject = null;
            }
        }
    }
}
