/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";

import { SETTINGS } from "../settings/Settings";
import { SettingLevel } from "../settings/SettingLevel";
import { VoiceGate } from "./VoiceGate";
import { normalizeVoiceGateSettings } from "./voice-gate-types";

const sampleRate = 48000;

function render(gate: VoiceGate, levelDb: number, seconds = 0.5): Float32Array {
    const input = new Float32Array(128).fill(10 ** (levelDb / 20));
    const output = new Float32Array(128);
    for (let i = 0; i < Math.ceil((seconds * sampleRate) / 128); i++) gate.process(input, output);
    return output;
}

describe("VoiceGate", () => {
    it.each([
        ["webrtc_audio_inputVolume", 100],
        ["webrtc_audio_automaticSensitivity", true],
        ["webrtc_audio_sensitivity", -50],
    ] as const)("should keep %s device-local with its default", (name, value) => {
        expect(SETTINGS[name].supportedLevels).toEqual([SettingLevel.DEVICE]);
        expect(SETTINGS[name].default).toBe(value);
    });

    it("should gate below the manual threshold and retain the ungated meter level", () => {
        const gate = new VoiceGate(sampleRate, { automaticSensitivity: false, sensitivity: -40 });
        expect(render(gate, -50).every((sample) => sample === 0)).toBe(true);
        expect(gate.voiceDetected).toBe(false);
        expect(gate.levelDb).toBeCloseTo(-50);
        expect(gate.thresholdDb).toBe(-40);
        expect(render(gate, -30)[127]).toBeCloseTo(10 ** (-30 / 20));
        expect(gate.voiceDetected).toBe(true);
        expect(render(gate, -60).every((sample) => sample === 0)).toBe(true);
        expect(gate.levelDb).toBeCloseTo(-60);
    });

    it("should hold through short pauses and use hysteresis for quiet syllables", () => {
        const gate = new VoiceGate(sampleRate, { automaticSensitivity: false, sensitivity: -40 });
        render(gate, -30);
        render(gate, -43, 0.3);
        expect(gate.voiceDetected).toBe(true);
        render(gate, -70, 0.1);
        expect(gate.voiceDetected).toBe(true);
        render(gate, -70, 0.15);
        expect(gate.voiceDetected).toBe(false);
    });

    it("should learn ambient noise without learning sustained speech as noise", () => {
        const gate = new VoiceGate(sampleRate);
        expect(render(gate, -55).every((sample) => sample === 0)).toBe(true);
        expect(gate.thresholdDb).toBeCloseTo(-45);
        render(gate, -53, 4);
        expect(gate.voiceDetected).toBe(false);
        expect(gate.thresholdDb).toBeCloseTo(-43, 0);
        render(gate, -25, 10);
        expect(gate.voiceDetected).toBe(true);
        expect(gate.thresholdDb).toBeCloseTo(-43, 0);
        render(gate, -65, 1);
        expect(gate.voiceDetected).toBe(false);
        expect(gate.thresholdDb).toBeCloseTo(-55, 0);
    });

    it("should double amplitude at 200 percent and smoothly mute at zero", () => {
        const gate = new VoiceGate(sampleRate, { inputVolume: 200, automaticSensitivity: false, sensitivity: -100 });
        expect(render(gate, -20)[127]).toBeCloseTo(0.2);
        expect(gate.levelDb).toBeCloseTo(-20 + 20 * Math.log10(2));
        gate.updateSettings({ inputVolume: 0, automaticSensitivity: false, sensitivity: -100 });
        const transition = render(gate, -20, 128 / sampleRate);
        expect(transition[0]).toBeGreaterThan(0);
        expect(transition[127]).toBeLessThan(transition[0]);
        expect(gate.voiceDetected).toBe(false);
        expect(render(gate, -20).every((sample) => sample === 0)).toBe(true);
        expect(gate.levelDb).toBe(-100);
    });

    it("should apply live sensitivity, mode and gain changes", () => {
        const gate = new VoiceGate(sampleRate, { automaticSensitivity: false, sensitivity: -20 });
        render(gate, -40);
        expect(gate.voiceDetected).toBe(false);
        gate.updateSettings({ automaticSensitivity: false, sensitivity: -60, inputVolume: 200 });
        expect(render(gate, -40)[127]).toBeCloseTo(0.02);
        expect(gate.voiceDetected).toBe(true);
        gate.updateSettings({ automaticSensitivity: true, inputVolume: 100 });
        render(gate, -70, 1);
        expect(gate.thresholdDb).toBeCloseTo(-60, 0);
        expect(gate.voiceDetected).toBe(false);
    });

    it("should keep missing inputs and digital silence silent at the lowest threshold", () => {
        const gate = new VoiceGate(sampleRate, { automaticSensitivity: false, sensitivity: -100 });
        const output = new Float32Array(128).fill(1);
        gate.process(undefined, output);
        expect(output.every((sample) => sample === 0)).toBe(true);
        expect(gate.levelDb).toBe(-100);
        expect(gate.voiceDetected).toBe(false);
    });

    it("should clamp extreme settings and default invalid persisted values", () => {
        expect(normalizeVoiceGateSettings({ inputVolume: 500, sensitivity: -150 })).toEqual({
            inputVolume: 200,
            sensitivity: -100,
            automaticSensitivity: true,
        });
        expect(normalizeVoiceGateSettings({ inputVolume: -5, sensitivity: 5 })).toEqual({
            inputVolume: 0,
            sensitivity: 0,
            automaticSensitivity: true,
        });
        expect(normalizeVoiceGateSettings({ inputVolume: NaN, sensitivity: Infinity })).toEqual({
            inputVolume: 100,
            sensitivity: -50,
            automaticSensitivity: true,
        });
        expect(normalizeVoiceGateSettings({ automaticSensitivity: false }).automaticSensitivity).toBe(false);
    });
});
