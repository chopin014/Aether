/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, useId, useState } from "react";
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
    /**
     * Draws the live level in the track, like Discord: the part below the knob is held back and the part above
     * it is sent, and the track lights up as far as the current level reaches.
     */
    sensitivity?: { level: number | null; open: boolean };
    /** Floats the value text above the knob while it is pointed at, dragged or focused, as Discord does. */
    showValue?: boolean;
    /** A value marked with a notch on the track, such as 100% on a slider that goes past it. */
    mark?: number;
    onChange: (value: number) => void;
}

/** A slider with the Aether track: accent up to the knob, or the live level against the input sensitivity. */
export function RangeSlider({
    label,
    value,
    min,
    max,
    step = 1,
    valueText,
    disabled,
    sensitivity,
    showValue,
    mark,
    onChange,
}: RangeSliderProps): JSX.Element {
    const id = useId();
    const [active, setActive] = useState(false);
    const position = ((value - min) / (max - min)) * 100;
    return (
        <div
            className={classNames(styles.slider, sensitivity && styles.sensitivitySlider)}
            data-active={active || undefined}
            style={{ "--position": `${position}%`, "--fraction": position / 100 } as React.CSSProperties}
        >
            {showValue && (
                <span className={styles.sliderValue} aria-hidden="true" data-testid="slider-value">
                    {valueText ?? value}
                </span>
            )}
            {mark !== undefined && mark > min && mark < max && (
                <span
                    className={styles.sliderMark}
                    aria-hidden="true"
                    style={{ "--mark": (mark - min) / (max - min) } as React.CSSProperties}
                />
            )}
            {sensitivity && (
                <div className={styles.sensitivityTrack} aria-hidden="true">
                    <div
                        className={styles.sensitivityLevel}
                        data-testid="sensitivity-level"
                        data-open={sensitivity.open || undefined}
                        style={
                            {
                                "--level": `${sensitivity.level === null ? 0 : levelToPercent(sensitivity.level)}%`,
                            } as React.CSSProperties
                        }
                    />
                </div>
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
                onPointerEnter={showValue ? () => setActive(true) : undefined}
                onPointerLeave={showValue ? () => setActive(false) : undefined}
                onFocus={showValue ? () => setActive(true) : undefined}
                onBlur={showValue ? () => setActive(false) : undefined}
            />
        </div>
    );
}
