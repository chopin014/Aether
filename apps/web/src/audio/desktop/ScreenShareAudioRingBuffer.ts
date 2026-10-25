/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/** The native screen audio transport and Web Audio graph both run at this rate. */
export const SCREEN_SHARE_AUDIO_SAMPLE_RATE = 48_000;

/** Native packets contain at most twenty milliseconds of interleaved stereo float32 PCM. */
export const SCREEN_SHARE_AUDIO_MAX_PACKET_FRAMES = 960;

/** Keep at most a quarter second queued; newer playback replaces stale audio after a stall. */
export const SCREEN_SHARE_AUDIO_BUFFER_FRAMES = SCREEN_SHARE_AUDIO_SAMPLE_RATE / 4;

const CHANNELS = 2;
const BYTES_PER_SAMPLE = 4;
const BYTES_PER_FRAME = CHANNELS * BYTES_PER_SAMPLE;

/** A bounded interleaved-stereo queue for PCM received from the desktop playback capture. */
export class ScreenShareAudioRingBuffer {
    private readonly samples: Float32Array;
    private readFrame = 0;
    private writeFrame = 0;
    private frameCount = 0;

    /**
     * Creates a queue with a fixed frame capacity.
     * @param capacityFrames Maximum queued stereo frames.
     */
    public constructor(public readonly capacityFrames = SCREEN_SHARE_AUDIO_BUFFER_FRAMES) {
        if (!Number.isSafeInteger(capacityFrames) || capacityFrames < 1) {
            throw new RangeError("Screen audio buffer capacity must be a positive integer");
        }
        this.samples = new Float32Array(capacityFrames * CHANNELS);
    }

    /** Number of stereo frames waiting for the audio thread to render. */
    public get queuedFrames(): number {
        return this.frameCount;
    }

    /** Add little-endian stereo samples, dropping the oldest queued frames if the buffer fills. */
    public push(pcm: Uint8Array): void {
        if (pcm.byteLength % BYTES_PER_FRAME !== 0) {
            throw new Error("Screen audio packet must contain complete stereo frames");
        }

        const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
        const packetFrames = pcm.byteLength / BYTES_PER_FRAME;
        const skippedFrames = Math.max(0, packetFrames - this.capacityFrames);
        const acceptedFrames = packetFrames - skippedFrames;
        const framesToDrop = Math.max(0, this.frameCount + acceptedFrames - this.capacityFrames);

        this.readFrame = (this.readFrame + framesToDrop) % this.capacityFrames;
        this.frameCount -= framesToDrop;

        for (let frame = 0; frame < acceptedFrames; frame++) {
            const sourceFrame = frame + skippedFrames;
            const sourceOffset = sourceFrame * BYTES_PER_FRAME;
            const targetOffset = this.writeFrame * CHANNELS;
            this.samples[targetOffset] = this.sanitize(view.getFloat32(sourceOffset, true));
            this.samples[targetOffset + 1] = this.sanitize(view.getFloat32(sourceOffset + BYTES_PER_SAMPLE, true));
            this.writeFrame = (this.writeFrame + 1) % this.capacityFrames;
        }

        this.frameCount += acceptedFrames;
    }

    /** Fill left/right output channels and write silence for every underrun frame. */
    public readStereo(left: Float32Array, right: Float32Array): void {
        const frameLength = Math.min(left.length, right.length);
        for (let frame = 0; frame < frameLength; frame++) {
            if (this.frameCount === 0) {
                left.fill(0, frame, frameLength);
                right.fill(0, frame, frameLength);
                return;
            }

            const offset = this.readFrame * CHANNELS;
            left[frame] = this.samples[offset];
            right[frame] = this.samples[offset + 1];
            this.readFrame = (this.readFrame + 1) % this.capacityFrames;
            this.frameCount--;
        }
    }

    /** Drop queued playback after the native capture stops. */
    public clear(): void {
        this.readFrame = 0;
        this.writeFrame = 0;
        this.frameCount = 0;
    }

    private sanitize(sample: number): number {
        if (!Number.isFinite(sample)) return 0;
        return Math.max(-1, Math.min(1, sample));
    }
}
