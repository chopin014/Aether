/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type RnnoiseWorkletNode } from "@sapphi-red/web-noise-suppressor";
import { logger } from "matrix-js-sdk/src/logger";

// The ?url resource query exports a URL, while the package's declaration describes the worklet itself.
// oxlint-disable-next-line import/default
import workletUrl from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import wasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import simdWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";
import SettingsStore from "../settings/SettingsStore";
import { loadVoiceGateWorklet } from "./voiceGateWorkletFactory";
import { normalizeVoiceGateSettings, type VoiceGateLevel, type VoiceGateSettings } from "./voice-gate-types";

const watchedSettings = [
    "webrtc_audio_noiseSuppression",
    "webrtc_audio_inputVolume",
    "webrtc_audio_automaticSensitivity",
    "webrtc_audio_sensitivity",
] as const;

/** Apply optional RNNoise, input gain and voice activation before LiveKit encodes microphone audio. */
export class NoiseSuppressionProcessor {
    public readonly name = "aether-rnnoise";
    public processedTrack: MediaStreamTrack | undefined;

    private context?: AudioContext;
    private source?: MediaStreamAudioSourceNode;
    private denoiser?: RnnoiseWorkletNode;
    private destination?: MediaStreamAudioDestinationNode;
    private gate?: AudioWorkletNode;
    private watchers: string[] = [];
    private generation = 0;
    private initialization?: AbortController;

    /** The optional meter receives post-gain, post-suppression levels before voice activation, at most 20 Hz. */
    public constructor(
        private readonly onLevel?: (levelDb: number, voiceDetected: boolean, thresholdDb: number) => void,
    ) {}

