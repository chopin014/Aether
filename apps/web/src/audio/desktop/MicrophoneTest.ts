/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import MediaDeviceHandler from "../../MediaDeviceHandler";
import SettingsStore from "../../settings/SettingsStore";
import { getBrowserNoiseSuppression, getMicrophoneGateConfig } from "./DesktopVoicePipeline";
import { type DenoiserStatusListener, MicrophoneProcessor } from "./MicrophoneProcessor";

/** Why a media test could not start. */
export type MediaTestError = "denied" | "unavailable";

/** Turns a failed `getUserMedia` into the reason shown to the user. */
export function mediaTestError(error: unknown): MediaTestError {
    const name = error instanceof DOMException || error instanceof Error ? error.name : "";
    return name === "NotAllowedError" || name === "SecurityError" ? "denied" : "unavailable";
}

/**
 * Plays the microphone back through the speakers, after the same noise suppression, volume and sensitivity a
 * call applies, and reports its loudness. Everything it opens is closed by {@link stop}, which the settings call
 * when the user stops the test or leaves the page.
 */
export class MicrophoneTest {
    private stream?: MediaStream;
    private playback?: HTMLAudioElement;
    private processor?: MicrophoneProcessor;
    private starting = false;

    /**
     * @param onLevel called for every block of audio with its loudness in dB and whether it would be sent.
     * @param onDenoiserStatus called when noise suppression starts, or stops because it failed or was too slow.
     */
    public constructor(
        private readonly onLevel: (levelDb: number, open: boolean) => void,
        private readonly onDenoiserStatus?: DenoiserStatusListener,
    ) {}

    public get active(): boolean {
        return !!this.stream;
    }

    /** @throws the reason from `getUserMedia` when the microphone cannot be opened. */
    public async start(): Promise<void> {
        if (this.stream || this.starting) return;
        this.starting = true;
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
            if (!this.starting) {
                stream.getTracks().forEach((track) => track.stop());
                return;
            }
            this.stream = stream;
            const processor = new MicrophoneProcessor(this.gateConfig());
            processor.onLevel = this.onLevel;
            processor.onDenoiserStatus = this.onDenoiserStatus;
            this.processor = processor;
            await processor.init({ kind: "audio", track: stream.getAudioTracks()[0] });
            await this.play(processor.processedTrack);
        } catch (error) {
            this.stop();
            throw error;
        } finally {
            this.starting = false;
        }
    }

    /** Applies changed volume or sensitivity settings to the running test. */
    public update(): void {
        this.processor?.setConfig(this.gateConfig());
        if (this.playback) this.playback.volume = this.speakerVolume();
    }

    public stop(): void {
        this.starting = false;
        this.stream?.getTracks().forEach((track) => track.stop());
        void this.processor?.destroy();
        if (this.playback) {
            this.playback.pause();
            this.playback.srcObject = null;
        }
        this.stream = this.playback = this.processor = undefined;
    }

    /** Push to talk is for calls; the test always shows what the sensitivity would let through. */
    private gateConfig(): ReturnType<typeof getMicrophoneGateConfig> {
        return { ...getMicrophoneGateConfig(), pushToTalk: false };
    }

    private speakerVolume(): number {
        return SettingsStore.getValue("desktopSpeakerVolume") / 100;
    }

    private async play(track: MediaStreamTrack | undefined): Promise<void> {
        if (!track) return;
        const audio = new Audio();
        audio.srcObject = new MediaStream([track]);
        audio.volume = this.speakerVolume();
        const output = MediaDeviceHandler.getAudioOutput();
        if (output && audio.setSinkId) await audio.setSinkId(output).catch(() => {});
        this.playback = audio;
        await audio.play();
    }
}
