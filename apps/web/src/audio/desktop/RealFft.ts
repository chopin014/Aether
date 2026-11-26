/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/**
 * A fast Fourier transform of real signals with a fixed power-of-two length, allocation free after construction so it
 * can run on the audio thread.
 */
export class RealFft {
    /** How many spectrum values {@link forward} fills: the bins from 0 Hz up to half the sample rate. */
    public readonly bins: number;
    private readonly re: Float64Array;
    private readonly im: Float64Array;
    private readonly cos: Float64Array;
    private readonly sin: Float64Array;
    private readonly reversed: Uint32Array;

    /** @param size - The number of samples transformed at once, a power of two of at least 2. */
    public constructor(private readonly size: number) {
        if (size < 2 || (size & (size - 1)) !== 0) throw new Error("The transform size must be a power of two");
        this.bins = size / 2 + 1;
        this.re = new Float64Array(size);
        this.im = new Float64Array(size);
        this.cos = new Float64Array(size / 2);
        this.sin = new Float64Array(size / 2);
        for (let k = 0; k < size / 2; k++) {
            this.cos[k] = Math.cos((2 * Math.PI * k) / size);
            this.sin[k] = Math.sin((2 * Math.PI * k) / size);
        }
        this.reversed = new Uint32Array(size);
        const bits = Math.log2(size);
        for (let i = 0; i < size; i++) {
            let r = 0;
            for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
            this.reversed[i] = r;
        }
    }

    /**
     * Transforms `input` (length `size`) into `re` and `im` (length {@link bins}).
     */
    public forward(input: Float32Array, re: Float32Array, im: Float32Array): void {
        for (let i = 0; i < this.size; i++) {
            this.re[this.reversed[i]] = input[i];
            this.im[this.reversed[i]] = 0;
        }
        this.transform(-1);
        for (let k = 0; k < this.bins; k++) {
            re[k] = this.re[k];
            im[k] = this.im[k];
        }
    }

    /**
     * Turns a spectrum from {@link forward} back into `output` (length `size`), so that inverse(forward(x)) is x.
     */
    public inverse(re: Float32Array, im: Float32Array, output: Float32Array): void {
        const n = this.size;
        for (let k = 0; k < this.bins; k++) {
            this.re[this.reversed[k]] = re[k];
            this.im[this.reversed[k]] = im[k];
        }
        // A real signal's spectrum mirrors itself, so the upper half is the conjugate of the lower one.
        for (let k = this.bins; k < n; k++) {
            this.re[this.reversed[k]] = re[n - k];
            this.im[this.reversed[k]] = -im[n - k];
        }
        this.transform(1);
        for (let i = 0; i < n; i++) output[i] = this.re[i] / n;
    }

    /** An in-place iterative radix-2 transform of the bit-reversed buffers; `sign` -1 is forward, 1 inverse. */
    private transform(sign: number): void {
        const n = this.size;
        for (let length = 2; length <= n; length <<= 1) {
            const half = length >> 1;
            const step = n / length;
            for (let start = 0; start < n; start += length) {
                for (let j = 0; j < half; j++) {
                    const wr = this.cos[j * step];
                    const wi = sign * this.sin[j * step];
                    const a = start + j;
                    const b = a + half;
                    const tr = this.re[b] * wr - this.im[b] * wi;
                    const ti = this.re[b] * wi + this.im[b] * wr;
                    this.re[b] = this.re[a] - tr;
                    this.im[b] = this.im[a] - ti;
                    this.re[a] += tr;
                    this.im[a] += ti;
                }
            }
        }
    }
}
