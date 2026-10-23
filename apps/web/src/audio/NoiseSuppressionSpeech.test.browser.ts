/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { expect, it, vi } from "vitest";

import { NoiseSuppressionProcessor } from "./NoiseSuppressionProcessor";

vi.mock("../settings/SettingsStore", () => ({
    default: {
        getValue: (name: string) => {
            if (name === "webrtc_audio_inputVolume") return 100;
            if (name === "webrtc_audio_automaticSensitivity") return false;
            if (name === "webrtc_audio_sensitivity") return -100;
            return true;
        },
        watchSetting: () => "speech-noise-watcher",
        unwatchSetting: () => {},
    },
}));

const sampleRate = 48000;
const recordingSeconds = 7;
// Ignore startup, then compare the same five seconds on every run, including pauses between words.
const windowStart = Math.round(1.5 * sampleRate);
const windowEnd = Math.round(6.5 * sampleRate);

// This worklet only records samples. NoiseSuppressionProcessor loads the actual RNNoise worklet and WASM.
const recorderModule = `
class SpeechRecorder extends AudioWorkletProcessor {
    constructor() {
        super();
        this.channels = Array.from({ length: 3 }, () => new Float32Array(${recordingSeconds * sampleRate}));
        this.position = 0;
    }

    process(inputs, outputs) {
        const length = Math.min(outputs[0][0].length, this.channels[0].length - this.position);
        for (let channel = 0; channel < this.channels.length; channel++) {
            const samples = inputs[channel][0];
            if (samples) this.channels[channel].set(samples.subarray(0, length), this.position);
        }
        this.position += length;
        if (this.position === this.channels[0].length) {
            this.port.postMessage(this.channels, this.channels.map(channel => channel.buffer));
            return false;
        }
        return true;
    }
}
registerProcessor("speech-recorder", SpeechRecorder);
`;

interface SignalMetrics {
    correlation: number;
    gain: number;
    rms: number;
    errorRms: number;
}

function measure(reference: Float32Array, output: Float32Array, lag: number): SignalMetrics {
    let referenceEnergy = 0;
    let outputEnergy = 0;
    let product = 0;
    let errorEnergy = 0;
    for (let i = windowStart; i < windowEnd; i++) {
        const clean = reference[i];
        const processed = output[i + lag];
        referenceEnergy += clean * clean;
        outputEnergy += processed * processed;
        product += clean * processed;
        errorEnergy += (clean - processed) ** 2;
    }
    return {
        correlation: product / Math.sqrt(referenceEnergy * outputEnergy),
        gain: product / referenceEnergy,
        rms: Math.sqrt(outputEnergy / (windowEnd - windowStart)),
        errorRms: Math.sqrt(errorEnergy / (windowEnd - windowStart)),
    };
}

function findLatency(reference: Float32Array, output: Float32Array): number {
    // MediaStream bridges and RNNoise add latency. Align by correlation without changing the measurement window.
    const maxLag = Math.round(0.25 * sampleRate);
    let bestLag = 0;
    let bestCorrelation = -Infinity;
    for (let lag = 0; lag <= maxLag; lag += 4) {
        let product = 0;
        let energy = 0;
        for (let i = windowStart; i < windowEnd; i += 16) {
            const processed = output[i + lag];
            product += reference[i] * processed;
            energy += processed * processed;
        }
        const correlation = product / Math.sqrt(energy);
        if (correlation > bestCorrelation) {
            bestCorrelation = correlation;
            bestLag = lag;
        }
    }

    const coarseLag = bestLag;
    bestCorrelation = -Infinity;
    for (let lag = Math.max(0, coarseLag - 4); lag <= Math.min(maxLag, coarseLag + 4); lag++) {
        const { correlation } = measure(reference, output, lag);
        if (correlation > bestCorrelation) {
            bestCorrelation = correlation;
            bestLag = lag;
        }
    }
    return bestLag;
}

