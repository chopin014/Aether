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
    public readonly context: AudioContext;
    /** Whether the graph was built in a context that is already open, as a call that ended leaves one. */
    private readonly reused: boolean;
    public processor?: AudioWorkletNode;
    public denoiserStatus?: DenoiserStatus;
    private closed = false;
    private cancelReady?: () => void;

    /** @param context - An open context to build in, such as the last call's; otherwise one is created. */
    public constructor(context?: AudioContext) {
        this.context = context ?? new AudioContext({ sampleRate: DENOISER_SAMPLE_RATE, latencyHint: "interactive" });
        this.reused = context !== undefined;
    }

    /**
     * Keeps the graph of a call that ended for the next call. It is already built and running, so the next call builds
     * nothing on the audio thread. Building a graph holds up every sound the page plays while a microphone is open,
     * so a rejoin's join cue (or the leave cue, had the next graph been built then) broke up.
     *
     * @param context - The call's context, still open.
     * @param processor - The call's processor, disconnected from its microphone and output.
     * @param denoiserStatus - What became of noise suppression in that processor, if it reported anything.
     */
    public static fromCall(
        context: AudioContext,
        processor: AudioWorkletNode,
        denoiserStatus?: DenoiserStatus,
    ): PreparedMicrophoneGraph {
        const graph = new PreparedMicrophoneGraph(context);
        graph.processor = processor;
        graph.denoiserStatus = denoiserStatus;
        processor.onprocessorerror = (): void => graph.close();
        return graph;
    }

    /** Whether a call can still take this graph: it was neither closed nor broke. */
    public get usable(): boolean {
        return !this.closed && this.processor !== undefined && this.context.state !== "closed";
    }

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
            // A reused context keeps running: suspending it would close its output stream, which is what reusing it
            // avoids (see MicrophoneProcessor's SPARE_CONTEXT_MS).
            if (!this.reused) await this.context.suspend();
        } catch (error) {
            this.close();
            throw error;
        }
    }

    /** Release unused resources, including preparation that is still in progress. */
    public close(): void {
        // A released graph's context belongs to whoever took it.
        if (this.closed) return;
        this.release();
        void this.context.close().catch(() => {});
    }

    /**
     * Lets go of the processor but leaves the context open, for another graph to be built in.
     *
     * @returns The context.
     */
    public release(): AudioContext {
        if (this.closed) return this.context;
        this.closed = true;
        this.cancelReady?.();
        this.cancelReady = undefined;
        if (this.processor) {
            this.processor.onprocessorerror = null;
            this.processor.port.postMessage({ stop: true });
            this.processor.disconnect();
            this.processor.port.close();
        }
        return this.context;
    }
}
