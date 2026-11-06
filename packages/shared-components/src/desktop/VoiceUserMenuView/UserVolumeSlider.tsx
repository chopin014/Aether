/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, useState } from "react";

import { MAX_PLAYBACK_VOLUME_PERCENT } from "../playbackVolume";
import styles from "./VoiceUserMenuView.module.css";

/** Props for {@link UserVolumeSlider}. */
export interface UserVolumeSliderProps {
    /** The accessible name of the slider. */
    label: string;
    /** The current volume, from 0 to {@link MAX_PLAYBACK_VOLUME_PERCENT}. */
    value: number;
    /** Called with each new volume while the knob moves. */
    onChange: (percent: number) => void;
    /** A test id for the range input. */
    testId?: string;
}

/**
 * A Discord-style volume slider from 0% to 200%. The track is filled up to the knob, a notch marks 100%, and the
 * value floats above the knob while it is pointed at, dragged or focused.
 */
export function UserVolumeSlider({ label, value, onChange, testId }: UserVolumeSliderProps): JSX.Element {
    const [active, setActive] = useState(false);
    const clamped = Math.max(0, Math.min(MAX_PLAYBACK_VOLUME_PERCENT, Math.round(value)));
    const position = (clamped / MAX_PLAYBACK_VOLUME_PERCENT) * 100;
    return (
        <div
            className={styles.volumeSlider}
            data-active={active || undefined}
            style={{ "--position": `${position}%`, "--fraction": position / 100 } as React.CSSProperties}
        >
            <span className={styles.volumeBubble} aria-hidden="true">
                {clamped}%
            </span>
            <span className={styles.volumeNotch} aria-hidden="true" />
            <input
                type="range"
                min={0}
                max={MAX_PLAYBACK_VOLUME_PERCENT}
                step={1}
                value={clamped}
                aria-label={label}
                aria-valuetext={`${clamped}%`}
                data-testid={testId}
                onChange={(event) => onChange(Number(event.target.value))}
                onPointerEnter={() => setActive(true)}
                onPointerLeave={() => setActive(false)}
                onFocus={() => setActive(true)}
                onBlur={() => setActive(false)}
            />
        </div>
    );
}
