/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, useId } from "react";
import classNames from "classnames";

import { levelToPercent } from "./LevelMeter";
import styles from "./DesktopVoiceVideoSettingsView.module.css";

interface RangeSliderProps {
    /** The accessible name; there is no visible label of its own. */
    label: string;
    value: number;
    min: number;
    max: number;
    step?: number;
    /** A spoken form of the value, such as "-50 dB". */
    valueText?: string;
    disabled?: boolean;
    /** Colours the track yellow up to the knob and green after it, with the live level drawn under it. */
    sensitivity?: { level: number | null };
    onChange: (value: number) => void;
}

/** A slider with the Aether track: accent up to the knob, or yellow to green for the input sensitivity. */
export function RangeSlider({
    label,
    value,
    min,
    max,
    step = 1,
    valueText,
    disabled,
    sensitivity,
    onChange,
}: RangeSliderProps): JSX.Element {
    const id = useId();
    const position = ((value - min) / (max - min)) * 100;
    return (
        <div className={classNames(styles.slider, sensitivity && styles.sensitivitySlider)}>
            {sensitivity && sensitivity.level !== null && (
                <div
                    className={styles.sliderLevel}
                    data-testid="sensitivity-level"
                    style={{ width: `${levelToPercent(sensitivity.level)}%` }}
                />
            )}
            <input
                id={id}
                type="range"
                aria-label={label}
                aria-valuetext={valueText}
                min={min}
                max={max}
                step={step}
                value={value}
                disabled={disabled}
                style={{ "--position": `${position}%` } as React.CSSProperties}
                onChange={(event) => onChange(Number(event.target.value))}
            />
        </div>
    );
}
