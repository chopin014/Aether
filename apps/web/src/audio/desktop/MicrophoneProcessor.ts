/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { logger } from "matrix-js-sdk/src/logger";
import { type ElementCallMicrophoneProcessor } from "@element-hq/element-call-component/api";

import { MicrophoneGate, type MicrophoneGateConfig } from "./MicrophoneGate";

/** What LiveKit gives a track processor when it starts or restarts. */
interface ProcessorOptions {
    kind: "audio";
    track: MediaStreamTrack;
    audioContext: AudioContext;
}

/** Called once per block with its loudness and whether the gate let it through. */
export type MicrophoneLevelListener = (levelDb: number, open: boolean) => void;

/**
 * Runs a microphone track through a {@link MicrophoneGate}: the volume, the sensitivity threshold and push to
 * talk. It is used both as Element Call's microphone processor and by the settings' microphone test, so the
 * test sounds and measures what a call would send.
 *
 * The gate runs inside a script processor rather than on a timer, so that it keeps pace with the audio when
 * the window is in the background. The node is deprecated but still supported by Chromium, and the only
 * option that gives the gate the samples without a worklet module.
 */
export class MicrophoneProcessor implements ElementCallMicrophoneProcessor {
    public readonly name = "aether-microphone";
    public processedTrack?: MediaStreamTrack;
    public onLevel?: MicrophoneLevelListener;

    private gate?: MicrophoneGate;
    private source?: MediaStreamAudioSourceNode;
    private processor?: ScriptProcessorNode;
    private destination?: MediaStreamAudioDestinationNode;
    private pushToTalkActive = false;

    public constructor(private config: MicrophoneGateConfig) {}

    public setConfig(config: MicrophoneGateConfig): void {
        this.config = config;
        this.gate?.configure(config);
    }

    public setPushToTalkActive(active: boolean): void {
        this.pushToTalkActive = active;
        this.gate?.setPushToTalkActive(active);
    }

    public async init({ track, audioContext }: ProcessorOptions): Promise<void> {
        await this.destroy();
        const gate = new MicrophoneGate(audioContext.sampleRate);
        gate.configure(this.config);
        gate.setPushToTalkActive(this.pushToTalkActive);
        this.gate = gate;

        this.source = audioContext.createMediaStreamSource(new MediaStream([track]));
        this.processor = audioContext.createScriptProcessor(512, 1, 1);
        this.destination = audioContext.createMediaStreamDestination();
        this.processor.onaudioprocess = (event): void => {
            const input = event.inputBuffer.getChannelData(0);
            gate.processBlock(input, event.outputBuffer.getChannelData(0));
            this.onLevel?.(gate.level, gate.open);
        };
        this.source.connect(this.processor);
        this.processor.connect(this.destination);
        this.processedTrack = this.destination.stream.getAudioTracks()[0];
    }

    public async restart(options: ProcessorOptions): Promise<void> {
        await this.init(options);
    }

    public async destroy(): Promise<void> {
        if (this.processor) this.processor.onaudioprocess = null;
        try {
            this.source?.disconnect();
            this.processor?.disconnect();
        } catch (error) {
            logger.debug("Could not disconnect the microphone processor", error);
        }
        this.processedTrack?.stop();
        this.source = this.processor = this.destination = this.gate = this.processedTrack = undefined;
    }
}
