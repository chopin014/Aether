/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type MicrophoneGateWorkletOptions } from "./MicrophoneProcessorState";
import { DENOISER_SAMPLE_RATE } from "./denoiser/Denoiser";
import { type DenoiserStatus } from "./denoiser/DenoiserStatus";
import { loadDenoiserModule } from "./denoiser/loadDenoiserModule";
import { loadMicrophoneGateWorklet } from "./microphoneGateWorkletFactory";

/** A fresh, disconnected microphone processor. Preparation never requests microphone access. */
export class PreparedMicrophoneGraph {
    public readonly context = new AudioContext({ sampleRate: DENOISER_SAMPLE_RATE, latencyHint: "interactive" });
    public processor?: AudioWorkletNode;
    public denoiserStatus?: DenoiserStatus;
    private closed = false;
    private cancelReady?: () => void;

    /** Load the worklet and model before capture starts, then keep their audio thread suspended. */
    public async initialize(options: MicrophoneGateWorkletOptions): Promise<void> {
        try {
            const wantsDenoiser = options.config.noiseSuppression != null;
            const [denoiserModule] = await Promise.all([
                wantsDenoiser ? loadDenoiserModule().catch(() => undefined) : undefined,
                loadMicrophoneGateWorklet(this.context),
            ]);
            if (this.closed) throw new Error("Microphone preparation was cancelled");
            if (wantsDenoiser && !denoiserModule) this.denoiserStatus = "failed";
            const processor = (this.processor = new AudioWorkletNode(this.context, "aether-microphone-gate", {
                numberOfInputs: 1,
                numberOfOutputs: 1,
                outputChannelCount: [1],
                channelCount: 1,
                channelCountMode: "explicit",
                // A claimed graph stays silent until its current mute/PTT state reaches the worklet.
                processorOptions: { ...options, shortcutMuted: true, denoiserModule },
            }));
            await new Promise<void>((resolve, reject) => {
                const fail = (message: string): void => {
                    clearTimeout(timer);
                    reject(new Error(message));
                };
                const timer = setTimeout(() => fail("Microphone preparation timed out"), 10000);
                this.cancelReady = () => fail("Microphone preparation was cancelled");
                processor.onprocessorerror = (): void => {
                    clearTimeout(timer);
                    this.close();
                    reject(new Error("Microphone preparation failed"));
                };
                processor.port.onmessage = (
                    event: MessageEvent<{ ready?: boolean; denoiser?: DenoiserStatus }>,
                ): void => {
                    if (event.data.denoiser) this.denoiserStatus = event.data.denoiser;
                    if (event.data.ready) {
                        clearTimeout(timer);
                        resolve();
                    }
                };
            });
            this.cancelReady = undefined;
            if (this.closed) throw new Error("Microphone preparation was cancelled");
            await this.context.suspend();
        } catch (error) {
            this.close();
            throw error;
        }
    }

    /** Release unused resources, including preparation that is still in progress. */
    public close(): void {
        if (this.closed) return;
        this.closed = true;
        this.cancelReady?.();
        this.cancelReady = undefined;
        this.processor?.disconnect();
        this.processor?.port.close();
        void this.context.close().catch(() => {});
    }
}
