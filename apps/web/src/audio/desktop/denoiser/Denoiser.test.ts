/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

import { attenuationLimitDb, Denoiser, DENOISER_SAMPLE_RATE, type DenoiserExports } from "./Denoiser";

// These tests run the real model, so they exercise the committed build as well as the code around it.
let module: WebAssembly.Module;
let speech: Float32Array;

const RATE = DENOISER_SAMPLE_RATE;

function createDenoiser(attenuationLimit = 100): Denoiser {
    const instance = new WebAssembly.Instance(module, {});
    return new Denoiser(instance.exports as unknown as DenoiserExports, attenuationLimit);
}

/** Reads the 16-bit mono fixture and resamples it linearly to the model's rate. */
function readSpeech(): Float32Array {
    const file = readFileSync(new URL("./__fixtures__/speech.wav", import.meta.url));
    let offset = 12;
    let rate = 0;
    let data: Buffer | undefined;
    while (offset < file.length) {
        const id = file.toString("ascii", offset, offset + 4);
        const size = file.readUInt32LE(offset + 4);
        if (id === "fmt ") rate = file.readUInt32LE(offset + 12);
        if (id === "data") data = file.subarray(offset + 8, offset + 8 + size);
        offset += 8 + size + (size & 1);
    }
    const source = Float32Array.from({ length: data!.length / 2 }, (_, i) => data!.readInt16LE(i * 2) / 32768);
    return Float32Array.from({ length: Math.floor((source.length * RATE) / rate) }, (_, i) => {
        const position = (i * rate) / RATE;
        const index = Math.floor(position);
        const fraction = position - index;
        return (source[index] ?? 0) * (1 - fraction) + (source[index + 1] ?? 0) * fraction;
    });
}

/** Repeatable white noise at the given level in dB relative to full scale. */
function noise(length: number, levelDb: number, seed = 1): Float32Array {
    const amplitude = Math.pow(10, levelDb / 20) * Math.sqrt(3);
    return Float32Array.from({ length }, () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return ((seed / 0x7fffffff) * 2 - 1) * amplitude;
    });
}

function mix(...signals: Float32Array[]): Float32Array {
    return Float32Array.from({ length: signals[0].length }, (_, i) => signals.reduce((sum, s) => sum + s[i], 0));
}

function levelDb(samples: Float32Array): number {
    const power = samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length;
    return 10 * Math.log10(power + 1e-20);
}

/** Runs a signal through in blocks, returning the output and whether speech was detected at each block. */
function run(denoiser: Denoiser, input: Float32Array, blockLength = 128): { output: Float32Array; speech: boolean[] } {
    const output = new Float32Array(input.length);
    const speech: boolean[] = [];
    for (let start = 0; start + blockLength <= input.length; start += blockLength) {
        denoiser.process(input.subarray(start, start + blockLength), output.subarray(start, start + blockLength));
        speech.push(denoiser.speechDetected);
    }
    return { output, speech };
}

beforeAll(async () => {
    module = await WebAssembly.compile(readFileSync(new URL("./aether-denoiser.wasm", import.meta.url)));
    speech = readSpeech();
});

describe("attenuationLimitDb", () => {
    it("removes noise without limit at full strength and keeps some of it below", () => {
        expect(attenuationLimitDb(100)).toBe(100);
        expect(attenuationLimitDb(0)).toBe(6);
        expect(attenuationLimitDb(50)).toBe(28);
        expect(attenuationLimitDb(-5)).toBe(6);
    });
});

// Loading the model takes most of a second, longer when the whole suite shares the machine.
describe("Denoiser", { timeout: 30000 }, () => {
    it("removes steady background noise", () => {
        const input = noise(RATE * 2, -40);
        const { output, speech: detected } = run(createDenoiser(), input);
        const lastSecond = (signal: Float32Array): Float32Array => signal.subarray(RATE);
        expect(levelDb(lastSecond(output))).toBeLessThan(levelDb(lastSecond(input)) - 30);
        expect(detected.some(Boolean)).toBe(false);
    });

    it("only lowers the noise as far as the strength allows", () => {
        const input = noise(RATE * 2, -40);
        const { output } = run(createDenoiser(12), input);
        const reduction = levelDb(input.subarray(RATE)) - levelDb(output.subarray(RATE));
        expect(reduction).toBeGreaterThan(9);
        expect(reduction).toBeLessThan(15);
    });

    it("keeps speech and recognises it under noise", () => {
        const input = mix(speech, noise(speech.length, -40));
        const { output, speech: detected } = run(createDenoiser(), input);
        // The output trails the input by the model's look-ahead and one frame of buffering.
        // The synthetic voice loses a little level, as speech under suppression does; noise would add, not remove.
        const delay = 0.04 * RATE;
        expect(levelDb(output.subarray(delay))).toBeGreaterThan(levelDb(speech) - 5);
        const duringSpeech = detected.filter(
            (_, block) => levelDb(speech.subarray(block * 128, block * 128 + 128)) > levelDb(speech) - 6,
        );
        expect(duringSpeech.filter(Boolean).length / duringSpeech.length).toBeGreaterThan(0.9);
    });

    it("removes claps and does not take them for speech", () => {
        // Sharp bursts of noise that decay within a few milliseconds, two a second, over a quiet room.
        const claps = new Float32Array(RATE * 3);
        const burst = noise(RATE * 0.05, -6, 7);
        for (let start = RATE / 4; start + burst.length < claps.length; start += RATE / 2) {
            for (let i = 0; i < burst.length; i++) claps[start + i] = burst[i] * Math.exp(-i / (RATE * 0.008));
        }
        const input = mix(claps, noise(claps.length, -60));
        const { output, speech: detected } = run(createDenoiser(), input);
        expect(detected.some(Boolean)).toBe(false);
        expect(levelDb(output)).toBeLessThan(levelDb(input) - 30);
    });

    it("produces the same audio whatever block length the audio thread uses", () => {
        const input = mix(speech.subarray(0, RATE), noise(RATE, -40));
        const length = 128 * 3 * 100;
        const a = run(createDenoiser(), input.subarray(0, length), 128).output;
        const b = run(createDenoiser(), input.subarray(0, length), 384).output;
        let largestDifference = 0;
        for (let i = 0; i < length; i++) largestDifference = Math.max(largestDifference, Math.abs(a[i] - b[i]));
        expect(largestDifference).toBeLessThan(1e-6);
    });

    it("is silent for silence", () => {
        const denoiser = createDenoiser();
        const { output, speech: detected } = run(denoiser, new Float32Array(RATE / 2));
        expect(output.every((sample) => sample === 0)).toBe(true);
        expect(detected.some(Boolean)).toBe(false);
        expect(denoiser.speechSnrDb).toBeLessThan(-10);
    });
});
