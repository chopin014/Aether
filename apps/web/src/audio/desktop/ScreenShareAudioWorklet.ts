/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { ScreenShareAudioRingBuffer } from "./ScreenShareAudioRingBuffer";

type WorkletMessage = { type: "pcm"; sequence: number; pcm: ArrayBuffer } | { type: "stop" };

/** Moves native playback packets from the renderer to the output track without blocking the UI thread. */
class ScreenShareAudioWorklet extends AudioWorkletProcessor {
    private readonly ring = new ScreenShareAudioRingBuffer();
    private stopped = false;

    public constructor() {
        super();
        this.port.onmessage = (event: MessageEvent<WorkletMessage>): void => {
            if (event.data.type === "stop") {
                this.stopped = true;
                this.ring.clear();
                return;
            }

            if (this.stopped) return;
            try {
                this.ring.push(new Uint8Array(event.data.pcm));
            } catch {
                // Ignore malformed packets; native transport validation reports errors before this boundary.
            } finally {
                this.port.postMessage({ type: "received", sequence: event.data.sequence });
            }
        };
    }

    public process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
        const output = outputs[0];
        const left = output?.[0];
        const right = output?.[1];
        if (!left || !right) {
            for (const channel of output ?? []) channel.fill(0);
            return !this.stopped;
        }

        if (this.stopped) {
            left.fill(0);
            right.fill(0);
            return false;
        }

        this.ring.readStereo(left, right);
        return true;
    }
}

registerProcessor("aether-screen-share-audio", ScreenShareAudioWorklet);

/** Webpack's worklet loader replaces this export with the emitted module URL. */
export const screenShareAudioWorkletUrl = "";
