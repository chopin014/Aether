/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, useId } from "react";
import { RoomIcon, VolumeOnIcon } from "@vector-im/compound-design-tokens/assets/web/icons";

import { _t } from "../../core/i18n/i18n";
import styles from "./ChannelKindPicker.module.css";

/** The kinds of channel a Space can hold: a text room, or a voice room that joins a call when opened. */
export type ChannelKind = "text" | "voice";

/**
 * Props for {@link ChannelKindPicker}.
 */
export interface ChannelKindPickerProps {
    /** The selected kind. */
    value: ChannelKind;
    /** Called with the kind the user picks. */
    onChange: (kind: ChannelKind) => void;
}

/**
 * Lets the user choose whether a new channel is a text or a voice channel, as a group of radio cards that show the
 * same symbol the channel will have in the room list.
 */
export function ChannelKindPicker({ value, onChange }: Readonly<ChannelKindPickerProps>): JSX.Element {
    const name = useId();
    const headingId = useId();
    const kinds = [
        {
            kind: "text",
            Icon: RoomIcon,
            label: _t("desktop|channel_kind|text"),
            description: _t("desktop|channel_kind|text_description"),
        },
        {
            kind: "voice",
            Icon: VolumeOnIcon,
            label: _t("desktop|channel_kind|voice"),
            description: _t("desktop|channel_kind|voice_description"),
        },
    ] as const;
    return (
        <div className={styles.picker} role="radiogroup" aria-labelledby={headingId}>
            <span id={headingId} className={styles.heading}>
                {_t("desktop|channel_kind|title")}
            </span>
            {kinds.map(({ kind, Icon, label, description }) => (
                <label key={kind} className={styles.option}>
                    <input
                        className={styles.input}
                        type="radio"
                        name={name}
                        value={kind}
                        checked={value === kind}
                        onChange={() => onChange(kind)}
                        aria-labelledby={`${name}-${kind}-label`}
                        aria-describedby={`${name}-${kind}-description`}
                    />
                    <span className={styles.symbol} aria-hidden>
                        <Icon />
                    </span>
                    <span className={styles.text}>
                        <span id={`${name}-${kind}-label`} className={styles.label}>
                            {label}
                        </span>
                        <span id={`${name}-${kind}-description`} className={styles.description}>
                            {description}
                        </span>
                    </span>
                    <span className={styles.indicator} aria-hidden />
                </label>
            ))}
        </div>
    );
}
