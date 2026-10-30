/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, useEffect, useId, useRef, useState } from "react";

import styles from "./DesktopVoiceControlsView.module.css";

/** The solid microphone and headphones from Compound, drawn here so the slash can be animated over them. */
const SHAPES = {
    microphone: [
        "M8 6a4 4 0 1 1 8 0v6a4 4 0 0 1-8 0z",
        "M5 11a1 1 0 0 1 1 1 6 6 0 0 0 12 0 1 1 0 1 1 2 0 8 8 0 0 1-7 7.938V21a1 1 0 1 1-2 0v-1.062A8 8 0 0 1 4 12a1 1 0 0 1 1-1",
    ],
    headphones: [
        "M12 3a8 8 0 0 0-8 8v3h2a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-9C2 5.477 6.477 1 12 1s10 4.477 10 10v9a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h2v-3a8 8 0 0 0-8-8",
    ],
} as const;

interface AnimatedDeviceIconProps {
    device: keyof typeof SHAPES;
    /** Whether the device is muted, drawn as a slash through it. */
    off: boolean;
}

/**
 * A microphone or headphones icon whose slash draws across when muted and retracts when unmuted. The icon cuts a
 * gap around the slash, like Compound's own "off" icons. Muting also shakes the icon and sends a ring out from it;
 * unmuting makes it bounce back.
 */
export function AnimatedDeviceIcon({ device, off }: AnimatedDeviceIconProps): JSX.Element {
    // React's ids contain characters that would need escaping inside url().
    const mask = `device-slash-${useId().replace(/[^\w-]/g, "")}`;
    // Only animate changes the user sees happen, not the state the dock first renders with.
    const initial = useRef(off);
    const [changed, setChanged] = useState(false);
    useEffect(() => {
        if (off !== initial.current) setChanged(true);
    }, [off]);
    return (
        <span className={styles.deviceIcon} data-off={off} data-animate={changed || undefined} aria-hidden="true">
            <span className={styles.deviceRipple} />
            <svg viewBox="0 0 24 24" fill="currentColor">
                <mask id={mask} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
                    <rect width="24" height="24" fill="white" />
                    <line className={styles.slashGap} x1="2.5" y1="2.5" x2="21.5" y2="21.5" pathLength="1" />
                </mask>
                <g mask={`url(#${mask})`}>
                    {SHAPES[device].map((path) => (
                        <path key={path} d={path} />
                    ))}
                </g>
                <line className={styles.slash} x1="3.5" y1="3.5" x2="20.5" y2="20.5" pathLength="1" />
            </svg>
        </span>
    );
}
