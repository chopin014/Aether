/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/** Removes subsonic drift from the denoiser output with a second-order 20 Hz Butterworth high-pass filter. */
export class RumbleFilter {
    private readonly b0: number;
    private readonly b1: number;
    private readonly b2: number;
    private readonly a1: number;
    private readonly a2: number;
    private first = 0;
    private second = 0;

    public constructor(sampleRate: number) {
        const angle = (2 * Math.PI * 20) / sampleRate;
        const cosine = Math.cos(angle);
        const alpha = Math.sin(angle) / Math.SQRT2;
        const denominator = 1 + alpha;
        this.b0 = (1 + cosine) / (2 * denominator);
        this.b1 = -(1 + cosine) / denominator;
        this.b2 = this.b0;
        this.a1 = (-2 * cosine) / denominator;
        this.a2 = (1 - alpha) / denominator;
    }

    /** Filters one sample, retaining state across render blocks without changing the neural model's input. */
    public processSample(input: number): number {
        // Keep double-precision state: this low cutoff puts the poles close to one.
        const output = this.b0 * input + this.first;
        this.first = this.b1 * input - this.a1 * output + this.second;
        this.second = this.b2 * input - this.a2 * output;
        return output;
    }
}
