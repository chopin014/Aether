/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { logger } from "matrix-js-sdk/src/logger";
import { type ElementCallMicrophoneProcessor } from "@element-hq/element-call-component/api";

import { type MicrophoneGateConfig } from "./MicrophoneGate";
import { type MicrophoneGateWorkletOptions, type MicrophoneProcessorState } from "./MicrophoneProcessorState";
import { loadMicrophoneGateWorklet } from "./microphoneGateWorkletFactory";
import { DENOISER_SAMPLE_RATE } from "./denoiser/Denoiser";
import { type DenoiserStatus } from "./denoiser/DenoiserStatus";
import { loadDenoiserModule } from "./denoiser/loadDenoiserModule";

/** What LiveKit gives a track processor when it starts or restarts. */
interface ProcessorOptions {
    kind: "audio";
    track: MediaStreamTrack;
    /** LiveKit's shared context, which also plays the call. Unused: see {@link MicrophoneProcessor.init}. */
    audioContext?: AudioContext;
}

/** Reports the microphone level and whether samples are allowed through, at most twenty times per second. */
export type MicrophoneLevelListener = (levelDb: number, open: boolean) => void;

/** Reports what became of noise suppression for one microphone graph. */
export type DenoiserStatusListener = (status: DenoiserStatus) => void;

/**
 * Applies noise suppression, microphone gain, sensitivity and hold shortcuts on the audio thread. The root
 * follows settings; each outgoing connection gets its own graph, so reconnects and multiple SFUs cannot destroy
 * another sender.
 */
export class MicrophoneProcessor implements ElementCallMicrophoneProcessor {
    public readonly name = "aether-microphone";
    public processedTrack?: MediaStreamTrack;
    public onLevel?: MicrophoneLevelListener;
    public onDenoiserStatus?: DenoiserStatusListener;

    private context?: AudioContext;
    private source?: MediaStreamAudioSourceNode;
    private processor?: AudioWorkletNode;
    private destination?: MediaStreamAudioDestinationNode;
    private pushToTalkActive = false;
    private shortcutMuted = false;
    private generation = 0;
    private readonly children = new Set<MicrophoneProcessor>();

    public constructor(
        private config: MicrophoneGateConfig,
        private readonly onDestroyed?: () => void,
    ) {}

    /** Give a newly captured microphone an independent processor with the current settings and hold state. */
    public createProcessor = (): MicrophoneProcessor => {
        const child = new MicrophoneProcessor(this.config, () => this.children.delete(child));
        child.onDenoiserStatus = (status): void => this.onDenoiserStatus?.(status);
        child.setPushToTalkActive(this.pushToTalkActive);
        child.setShortcutMuted(this.shortcutMuted);
        this.children.add(child);
        return child;
    };

    public setConfig(config: MicrophoneGateConfig): void {
        const wantsDenoiser = !this.wantsDenoiser(this.config) && this.wantsDenoiser(config);
        this.config = config;
        this.sendState();
        // A graph started without noise suppression receives it once it is compiled.
        if (wantsDenoiser && this.processor) void this.sendDenoiser(this.generation);
        for (const child of this.children) child.setConfig(config);
    }

    public setPushToTalkActive(active: boolean): void {
        this.pushToTalkActive = active;
        this.sendState();
        for (const child of this.children) child.setPushToTalkActive(active);
    }

    /** Temporarily silence the microphone without overwriting an explicit mute/deafen preference. */
    public setShortcutMuted(muted: boolean): void {
        this.shortcutMuted = muted;
        this.sendState();
        for (const child of this.children) child.setShortcutMuted(muted);
    }

    private get state(): MicrophoneProcessorState {
        return { config: this.config, pushToTalkActive: this.pushToTalkActive, shortcutMuted: this.shortcutMuted };
    }

    private sendState(): void {
        this.processor?.port.postMessage(this.state);
    }

    private wantsDenoiser(config: MicrophoneGateConfig): boolean {
        return config.noiseSuppression !== undefined && config.noiseSuppression !== null;
    }

