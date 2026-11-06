/*
Copyright 2026 Gabriel
Copyright 2024, 2025 New Vector Ltd.
Copyright 2019-2023 The Matrix.org Foundation C.I.C.
Copyright 2019 Michael Telatynski <7t3chguy@gmail.com>

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { type ChangeEvent, type JSX, useState } from "react";

import { _t } from "../../../../../languageHandler";
import SettingsStore from "../../../../../settings/SettingsStore";
import { SettingLevel } from "../../../../../settings/SettingLevel";
import { type SettingKey } from "../../../../../settings/Settings.tsx";
import SdkConfig from "../../../../../SdkConfig";
import SettingsFlag from "../../../elements/SettingsFlag";
import SettingsDropdown from "../../../elements/SettingsDropdown.tsx";
import Field from "../../../elements/Field";
import SettingsTab from "../SettingsTab";
import { SettingsSection } from "../../shared/SettingsSection";
import { SettingsSubsection } from "../../shared/SettingsSubsection";

/** Whether this platform lets the user change a desktop app setting. */
const canSet = (name: SettingKey): boolean => SettingsStore.canSetValue(name, null, SettingLevel.PLATFORM);

/** A number of milliseconds kept on this device, edited as a text field. */
function NumberSetting({
    name,
    label,
}: {
    name: "autocompleteDelay" | "readMarkerInViewThresholdMs" | "readMarkerOutOfViewThresholdMs";
    label: string;
}): JSX.Element {
    const [value, setValue] = useState(() => SettingsStore.getValueAt(SettingLevel.DEVICE, name).toString(10));
    const onChange = (e: ChangeEvent<HTMLInputElement>): void => {
        setValue(e.target.value);
        void SettingsStore.setValue(name, null, SettingLevel.DEVICE, e.target.valueAsNumber);
    };
    return <Field label={label} type="number" value={value} onChange={onChange} />;
}

/**
 * The System settings page: how the desktop app starts and runs, and timings few people need to change.
 * Sections the platform cannot change are left out.
 */
export function SystemUserSettingsTab(): JSX.Element {
    const brand = SdkConfig.get().brand;
    const hasStartup = (
        [
            "Electron.autoLaunch",
            "Electron.showTrayIcon",
            "Electron.alwaysShowMenuBar",
            "Electron.warnBeforeExit",
        ] as const
    ).some(canSet);
    const hasPerformance = (["Electron.enableHardwareAcceleration", "Electron.enableContentProtection"] as const).some(
        canSet,
    );

    return (
        <SettingsTab data-testid="mx_SystemUserSettingsTab">
            <SettingsSection>
                {hasStartup && (
                    <SettingsSubsection
                        heading={_t("settings|preferences|startup_window_behaviour_label")}
                        formWrap
                        card
                    >
                        {canSet("Electron.autoLaunch") && (
                            <SettingsDropdown
                                settingKey="Electron.autoLaunch"
                                label={_t("settings|start_automatically|label", { brand })}
                                level={SettingLevel.PLATFORM}
                                hideIfCannotSet
                            />
                        )}
                        <SettingsFlag name="Electron.showTrayIcon" level={SettingLevel.PLATFORM} hideIfCannotSet />
                        <SettingsFlag name="Electron.alwaysShowMenuBar" level={SettingLevel.PLATFORM} hideIfCannotSet />
                        <SettingsFlag name="Electron.warnBeforeExit" level={SettingLevel.PLATFORM} hideIfCannotSet />
                    </SettingsSubsection>
                )}

                {hasPerformance && (
                    <SettingsSubsection heading={_t("settings|system|performance_heading")} formWrap card>
                        <SettingsFlag
                            name="Electron.enableHardwareAcceleration"
                            level={SettingLevel.PLATFORM}
                            hideIfCannotSet
                            label={_t("settings|preferences|Electron.enableHardwareAcceleration", { appName: brand })}
                        />
                        <SettingsFlag
                            name="Electron.enableContentProtection"
                            level={SettingLevel.PLATFORM}
                            hideIfCannotSet
                            label={_t("settings|preferences|Electron.enableContentProtection")}
                        />
                    </SettingsSubsection>
                )}

                <SettingsSubsection
                    heading={_t("common|advanced")}
                    description={_t("settings|system|advanced_description")}
                    formWrap
                    card
                >
                    <NumberSetting name="autocompleteDelay" label={_t("settings|preferences|autocomplete_delay")} />
                    <NumberSetting name="readMarkerInViewThresholdMs" label={_t("settings|preferences|rm_lifetime")} />
                    <NumberSetting
                        name="readMarkerOutOfViewThresholdMs"
                        label={_t("settings|preferences|rm_lifetime_offscreen")}
                    />
                </SettingsSubsection>
            </SettingsSection>
        </SettingsTab>
    );
}
