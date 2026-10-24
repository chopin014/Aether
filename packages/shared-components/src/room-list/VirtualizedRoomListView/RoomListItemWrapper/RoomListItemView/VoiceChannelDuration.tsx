/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, useEffect, useState } from "react";

import { formatSeconds } from "../../../../core/utils/DateUtils";
import { _t } from "../../../../core/i18n/i18n";
import styles from "./RoomListItemView.module.css";

/** Props for {@link VoiceChannelDuration}. */
export interface VoiceChannelDurationProps {
    /** When people started gathering in the channel, in milliseconds since the epoch. */
    since: number;
}

/**
 * How long a voice channel has had people in it, ticking every second.
 */
export function VoiceChannelDuration({ since }: VoiceChannelDurationProps): JSX.Element {
    const [now, setNow] = useState(Date.now);

    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, []);

    // A membership created on a device with a clock ahead of ours must not show a negative time.
    const duration = formatSeconds(Math.max(0, Math.floor((now - since) / 1000)), { hoursMinLength: 1 });
    return (
        <time className={styles.callDuration} title={_t("desktop|voice|occupied_for", { duration })}>
            {duration}
        </time>
    );
}
