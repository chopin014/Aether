/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { beforeEach, expect, it, vi } from "vitest";

import { NoiseSuppressionProcessor } from "./NoiseSuppressionProcessor";

const settings = vi.hoisted(() => ({
    enabled: false,
    inputVolume: 100,
    automaticSensitivity: false,
    sensitivity: -100,
    watchers: new Map<string, () => void>(),
}));
vi.mock("../settings/SettingsStore", () => ({
    default: {
        getValue: (name: string) => {
            switch (name) {
                case "webrtc_audio_noiseSuppression":
                    return settings.enabled;
                case "webrtc_audio_inputVolume":
                    return settings.inputVolume;
                case "webrtc_audio_automaticSensitivity":
                    return settings.automaticSensitivity;
                case "webrtc_audio_sensitivity":
                    return settings.sensitivity;
            }
        },
        watchSetting: (name: string, _room: null, changed: () => void) => {
            settings.watchers.set(name, changed);
            return name;
        },
        unwatchSetting: (name: string) => settings.watchers.delete(name),
    },
}));

function updateSettings(): void {
    for (const changed of settings.watchers.values()) changed();
}

beforeEach(() => {
    settings.enabled = false;
    settings.inputVolume = 100;
    settings.automaticSensitivity = false;
    settings.sensitivity = -100;
});

