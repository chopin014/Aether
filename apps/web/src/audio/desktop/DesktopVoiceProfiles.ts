/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type DesktopInputProfile, type DesktopNoiseSuppression } from "@element-hq/web-shared-components";

import SettingsStore from "../../settings/SettingsStore";
import { SettingLevel } from "../../settings/SettingLevel";
import MediaDeviceHandler from "../../MediaDeviceHandler";

/** The processing choices a preset makes on behalf of the user. */
export interface DesktopVoiceProfilePreset {
    noiseSuppression: DesktopNoiseSuppression;
    voiceDetection: boolean;
    sensitivityAuto?: boolean;
}

/** Keep in step with the processing applied by `getMicrophoneGateConfig`. */
export const DESKTOP_VOICE_PROFILE_PRESETS: Record<
    Exclude<DesktopInputProfile, "custom">,
    DesktopVoiceProfilePreset
> = {
    // ANS (Aether Noise Suppression) with its speech detection and the automatic sensitivity it was tuned with.
    voice_isolation: {
        noiseSuppression: "enhanced",
        voiceDetection: true,
        sensitivityAuto: true,
    },
    studio: { noiseSuppression: "none", voiceDetection: false },
};

/** Preserve the active preset's choices before editing an individual processing setting. */
export async function customizeDesktopVoiceProfile(): Promise<void> {
    const profile = SettingsStore.getValue("desktopInputProfile");
    if (profile === "custom") return;
    const preset = DESKTOP_VOICE_PROFILE_PRESETS[profile];
    await SettingsStore.setValue("desktopNoiseSuppression", null, SettingLevel.DEVICE, preset.noiseSuppression);
    await SettingsStore.setValue("desktopVoiceDetection", null, SettingLevel.DEVICE, preset.voiceDetection);
    if (preset.sensitivityAuto !== undefined) {
        await SettingsStore.setValue("desktopInputSensitivityAuto", null, SettingLevel.DEVICE, preset.sensitivityAuto);
    }
    await SettingsStore.setValue("desktopInputProfile", null, SettingLevel.DEVICE, "custom");
}

/**
 * Moves this device onto ANS once: custom processing returns to the voice isolation profile, with the echo
 * cancellation and automatic gain that choosing it in the settings turns on. Studio is left alone, since it is an
 * explicit choice of raw, unprocessed audio. Anyone can pick another profile afterwards; this never runs again.
 */
export async function migrateToAns(): Promise<void> {
    if (SettingsStore.getValue("desktopAnsMigrated")) return;
    if (SettingsStore.getValue("desktopInputProfile") === "custom") {
        await MediaDeviceHandler.setAudioAutoGainControl(true);
        await MediaDeviceHandler.setAudioEchoCancellation(true);
        await SettingsStore.setValue("desktopInputProfile", null, SettingLevel.DEVICE, "voice_isolation");
    }
    await SettingsStore.setValue("desktopAnsMigrated", null, SettingLevel.DEVICE, true);
}
