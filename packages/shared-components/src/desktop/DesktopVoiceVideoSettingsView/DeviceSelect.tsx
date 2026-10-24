/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, useId } from "react";
import { ChevronDownIcon } from "@vector-im/compound-design-tokens/assets/web/icons";

import styles from "./DesktopVoiceVideoSettingsView.module.css";

/** A device the user can choose. */
export interface VoiceVideoDevice {
    id: string;
    label: string;
}

interface DeviceSelectProps {
    label: string;
    icon: JSX.Element;
    devices: VoiceVideoDevice[];
    value: string;
    onChange: (id: string) => void;
}

/** A labelled device picker. A native select keeps keyboard and screen reader behaviour for free. */
export function DeviceSelect({ label, icon, devices, value, onChange }: DeviceSelectProps): JSX.Element {
    const id = useId();
    return (
        <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor={id}>
                {label}
            </label>
            <div className={styles.select}>
                <span className={styles.selectIcon} aria-hidden="true">
                    {icon}
                </span>
                <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
                    {devices.map((device) => (
                        <option key={device.id} value={device.id}>
                            {device.label}
                        </option>
                    ))}
                </select>
                <span className={styles.selectChevron} aria-hidden="true">
                    <ChevronDownIcon />
                </span>
            </div>
        </div>
    );
}
