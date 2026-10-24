/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { MicrophoneGate } from "./MicrophoneGate";
import { type MicrophoneProcessorState } from "./MicrophoneProcessorState";

declare const sampleRate: number;

class MicrophoneGateWorklet extends AudioWorkletProcessor {
    private readonly gate = new MicrophoneGate(sampleRate);
    private stopped = false;
    private framesSinceReport = 0;

    public constructor(options: AudioWorkletNodeOptions = {}) {
        super();
        this.applyState(options.processorOptions as MicrophoneProcessorState);
        this.port.onmessage = (event: MessageEvent<MicrophoneProcessorState | { stop: true }>): void => {
            if ("stop" in event.data) this.stopped = true;
            else this.applyState(event.data);
        };
    }

    private applyState(state: MicrophoneProcessorState): void {
        this.gate.configure(state.config);
        this.gate.setPushToTalkActive(state.pushToTalkActive);
        this.gate.setShortcutMuted(state.shortcutMuted);
    }

    public process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
        const output = outputs[0]?.[0];
        if (!output) return !this.stopped;
        if (this.stopped) {
            output.fill(0);
            return false;
        }
        const input = inputs[0]?.[0];
        if (input) this.gate.processBlock(input, output);
        else output.fill(0);
        this.framesSinceReport += output.length;
        if (this.framesSinceReport >= sampleRate / 20) {
            this.framesSinceReport = 0;
            this.port.postMessage({ level: this.gate.level, open: this.gate.open });
        }
        return true;
    }
}

registerProcessor("aether-microphone-gate", MicrophoneGateWorklet);

/** Webpack's worklet loader replaces this export with the emitted module URL. */
export const microphoneGateWorkletUrl = "";