it("suppresses fan-like noise and restores the unfiltered signal when disabled", async () => {
    const context = new AudioContext({ sampleRate: 48000 });
    const capture = context.createMediaStreamDestination();
    capture.channelCount = 1;
    const noise = context.createBufferSource();
    const buffer = context.createBuffer(1, 48000, 48000);
    const samples = buffer.getChannelData(0);
    let seed = 1;
    let lowPass = 0;
    for (let i = 0; i < samples.length; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
        // A one-pole low-pass models steady fan noise. Normalize to the same RMS as 0.025 white noise.
        lowPass += 0.15 * (seed / 2147483648 - lowPass);
        samples[i] = lowPass;
    }
    const noiseRms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
    for (let i = 0; i < samples.length; i++) samples[i] *= 0.025 / Math.sqrt(3) / noiseRms;
    noise.buffer = buffer;
    noise.loop = true;
    noise.connect(capture);
    noise.start();
    await context.resume();

    const input = capture.stream.getAudioTracks()[0];
    const processor = new NoiseSuppressionProcessor();
    try {
        await processor.init({ track: input });
        // A fallback to the input would hide broken WASM/worklet asset loading.
        expect(processor.processedTrack).toBeDefined();
        expect(processor.processedTrack).not.toBe(input);
        const output = context.createMediaStreamSource(new MediaStream([processor.processedTrack!]));
        const analyser = context.createAnalyser();
        analyser.fftSize = 2048;
        output.connect(analyser);
        const silentSink = context.createGain();
        silentSink.gain.value = 0;
        analyser.connect(silentSink).connect(context.destination);
        const timeData = new Float32Array(analyser.fftSize);
        const rms = (): number => {
            analyser.getFloatTimeDomainData(timeData);
            return Math.sqrt(timeData.reduce((sum, value) => sum + value * value, 0) / timeData.length);
        };
        const measureRms = async (): Promise<number> => {
            let energy = 0;
            for (let i = 0; i < 10; i++) {
                energy += rms() ** 2;
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            return Math.sqrt(energy / 10);
        };
        await expect.poll(rms).toBeGreaterThan(0.012);
        const unfiltered = await measureRms();

        settings.enabled = true;
        updateSettings();
        // Allow the model to settle, then require at least 12 dB of attenuation.
        const started = context.currentTime;
        await expect.poll(() => context.currentTime - started, { timeout: 3000 }).toBeGreaterThan(1);
        expect(await measureRms()).toBeLessThan(unfiltered * 0.25);

        settings.enabled = false;
        updateSettings();
        await expect.poll(rms).toBeGreaterThan(unfiltered * 0.8);
        expect(input.readyState).toBe("live");

        await processor.destroy();
        expect(input.readyState).toBe("live");
        output.disconnect();
        analyser.disconnect();
        silentSink.disconnect();
    } finally {
        await processor.destroy();
        noise.stop();
        input.stop();
        await context.close();
    }
}, 15000);

it("retains gain and gating when the model download is invalid", async () => {
    const context = new AudioContext({ sampleRate: 48000 });
    const input = context.createMediaStreamDestination().stream.getAudioTracks()[0];
    const fetchModel = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Invalid model", { status: 503 }));
    const processor = new NoiseSuppressionProcessor();
    try {
        await processor.init({ track: input });
        expect(fetchModel).toHaveBeenCalled();
        expect(processor.processedTrack).toBeDefined();
        expect(processor.processedTrack).not.toBe(input);
        expect(input.readyState).toBe("live");
    } finally {
        fetchModel.mockRestore();
        await processor.destroy();
        input.stop();
        await context.close();
    }
}, 10000);

it("applies live input gain and manual gating to outgoing samples with an ungated meter", async () => {
    settings.sensitivity = -40;
    const context = new AudioContext({ sampleRate: 48000 });
    const capture = context.createMediaStreamDestination();
    const oscillator = context.createOscillator();
    const inputGain = context.createGain();
    inputGain.gain.value = 0.003;
    oscillator.connect(inputGain).connect(capture);
    oscillator.start();
    await context.resume();
    const input = capture.stream.getAudioTracks()[0];
    const onLevel = vi.fn<(levelDb: number, detected: boolean, threshold: number) => void>();
    const processor = new NoiseSuppressionProcessor(onLevel);
    let output: MediaStreamAudioSourceNode | undefined;
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    const silentSink = context.createGain();
    silentSink.gain.value = 0;
    try {
        await processor.init({ track: input });
        expect(processor.processedTrack).toBeDefined();
        output = context.createMediaStreamSource(new MediaStream([processor.processedTrack!]));
        output.connect(analyser).connect(silentSink).connect(context.destination);
        const samples = new Float32Array(analyser.fftSize);
        const rms = (): number => {
            analyser.getFloatTimeDomainData(samples);
            return Math.sqrt(samples.reduce((energy, sample) => energy + sample * sample, 0) / samples.length);
        };
        await expect.poll(() => onLevel.mock.lastCall?.[0]).toBeGreaterThan(-60);
        expect(onLevel.mock.lastCall?.[1]).toBe(false);
        expect(onLevel.mock.lastCall?.[2]).toBe(-40);
        expect(rms()).toBe(0);

        inputGain.gain.value = 0.1;
        await expect.poll(rms).toBeGreaterThan(0.065);
        await expect.poll(() => onLevel.mock.lastCall?.[1]).toBe(true);
        settings.inputVolume = 200;
        updateSettings();
        await expect.poll(rms).toBeGreaterThan(0.13);
        expect(rms()).toBeLessThan(0.15);

        settings.sensitivity = -10;
        updateSettings();
        await expect.poll(rms).toBeLessThan(0.000001);
        await expect.poll(() => onLevel.mock.lastCall?.[1]).toBe(false);
        expect(onLevel.mock.lastCall?.[0]).toBeGreaterThan(-20);
        expect(onLevel.mock.lastCall?.[2]).toBe(-10);

        settings.sensitivity = -100;
        settings.inputVolume = 0;
        updateSettings();
        await expect.poll(() => onLevel.mock.lastCall?.[0]).toBe(-100);
        expect(rms()).toBeLessThan(0.000001);
        await processor.destroy();
        expect(input.readyState).toBe("live");
        expect(settings.watchers.size).toBe(0);
    } finally {
        await processor.destroy();
        oscillator.stop();
        output?.disconnect();
        analyser.disconnect();
        silentSink.disconnect();
        input.stop();
        await context.close();
    }
}, 15000);
