/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type MatrixClient } from "matrix-js-sdk/src/matrix";

/** Locally decoded audio for waveform preview and a bounded soundboard export. */
export class SoundboardClip {
    private source?: AudioBufferSourceNode;
    private gain?: GainNode;
    private previewGeneration = 0;
    private timer?: ReturnType<typeof setInterval>;

    private constructor(
        private readonly context: AudioContext,
        private readonly buffer: AudioBuffer,
        public readonly name: string,
    ) {}

    /** Decode a local source; nothing is sent to the homeserver at this stage. */
    public static async load(file: File): Promise<SoundboardClip> {
        if (!file.size || file.size > 20 * 1024 * 1024) throw new Error("source size");
        const context = new AudioContext();
        try {
            const buffer = await context.decodeAudioData(await file.arrayBuffer());
            if (!Number.isFinite(buffer.duration) || buffer.duration <= 0 || buffer.duration > 600)
                throw new Error("source duration");
            return new SoundboardClip(context, buffer, file.name);
        } catch (error) {
            await context.close();
            throw error;
        }
    }

    /** Load existing library audio using the same authenticated media endpoint as playback. */
    public static async loadStored(
        client: MatrixClient,
        url: string,
        name: string,
        signal: AbortSignal,
    ): Promise<SoundboardClip> {
        // Authenticated media URLs are required; public legacy URLs cannot read private homeserver media.
        // oxlint-disable-next-line no-restricted-properties
        const download = client.mxcUrlToHttp(url, undefined, undefined, undefined, false, false, true);
        if (!download) throw new Error("media");
        const response = await fetch(download, {
            headers: { Authorization: `Bearer ${client.getAccessToken()}` },
            signal,
        });
        if (!response.ok || !response.body) throw new Error("media");
        const reader = response.body.getReader();
        const chunks: Uint8Array<ArrayBuffer>[] = [];
        let size = 0;
        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                size += value.byteLength;
                if (size > 512_000) throw new Error("size");
                chunks.push(new Uint8Array(value));
            }
        } finally {
            await reader.cancel();
        }
        return this.load(new File(chunks, name, { type: response.headers.get("content-type") ?? "audio/wav" }));
    }

    public get duration(): number {
        return this.buffer.duration;
    }

    /** Peak envelope of the complete source, with quiet sections left visible. */
    public waveform(bars = 100): number[] {
        const channel = this.buffer.getChannelData(0);
        const peaks = Array.from({ length: bars }, (_, bar) => {
            const start = Math.floor((bar * channel.length) / bars);
            const end = Math.floor(((bar + 1) * channel.length) / bars);
            let peak = 0;
            for (let i = start; i < end; i++) peak = Math.max(peak, Math.abs(channel[i]));
            return peak;
        });
        const max = Math.max(...peaks, 0.01);
        return peaks.map((peak) => Math.max(0.03, peak / max));
    }

    /** Listen only to the selection, reporting a playhead until it ends. */
    public async preview(
        start: number,
        end: number,
        update: (position: number, playing: boolean) => void,
        volume = 100,
    ): Promise<void> {
        this.stop();
        const generation = this.previewGeneration;
        await this.context.resume();
        if (generation !== this.previewGeneration) return;
        const source = this.context.createBufferSource();
        source.buffer = this.buffer;
        const gain = (this.gain = this.context.createGain());
        gain.gain.value = volume / 100;
        source.connect(gain);
        gain.connect(this.context.destination);
        const began = this.context.currentTime;
        source.onended = () => {
            if (this.source !== source) return;
            this.stop();
            update(start, false);
        };
        this.source = source;
        source.start(0, start, end - start);
        update(start, true);
        this.timer = setInterval(() => update(Math.min(end, start + this.context.currentTime - began), true), 50);
    }

    /** Stop preview before changing the selection or closing the editor. */
    public stop(): void {
        this.previewGeneration++;
        this.gain?.disconnect();
        this.gain = undefined;
        clearInterval(this.timer);
        this.timer = undefined;
        if (this.source) {
            this.source.onended = null;
            this.source.stop();
            this.source.disconnect();
            this.source = undefined;
        }
    }

    /** Export at most ten seconds as 24 kHz mono PCM, always below the 512 KB library limit. */
    public export(start: number, end: number, volume = 100): File {
        if (
            !Number.isFinite(volume) ||
            volume < 0 ||
            volume > 100 ||
            !Number.isFinite(start) ||
            !Number.isFinite(end) ||
            start < 0 ||
            end > this.duration ||
            end <= start ||
            end - start > 10.000001
        )
            throw new Error("selection");
        const rate = 24_000;
        const length = Math.min(10 * rate, Math.floor((end - start) * rate));
        const data = new ArrayBuffer(44 + length * 2);
        const view = new DataView(data);
        const text = (offset: number, value: string): void => {
            for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
        };
        text(0, "RIFF");
        view.setUint32(4, data.byteLength - 8, true);
        text(8, "WAVEfmt ");
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, 1, true);
        view.setUint32(24, rate, true);
        view.setUint32(28, rate * 2, true);
        view.setUint16(32, 2, true);
        view.setUint16(34, 16, true);
        text(36, "data");
        view.setUint32(40, length * 2, true);
        const channels = Array.from({ length: this.buffer.numberOfChannels }, (_, i) => this.buffer.getChannelData(i));
        for (let i = 0; i < length; i++) {
            const position = (start + i / rate) * this.buffer.sampleRate;
            const index = Math.floor(position);
            const fraction = position - index;
            let sample = 0;
            for (const channel of channels) {
                const a = channel[Math.min(index, channel.length - 1)];
                const b = channel[Math.min(index + 1, channel.length - 1)];
                sample += (a + (b - a) * fraction) / channels.length;
            }
            sample = Math.max(-1, Math.min(1, (sample * volume) / 100));
            view.setInt16(44 + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
        }
        return new File([data], this.name.replace(/\.[^.]+$/, "") + ".wav", { type: "audio/wav" });
    }

    /** Release decoded audio and the preview output. */
    public dispose(): void {
        this.stop();
        void this.context.close();
    }
}
