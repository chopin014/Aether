/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type DesktopInputProfile, type DesktopNoiseSuppression } from "@element-hq/web-shared-components";

import SettingsStore from "../../settings/SettingsStore";
import { SettingLevel } from "../../settings/SettingLevel";

/** The processing choices a preset makes on behalf of the user. */
export interface DesktopVoiceProfilePreset {
    noiseSuppression: DesktopNoiseSuppression;
    noiseSuppressionStrength?: number;
    voiceDetection: boolean;
    sensitivityAuto?: boolean;
}

/** Keep in step with the processing applied by `getMicrophoneGateConfig`. */
export const DESKTOP_VOICE_PROFILE_PRESETS: Record<
    Exclude<DesktopInputProfile, "custom">,
    DesktopVoiceProfilePreset
> = {
    voice_isolation: {
        noiseSuppression: "enhanced",
        noiseSuppressionStrength: 100,
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
    if (preset.noiseSuppressionStrength !== undefined) {
        await SettingsStore.setValue(
            "desktopNoiseSuppressionStrength",
            null,
            SettingLevel.DEVICE,
            preset.noiseSuppressionStrength,
        );
    }
    if (preset.sensitivityAuto !== undefined) {
        await SettingsStore.setValue("desktopInputSensitivityAuto", null, SettingLevel.DEVICE, preset.sensitivityAuto);
    }
    await SettingsStore.setValue("desktopInputProfile", null, SettingLevel.DEVICE, "custom");
}