    /** Compiles noise suppression, or explains why there is none: the microphone then works without it. */
    private async compileDenoiser(): Promise<WebAssembly.Module | undefined> {
        try {
            return await loadDenoiserModule();
        } catch (error) {
            logger.warn("Could not load noise suppression; the microphone is sent without it", error);
            this.onDenoiserStatus?.("failed");
            return undefined;
        }
    }

    private async sendDenoiser(generation: number): Promise<void> {
        const denoiserModule = await this.compileDenoiser();
        if (denoiserModule && generation === this.generation) this.processor?.port.postMessage({ denoiserModule });
    }

    /**
     * Builds this microphone's graph in a context of its own at the model's sample rate, rather than in LiveKit's
     * shared context: loading and running the model then cannot hold up the audio of everyone else in the call.
     */
    public async init({ track }: ProcessorOptions): Promise<void> {
        const generation = ++this.generation;
        this.closeGraph();
        const context = new AudioContext({ sampleRate: DENOISER_SAMPLE_RATE, latencyHint: "interactive" });
        this.context = context;
        const [denoiserModule] = await Promise.all([
            this.wantsDenoiser(this.config) ? this.compileDenoiser() : undefined,
            loadMicrophoneGateWorklet(context),
        ]).catch((error) => {
            if (generation === this.generation) this.closeGraph();
            throw error;
        });
        if (generation !== this.generation) throw new Error("Microphone processing was cancelled");
        try {
            const processorOptions: MicrophoneGateWorkletOptions = { ...this.state, denoiserModule };
            this.processor = new AudioWorkletNode(context, "aether-microphone-gate", {
                numberOfInputs: 1,
                numberOfOutputs: 1,
                outputChannelCount: [1],
                channelCount: 1,
                channelCountMode: "explicit",
                processorOptions,
            });
            type Report = { level: number; open: boolean } | { denoiser: DenoiserStatus };
            this.processor.port.onmessage = (event: MessageEvent<Report>): void => {
                if (generation !== this.generation) return;
                if ("denoiser" in event.data) this.reportDenoiser(event.data.denoiser);
                else this.onLevel?.(event.data.level, event.data.open);
            };
            this.source = context.createMediaStreamSource(new MediaStream([track]));
            this.destination = context.createMediaStreamDestination();
            this.processedTrack = this.destination.stream.getAudioTracks()[0];
            if (!this.processedTrack) throw new Error("Microphone processing produced no audio track");
            const output = this.processedTrack;
            this.processor.onprocessorerror = (): void => {
                // A crashed worklet must never cause LiveKit to resume the unprocessed microphone.
                output.enabled = false;
                track.enabled = false;
                logger.error("Microphone processing stopped; the microphone has been silenced");
            };
            this.source.connect(this.processor);
            this.processor.connect(this.destination);
            // Electron lets audio start without a gesture, but a context can still begin suspended.
            if (context.state === "suspended") {
                context.resume().catch((error) => logger.warn("Could not start microphone processing", error));
            }
        } catch (error) {
            this.closeGraph();
            throw error;
        }
    }

    private reportDenoiser(status: DenoiserStatus): void {
        if (status === "failed") logger.warn("Noise suppression stopped working; the microphone is sent without it");
        if (status === "overloaded") logger.warn("Noise suppression could not keep up and was turned off");
        this.onDenoiserStatus?.(status);
    }

    public async restart(options: ProcessorOptions): Promise<void> {
        await this.init(options);
    }

    private closeGraph(): void {
        if (this.processor) {
            this.processor.port.onmessage = null;
            this.processor.onprocessorerror = null;
            this.processor.port.postMessage({ stop: true });
            this.processor.port.close();
        }
        this.source?.disconnect();
        this.processor?.disconnect();
        this.processedTrack?.stop();
        this.context?.close().catch((error) => logger.debug("Could not close microphone processing", error));
        this.context = this.source = this.processor = this.destination = this.processedTrack = undefined;
    }

    public async destroy(): Promise<void> {
        ++this.generation;
        this.closeGraph();
        for (const child of this.children) await child.destroy();
        this.children.clear();
        this.onDestroyed?.();
    }
}
