/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, type MouseEvent } from "react";
import { MenuItem, SubMenu } from "@vector-im/compound-web";
import { NotificationsIcon, NotificationsOffIcon } from "@vector-im/compound-design-tokens/assets/web/icons";

import { _t } from "../../core/i18n/i18n";
import styles from "./MuteMenu.module.css";

/** Discord's mute durations, in milliseconds: 15 minutes, 1, 3, 8 and 24 hours. */
export const MUTE_DURATIONS = [15 * 60_000, 60 * 60_000, 3 * 60 * 60_000, 8 * 60 * 60_000, 24 * 60 * 60_000] as const;

function durationLabel(duration: (typeof MUTE_DURATIONS)[number]): string {
    switch (duration) {
        case 15 * 60_000:
            return _t("desktop|mute|minutes_15");
        case 60 * 60_000:
            return _t("desktop|mute|hour_1");
        case 3 * 60 * 60_000:
            return _t("desktop|mute|hours_3");
        case 8 * 60 * 60_000:
            return _t("desktop|mute|hours_8");
        default:
            return _t("desktop|mute|hours_24");
    }
}

/** When a mute ends, as a time today or a day and time later in the week. */
export function formatMutedUntil(until: number, now = Date.now()): string {
    const end = new Date(until);
    const sameDay = new Date(now).toDateString() === end.toDateString();
    const time = end.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    return sameDay ? time : `${end.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}

/** Props for {@link MuteMenu}. */
export interface MuteMenuProps {
    /** What muting is called here, such as "Mute channel". */
    muteLabel: string;
    /** What turning it back on is called here, such as "Unmute channel". */
    unmuteLabel: string;
    /** Whether it is muted now. */
    isMuted: boolean;
    /** When the mute ends, if it lasts only a while. */
    mutedUntil?: number;
    /** Mute for this many milliseconds, or until turned back on for null. */
    onMute: (duration: number | null) => void;
    onUnmute: () => void;
}

/**
 * Mute something for a while or until it is turned back on, or turn it back on, as in Discord's channel, category and
 * server menus. Muted, it offers to turn it back on and says when the mute ends by itself.
 */
export function MuteMenu({
    muteLabel,
    unmuteLabel,
    isMuted,
    mutedUntil,
    onMute,
    onUnmute,
}: MuteMenuProps): JSX.Element {
    // The menu sits inside rows and headers that react to clicks of their own.
    const stop = (event: MouseEvent): void => event.stopPropagation();
    if (isMuted) {
        return (
            <MenuItem Icon={NotificationsIcon} label={unmuteLabel} onSelect={onUnmute} onClick={stop} hideChevron>
                {mutedUntil !== undefined && (
                    <span className={styles.until}>
                        {_t("desktop|mute|until", { time: formatMutedUntil(mutedUntil) })}
                    </span>
                )}
            </MenuItem>
        );
    }
    return (
        <SubMenu trigger={<MenuItem Icon={NotificationsOffIcon} label={muteLabel} onSelect={null} />}>
            {MUTE_DURATIONS.map((duration) => (
                <MenuItem
                    key={duration}
                    label={durationLabel(duration)}
                    onSelect={() => onMute(duration)}
                    onClick={stop}
                    hideChevron
                />
            ))}
            <MenuItem label={_t("desktop|mute|forever")} onSelect={() => onMute(null)} onClick={stop} hideChevron />
        </SubMenu>
    );
}
