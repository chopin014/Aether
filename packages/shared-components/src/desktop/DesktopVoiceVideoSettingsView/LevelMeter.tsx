/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";

import styles from "./DesktopVoiceVideoSettingsView.module.css";

/** The loudest and quietest levels the meters show, in dB relative to full scale. */
export const LEVEL_RANGE_DB = [-100, 0] as const;

/** Where a level in dB sits on a meter or slider, from 0 to 100. */
export function levelToPercent(db: number): number {
    const [low, high] = LEVEL_RANGE_DB;
    return Math.min(100, Math.max(0, ((db - low) / (high - low)) * 100));
}

interface LevelMeterProps {
    /** What the meter measures, for people who cannot see it. */
    label: string;
    /** The current level in dB, or null while nothing is being measured. */
    level: number | null;
    /** Whether the sound is being let through; the meter is green then, and yellow while it is held back. */
    open: boolean;
}

/** Segmented bars that fill with the loudness of the microphone while it is tested. */
export function LevelMeter({ label, level, open }: LevelMeterProps): JSX.Element {
    const value = level ?? LEVEL_RANGE_DB[0];
    return (
        <div
            className={styles.meter}
            role="meter"
            aria-label={label}
            aria-valuemin={LEVEL_RANGE_DB[0]}
            aria-valuemax={LEVEL_RANGE_DB[1]}
            aria-valuenow={Math.round(value)}
            data-open={level !== null && open ? true : undefined}
        >
            <div className={styles.meterFill} style={{ width: `${level === null ? 0 : levelToPercent(value)}%` }} />
        </div>
    );
}