it.each([false, true])(
    "retains audible speech with actual RNNoise (added white noise: %s)",
    async (addNoise) => {
        const context = new AudioContext({ sampleRate });
        const processor = new NoiseSuppressionProcessor();
        const capture = context.createMediaStreamDestination();
        capture.channelCount = 1;
        const input = capture.stream.getAudioTracks()[0];
        const cleanSource = context.createBufferSource();
        const source = context.createBufferSource();
        let recorder: AudioWorkletNode | undefined;
        let output: MediaStreamAudioSourceNode | undefined;
        let started = false;
        const recorderUrl = URL.createObjectURL(new Blob([recorderModule], { type: "text/javascript" }));
        try {
            // speech.wav is synthesized speech generated with eSpeak NG: 9.3 s, mono, 16-bit PCM at 22050 Hz.
            // It contains no microphone recording; Chromium resamples it to RNNoise's required 48 kHz.
            const response = await fetch(new URL("./__fixtures__/speech.wav", import.meta.url));
            expect(response.ok).toBe(true);
            const clean = await context.decodeAudioData(await response.arrayBuffer());
            const speech = clean.getChannelData(0);
            const scale = 0.05 / Math.sqrt(speech.reduce((sum, value) => sum + value * value, 0) / speech.length);
            const mixture = context.createBuffer(1, speech.length, sampleRate);
            const samples = mixture.getChannelData(0);
            let seed = 1;
            for (let i = 0; i < speech.length; i++) {
                speech[i] *= scale;
                seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
                samples[i] = speech[i] + (addNoise ? (seed / 2147483648) * 0.025 : 0);
            }
            cleanSource.buffer = clean;
            source.buffer = mixture;
            source.connect(capture);
            await context.resume();
            await processor.init({ track: input });
            expect(processor.processedTrack).toBeDefined();
            expect(processor.processedTrack).not.toBe(input);

            await context.audioWorklet.addModule(recorderUrl);
            recorder = new AudioWorkletNode(context, "speech-recorder", {
                numberOfInputs: 3,
                numberOfOutputs: 1,
                outputChannelCount: [1],
                channelCount: 1,
                channelCountMode: "explicit",
            });
            const recorded = new Promise<Float32Array[]>((resolve) => {
                recorder!.port.onmessage = (event: MessageEvent<Float32Array[]>) => resolve(event.data);
            });
            cleanSource.connect(recorder, 0, 0);
            source.connect(recorder, 0, 1);
            output = context.createMediaStreamSource(new MediaStream([processor.processedTrack!]));
            output.connect(recorder, 0, 2);
            // The recorder writes only silence to the speaker output, keeping the graph running without playback.
            recorder.connect(context.destination);
            const start = context.currentTime + 0.1;
            cleanSource.start(start);
            source.start(start);
            started = true;

            const [reference, unfiltered, filtered] = await recorded;
            const lag = findLatency(reference, filtered);
            const result = measure(reference, filtered, lag);
            expect(result.rms, "processed speech must remain audible").toBeGreaterThan(0.02);
            expect(result.correlation, "latency-aligned speech correlation").toBeGreaterThan(0.95);
            expect(result.gain, "retained speech gain").toBeGreaterThan(0.85);
            expect(result.gain, "speech must not be excessively amplified").toBeLessThan(1.15);
            const baseline = measure(reference, unfiltered, 0);
            // For the noisy case, require improvement across the whole window so a bypass cannot pass.
            const maximumError = addNoise ? baseline.errorRms * 0.85 : 0.02;
            expect(result.errorRms, "speech error against the clean reference").toBeLessThan(maximumError);
            expect(input.readyState).toBe("live");
        } finally {
            await processor.destroy();
            if (started) {
                cleanSource.stop();
                source.stop();
            }
            cleanSource.disconnect();
            source.disconnect();
            recorder?.disconnect();
            recorder?.port.close();
            output?.disconnect();
            input.stop();
            URL.revokeObjectURL(recorderUrl);
            await context.close();
        }
    },
    20000,
);
