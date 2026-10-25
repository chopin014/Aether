/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const FRAMES_PER_CHUNK = 480;
const RING_CAPACITY_FRAMES = 4_800;
const CHUNK_INTERVAL_NS = (BigInt(FRAMES_PER_CHUNK) * 1_000_000_000n) / BigInt(SAMPLE_RATE);
const MAX_CATCH_UP_CHUNKS = 3;

interface LinuxPcmMixerClock {
    nowNs: () => bigint;
    setTimeout: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
}

const systemClock: LinuxPcmMixerClock = {
    nowNs: () => process.hrtime.bigint(),
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (timer) => clearTimeout(timer),
};

class LinuxPcmRingBuffer {
    private readonly left = new Float32Array(RING_CAPACITY_FRAMES);
    private readonly right = new Float32Array(RING_CAPACITY_FRAMES);
    private head = 0;
    private size = 0;
    private pending = Buffer.alloc(0);

    public write(input: Buffer): void {
        const data = this.pending.length === 0 ? input : Buffer.concat([this.pending, input]);
        const frameBytes = CHANNELS * Float32Array.BYTES_PER_ELEMENT;
        const completeLength = data.length - (data.length % frameBytes);
        this.pending = completeLength === data.length ? Buffer.alloc(0) : Buffer.from(data.subarray(completeLength));

        for (let offset = 0; offset < completeLength; offset += frameBytes) {
            if (this.size === RING_CAPACITY_FRAMES) {
                this.head = (this.head + 1) % RING_CAPACITY_FRAMES;
                this.size--;
            }
            const tail = (this.head + this.size) % RING_CAPACITY_FRAMES;
            const left = data.readFloatLE(offset);
            const right = data.readFloatLE(offset + Float32Array.BYTES_PER_ELEMENT);
            this.left[tail] = Number.isFinite(left) ? left : 0;
            this.right[tail] = Number.isFinite(right) ? right : 0;
            this.size++;
        }
    }

    public mixInto(output: Float32Array): void {
        const frames = Math.min(this.size, FRAMES_PER_CHUNK);
        for (let frame = 0; frame < frames; frame++) {
            const sourceIndex = (this.head + frame) % RING_CAPACITY_FRAMES;
            const targetIndex = frame * CHANNELS;
            output[targetIndex] += this.left[sourceIndex];
            output[targetIndex + 1] += this.right[sourceIndex];
        }
        this.head = (this.head + frames) % RING_CAPACITY_FRAMES;
        this.size -= frames;
    }
}

/** Bounded software mixer for per-stream PulseAudio monitor captures. */
export class LinuxPcmMixer {
    private readonly onData: (pcm: Buffer) => void;
    private readonly clock: LinuxPcmMixerClock;
    private readonly sources = new Map<string, LinuxPcmRingBuffer>();
    private timer: NodeJS.Timeout | null = null;
    private nextDeadlineNs: bigint | null = null;
    private running = false;

    public constructor(onData: (pcm: Buffer) => void, clock: LinuxPcmMixerClock = systemClock) {
        this.onData = onData;
        this.clock = clock;
    }

    /** Adds a stream to the mix. Each stream keeps at most 100 ms of PCM. */
    public addSource(key: string): void {
        if (!this.sources.has(key)) this.sources.set(key, new LinuxPcmRingBuffer());
    }

    /** Appends one capture chunk, dropping oldest samples if a source falls behind. */
    public write(key: string, pcm: Buffer): void {
        this.sources.get(key)?.write(pcm);
    }

    /** Removes a stream and releases its bounded PCM queue. */
    public removeSource(key: string): void {
        this.sources.delete(key);
    }

    /** Starts emitting fixed-size 48 kHz stereo float32le chunks. */
    public start(): void {
        if (this.running) return;
        this.running = true;
        this.nextDeadlineNs = this.clock.nowNs() + CHUNK_INTERVAL_NS;
        this.scheduleNextChunk();
    }

    /** Stops the mixer and releases every per-stream queue. */
    public stop(): void {
        this.running = false;
        if (this.timer) this.clock.clearTimeout(this.timer);
        this.timer = null;
        this.nextDeadlineNs = null;
        this.sources.clear();
    }

    private scheduleNextChunk(): void {
        if (!this.running || this.nextDeadlineNs === null) return;
        const remainingNs = this.nextDeadlineNs - this.clock.nowNs();
        const delayMs = Math.max(0, Math.ceil(Number(remainingNs) / 1_000_000));
        this.timer = this.clock.setTimeout(() => this.emitDueChunks(), delayMs);
        this.timer.unref();
    }

    private emitDueChunks(): void {
        this.timer = null;
        const deadlineNs = this.nextDeadlineNs;
        if (!this.running || deadlineNs === null) return;

        const nowNs = this.clock.nowNs();
        if (nowNs < deadlineNs) {
            this.scheduleNextChunk();
            return;
        }

        const dueChunks = Number((nowNs - deadlineNs) / CHUNK_INTERVAL_NS) + 1;
        const chunksToEmit = Math.min(dueChunks, MAX_CATCH_UP_CHUNKS);
        for (let chunk = 0; chunk < chunksToEmit && this.running; chunk++) this.emitChunk();
        if (!this.running) return;

        // Keep absolute deadlines through short delays. After a long stall, rebase instead of emitting an unbounded
        // burst that would add stale audio to the downstream ring.
        this.nextDeadlineNs =
            dueChunks > MAX_CATCH_UP_CHUNKS
                ? nowNs + CHUNK_INTERVAL_NS
                : deadlineNs + BigInt(dueChunks) * CHUNK_INTERVAL_NS;
        this.scheduleNextChunk();
    }

    private emitChunk(): void {
        const mixed = new Float32Array(FRAMES_PER_CHUNK * CHANNELS);
        for (const source of this.sources.values()) source.mixInto(mixed);

        const pcm = Buffer.allocUnsafe(mixed.length * Float32Array.BYTES_PER_ELEMENT);
        for (let i = 0; i < mixed.length; i++) {
            const sample = Math.max(-1, Math.min(1, mixed[i]));
            pcm.writeFloatLE(sample, i * Float32Array.BYTES_PER_ELEMENT);
        }
        this.onData(pcm);
    }
}
