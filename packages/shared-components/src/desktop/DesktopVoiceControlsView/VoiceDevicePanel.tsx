/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { Button } from "@vector-im/compound-web";
import { MicOnIcon, SettingsIcon, VolumeOnIcon } from "@vector-im/compound-design-tokens/assets/web/icons";

import { useViewModel } from "../../core/viewmodel";
import { useI18n } from "../../core/i18n/i18nContext";
import { DeviceSelect } from "../DesktopVoiceVideoSettingsView/DeviceSelect";
import { RangeSlider } from "../DesktopVoiceVideoSettingsView/RangeSlider";
import { type DesktopVoiceControlsViewModel } from "./DesktopVoiceControlsView";
import styles from "./DesktopVoiceControlsView.module.css";

interface VoiceDevicePanelProps {
    vm: DesktopVoiceControlsViewModel;
    /** The microphone ("input") or the speaker ("output"). */
    kind: "input" | "output";
}

/** Chooses the microphone or speaker and its volume, without opening the full voice settings. */
export function VoiceDevicePanel({ vm, kind }: VoiceDevicePanelProps): JSX.Element {
    const { audioInputs, audioOutputs, audioInputId, audioOutputId, microphoneVolume, speakerVolume } =
        useViewModel(vm);
    const { translate: _t } = useI18n();
    const input = kind === "input";
    const volume = input ? microphoneVolume : speakerVolume;
    return (
        <div className={styles.devicePanel}>
            <DeviceSelect
                label={input ? _t("desktop|voice|input_device") : _t("desktop|voice|output_device")}
                icon={input ? <MicOnIcon /> : <VolumeOnIcon />}
                devices={[...(input ? audioInputs : audioOutputs)]}
                value={input ? audioInputId : audioOutputId}
                onChange={(id) => void (input ? vm.setAudioInput(id) : vm.setAudioOutput(id))}
            />
            <div className={styles.volumeField}>
                <div className={styles.panelRow}>
                    <span className={styles.volumeLabel}>
                        {input ? _t("desktop|voice|input_volume") : _t("desktop|voice|output_volume")}
                    </span>
                    <span className={styles.numeric}>{`${volume}%`}</span>
                </div>
                <RangeSlider
                    label={input ? _t("desktop|voice|input_volume") : _t("desktop|voice|output_volume")}
                    value={volume}
                    min={0}
                    max={100}
                    valueText={`${volume}%`}
                    onChange={(percent) =>
                        void (input ? vm.setMicrophoneVolume(percent) : vm.setSpeakerVolume(percent))
                    }
                />
            </div>
            <Button kind="tertiary" size="md" Icon={SettingsIcon} onClick={vm.openVoiceSettings}>
                {_t("desktop|voice|voice_settings")}
            </Button>
        </div>
    );
}
