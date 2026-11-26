/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";

import { LEAK_BLOCK, PlaybackLeakSuppressor } from "./PlaybackLeakSuppressor";

const RATE = 48000;
const LEAK_DELAY_MS = 80;

/** A deterministic pseudo-random generator, so that every run hears the same signals. */
function random(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 2 ** 32;
    };
}

/** Music-like playback: noise around `levelDb` whose loudness jumps by up to 10 dB either way every 100 ms. */
function playback(seconds: number, levelDb: number): { signal: Float32Array; loudness: Float32Array } {
    const next = random(7);
    const signal = new Float32Array(seconds * RATE);
    const loudness = new Float32Array(signal.length);
    let gain = 1;
    for (let i = 0; i < signal.length; i++) {
        if (i % (RATE / 10) === 0) gain = 10 ** ((levelDb + (next() * 20 - 10)) / 20);
        loudness[i] = gain;
        signal[i] = gain * (next() * 2 - 1) * Math.sqrt(3);
    }
    return { signal, loudness };
}

/**
 * What a headset leaks of `played` into its microphone: later, duller, about 50 dB down, and growing faster than
 * the playback as the leak measured on a real headset did. A faint noise floor stands in for the muted microphone.
 */
function leakOf(played: { signal: Float32Array; loudness: Float32Array }): Float32Array {
    const delay = (LEAK_DELAY_MS * RATE) / 1000;
    const next = random(11);
    const leak = new Float32Array(played.signal.length);
    let dull = 0;
    for (let i = 0; i < leak.length; i++) {
        const source = i >= delay ? played.signal[i - delay] : 0;
        const loudness = i >= delay ? played.loudness[i - delay] : 0;
        dull += 0.3 * (source - dull);
        const growth = (loudness / 10 ** (-20 / 20)) ** 0.75;
        leak[i] = dull * 10 ** (-50 / 20) * growth + (next() * 2 - 1) * 10 ** (-110 / 20);
    }
    return leak;
}

/** A voice-like sound from `fromSeconds`: a 140 Hz harmonic series spoken in syllables with short pauses. */
function voice(seconds: number, fromSeconds: number, levelDb: number): Float32Array {
    const out = new Float32Array(seconds * RATE);
    for (let i = fromSeconds * RATE; i < out.length; i++) {
        const t = i / RATE;
        const syllable = Math.max(0, Math.sin(2 * Math.PI * 4 * t)) * (t % 0.75 < 0.6 ? 1 : 0);
        let sample = 0;
        for (let h = 1; h <= 8; h++) sample += Math.sin(2 * Math.PI * 140 * h * t) / h;
        out[i] = sample * syllable;
    }
    let energy = 0;
    for (let i = fromSeconds * RATE; i < out.length; i++) energy += out[i] * out[i];
    const scale = 10 ** (levelDb / 20) / Math.sqrt(energy / ((seconds - fromSeconds) * RATE));
    for (let i = 0; i < out.length; i++) out[i] *= scale;
    return out;
}

/**
 * Runs the microphone through a suppressor and returns the output moved back by its one-block lag.
 * @param speech - Whether someone talks in each block, or undefined for no speech detection at all.
 */
function suppress(
    suppressor: PlaybackLeakSuppressor,
    mic: Float32Array,
    reference: Float32Array | undefined,
    speech?: (block: number) => boolean | undefined,
): Float32Array {
    const out = new Float32Array(mic.length);
    for (let i = 0, block = 0; i + LEAK_BLOCK <= mic.length; i += LEAK_BLOCK, block++) {
        suppressor.process(
            mic.subarray(i, i + LEAK_BLOCK),
            reference?.subarray(i, i + LEAK_BLOCK),
            out.subarray(i, i + LEAK_BLOCK),
            speech?.(block),
        );
    }
    return out.subarray(LEAK_BLOCK);
}

/** The loudness of `signal` between two times, in dB relative to full scale. */
function levelBetween(signal: Float32Array, fromSeconds: number, toSeconds: number): number {
    let energy = 0;
    const from = fromSeconds * RATE;
    const to = Math.min(signal.length, toSeconds * RATE);
    for (let i = from; i < to; i++) energy += signal[i] * signal[i];
    return 10 * Math.log10(energy / (to - from) + 1e-30);
}

describe("PlaybackLeakSuppressor", () => {
    it("passes the microphone through, one block later, while nothing plays", () => {
        const mic = voice(1, 0, -30);
        const out = suppress(new PlaybackLeakSuppressor(RATE), mic, undefined);
        let worst = 0;
        for (let i = LEAK_BLOCK; i < out.length - LEAK_BLOCK; i++) worst = Math.max(worst, Math.abs(out[i] - mic[i]));
        expect(worst).toBeLessThan(1e-5);
    });

    it("finds how late the playback reaches the microphone", () => {
        const played = playback(4, -20);
        const suppressor = new PlaybackLeakSuppressor(RATE);
        suppress(suppressor, leakOf(played), played.signal, () => false);
        expect(suppressor.delayMs).not.toBeNull();
        expect(Math.abs(suppressor.delayMs! - LEAK_DELAY_MS)).toBeLessThan(6);
    });

    it("removes a leak that grows faster than the playback while nobody talks", () => {
        const played = playback(8, -20);
        const leak = leakOf(played);
        const out = suppress(new PlaybackLeakSuppressor(RATE), leak, played.signal, () => false);
        expect(levelBetween(out, 6, 8)).toBeLessThan(levelBetween(leak, 6, 8) - 30);
    });

    it("removes the leak without noise suppression telling it when someone talks", () => {
        const played = playback(8, -20);
        const leak = leakOf(played);
        const out = suppress(new PlaybackLeakSuppressor(RATE), leak, played.signal);
        expect(levelBetween(out, 6, 8)).toBeLessThan(levelBetween(leak, 6, 8) - 25);
    });

    it.each([
        ["noise suppression hears the voice", (talking: boolean) => talking],
        ["noise suppression misses the voice", () => false],
        ["there is no noise suppression", () => undefined],
    ])("keeps the voice of someone talking over the playback when %s", (_case, flag) => {
        const played = playback(10, -20);
        const speech = voice(10, 5, -30);
        const mic = leakOf(played).map((sample, i) => sample + speech[i]);
        const out = suppress(new PlaybackLeakSuppressor(RATE), mic, played.signal, (block) =>
            flag((block * LEAK_BLOCK) / RATE >= 5),
        );
        // The leak sits 30 dB under the voice, so the output's level is the voice's.
        expect(Math.abs(levelBetween(out, 6, 10) - levelBetween(speech, 6, 10))).toBeLessThan(1);
        // Once learned, and before anyone talks, the leak is removed.
        expect(levelBetween(out, 4, 5)).toBeLessThan(levelBetween(mic, 4, 5) - 25);
    });

    it("turns nothing down when the playback does not reach the microphone", () => {
        const played = playback(4, -20);
        const speech = voice(4, 0, -40);
        const out = suppress(new PlaybackLeakSuppressor(RATE), speech, played.signal, () => true);
        expect(Math.abs(levelBetween(out, 1, 4) - levelBetween(speech, 1, 4))).toBeLessThan(0.5);
    });
});
