/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { logger } from "matrix-js-sdk/src/logger";
import { type ElementCallMicrophoneProcessor } from "@element-hq/element-call-component/api";

import { type MicrophoneGateConfig } from "./MicrophoneGate";
import { type MicrophoneProcessorState } from "./MicrophoneProcessorState";
import { loadMicrophoneGateWorklet } from "./microphoneGateWorkletFactory";

/** What LiveKit gives a track processor when it starts or restarts. */
interface ProcessorOptions {
    kind: "audio";
    track: MediaStreamTrack;
    audioContext: AudioContext;
}

/** Reports the microphone level and whether samples are allowed through, at most twenty times per second. */
export type MicrophoneLevelListener = (levelDb: number, open: boolean) => void;

/**
 * Applies microphone gain, sensitivity and hold shortcuts on the audio thread. The root follows settings;
 * each outgoing connection gets its own graph, so reconnects and multiple SFUs cannot destroy another sender.
 */
export class MicrophoneProcessor implements ElementCallMicrophoneProcessor {
    public readonly name = "aether-microphone";
    public processedTrack?: MediaStreamTrack;
    public onLevel?: MicrophoneLevelListener;

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
        child.setPushToTalkActive(this.pushToTalkActive);
        child.setShortcutMuted(this.shortcutMuted);
        this.children.add(child);
        return child;
    };

    public setConfig(config: MicrophoneGateConfig): void {
        this.config = config;
        this.sendState();
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

    public async init({ track, audioContext }: ProcessorOptions): Promise<void> {
        const generation = ++this.generation;
        this.closeGraph();
        await loadMicrophoneGateWorklet(audioContext);
        if (generation !== this.generation) throw new Error("Microphone processing was cancelled");
        try {
            this.processor = new AudioWorkletNode(audioContext, "aether-microphone-gate", {
                numberOfInputs: 1,
                numberOfOutputs: 1,
                outputChannelCount: [1],
                channelCount: 1,
                channelCountMode: "explicit",
                processorOptions: this.state,
            });
            this.processor.port.onmessage = (event: MessageEvent<{ level: number; open: boolean }>): void => {
                if (generation === this.generation) this.onLevel?.(event.data.level, event.data.open);
            };
            this.source = audioContext.createMediaStreamSource(new MediaStream([track]));
            this.destination = audioContext.createMediaStreamDestination();
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
        } catch (error) {
            this.closeGraph();
            throw error;
        }
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
        this.source = this.processor = this.destination = this.processedTrack = undefined;
    }

    public async destroy(): Promise<void> {
        ++this.generation;
        this.closeGraph();
        for (const child of this.children) await child.destroy();
        this.children.clear();
        this.onDestroyed?.();
    }
}
