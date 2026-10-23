/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/** Device settings consumed by the microphone's audio thread. */
export interface VoiceGateSettings {
    inputVolume: number;
    automaticSensitivity: boolean;
    sensitivity: number;
}

/** Microphone level after input gain and noise suppression, before the voice gate. */
export interface VoiceGateLevel {
    levelDb: number;
    voiceDetected: boolean;
    thresholdDb: number;
}

/** Clamp persisted or externally supplied settings before using them on audio samples. */
export function normalizeVoiceGateSettings(settings: Partial<VoiceGateSettings>): VoiceGateSettings {
    return {
        inputVolume: finiteClamp(settings.inputVolume, 0, 200, 100),
        automaticSensitivity: typeof settings.automaticSensitivity === "boolean" ? settings.automaticSensitivity : true,
        sensitivity: finiteClamp(settings.sensitivity, -100, 0, -50),
    };
}

function finiteClamp(value: number | undefined, min: number, max: number, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}