    /** Attach to LiveKit's existing microphone. This never requests another microphone stream. */
    public async init({ track }: { track: MediaStreamTrack }): Promise<void> {
        const generation = ++this.generation;
        const initialization = (this.initialization = new AbortController());
        const cancelled = new Promise<never>((_, reject) => {
            initialization.signal.addEventListener("abort", () => reject(initialization.signal.reason), { once: true });
        });
        // AudioContext construction can fail before the first cancellation race is installed.
        void cancelled.catch(() => {});
        const deadline = setTimeout(
            () => initialization.abort(new Error("Microphone processing startup timed out")),
            10000,
        );
        try {
            // RNNoise requires 48 kHz. Web Audio resamples microphones with other sample rates.
            const context = (this.context = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" }));
            await Promise.race([loadVoiceGateWorklet(context), cancelled]);
            if (generation !== this.generation) return;

            if (context.state === "suspended") {
                let timer: ReturnType<typeof setTimeout> | undefined;
                try {
                    await Promise.race([
                        context.resume(),
                        cancelled,
                        new Promise<never>((_, reject) => {
                            timer = setTimeout(() => reject(new Error("Audio processing could not start")), 2000);
                        }),
                    ]);
                } finally {
                    clearTimeout(timer);
                }
            }
            if (generation !== this.generation) return;

            this.gate = new AudioWorkletNode(context, "aether-voice-gate", {
                numberOfInputs: 1,
                numberOfOutputs: 1,
                outputChannelCount: [1],
                channelCount: 1,
                channelCountMode: "explicit",
                processorOptions: this.getGateSettings(),
            });
            this.gate.port.onmessage = (event: MessageEvent<VoiceGateLevel>): void => {
                if (generation !== this.generation) return;
                const { levelDb, voiceDetected, thresholdDb } = event.data;
                this.onLevel?.(levelDb, voiceDetected, thresholdDb);
            };

            // Suppression is optional: model/import failures must preserve gain and voice activation.
            try {
                // Import lazily: the library references AudioWorkletNode at module evaluation time.
                const { RnnoiseWorkletNode, loadRnnoise } = await Promise.race([
                    import("@sapphi-red/web-noise-suppressor"),
                    cancelled,
                ]);
                if (generation !== this.generation) return;
                const [wasmBinary] = await Promise.race([
                    Promise.all([
                        loadRnnoise({ url: wasmUrl, simdUrl: simdWasmUrl }, { signal: initialization.signal }),
                        context.audioWorklet.addModule(workletUrl),
                    ]),
                    cancelled,
                ]);
                if (generation !== this.generation) return;
                this.denoiser = new RnnoiseWorkletNode(context, { wasmBinary, maxChannels: 1 });
                this.denoiser.channelCount = 1;
                this.denoiser.channelCountMode = "explicit";
                await Promise.race([this.denoiser.ready, cancelled]);
            } catch (error) {
                if (generation !== this.generation) return;
                logger.warn("Could not start RNNoise; continuing with browser noise suppression", error);
                initialization.abort(error);
                this.releaseDenoiser();
            }
            if (generation !== this.generation) return;

            this.source = context.createMediaStreamSource(new MediaStream([track]));
            this.destination = context.createMediaStreamDestination();
            this.destination.channelCount = 1;
            this.gate.connect(this.destination);
            this.denoiser?.connect(this.gate);
            this.processedTrack = this.destination.stream.getAudioTracks()[0];
            for (const setting of watchedSettings) {
                this.watchers.push(
                    // The generation check above prevents subscriptions after destruction.
                    // oxlint-disable-next-line element-web/no-subscribe-after-await
                    SettingsStore.watchSetting(
                        setting,
                        null,
                        setting === "webrtc_audio_noiseSuppression" ? this.updateRouting : this.updateGateSettings,
                    ),
                );
            }
            this.updateGateSettings();
            this.updateRouting();

            if (this.denoiser) {
                // A failed suppressor emits silence forever. Keep the gate while bypassing only suppression.
                this.denoiser.onprocessorerror = (): void => {
                    if (generation !== this.generation) return;
                    logger.warn("RNNoise stopped; continuing with browser noise suppression");
                    this.releaseDenoiser();
                    this.updateRouting();
                };
            }
        } catch (error) {
            if (generation !== this.generation) return;
            logger.warn("Could not start microphone processing; continuing with the original microphone", error);
            await this.destroy();
        } finally {
            clearTimeout(deadline);
            if (this.initialization === initialization) this.initialization = undefined;
        }
    }

    /** Rebuild the graph when LiveKit replaces the microphone after a device change. */
    public async restart(options: { track: MediaStreamTrack }): Promise<void> {
        const closing = this.destroy();
        const generation = this.generation;
        await closing;
        if (generation !== this.generation) return;
        await this.init(options);
    }

    /** Release only this processor's resources; LiveKit owns the original microphone. */
    public async destroy(): Promise<void> {
        ++this.generation;
        this.initialization?.abort(new Error("Noise suppression was destroyed"));
        this.initialization = undefined;
        for (const watcher of this.watchers) SettingsStore.unwatchSetting(watcher);
        this.watchers = [];
        this.source?.disconnect();
        this.releaseDenoiser();
        if (this.gate) {
            this.gate.port.onmessage = null;
            this.gate.port.postMessage({ destroy: true });
            this.gate.port.close();
            this.gate.disconnect();
        }
        this.destination?.disconnect();
        this.processedTrack?.stop();
        const context = this.context;
        this.context = this.source = this.gate = this.destination = this.processedTrack = undefined;
        if (context && context.state !== "closed") await context.close().catch(() => {});
    }

    private releaseDenoiser(): void {
        if (this.denoiser) this.denoiser.onprocessorerror = null;
        this.denoiser?.disconnect();
        this.denoiser?.destroy();
        this.denoiser = undefined;
    }

    private getGateSettings = (): VoiceGateSettings =>
        normalizeVoiceGateSettings({
            inputVolume: SettingsStore.getValue("webrtc_audio_inputVolume"),
            automaticSensitivity: SettingsStore.getValue("webrtc_audio_automaticSensitivity"),
            sensitivity: SettingsStore.getValue("webrtc_audio_sensitivity"),
        });

    private updateGateSettings = (): void => {
        this.gate?.port.postMessage(this.getGateSettings());
    };

    private updateRouting = (): void => {
        if (!this.source || !this.gate) return;
        this.source.disconnect();
        this.source.connect(
            SettingsStore.getValue("webrtc_audio_noiseSuppression") && this.denoiser ? this.denoiser : this.gate,
        );
    };
}
