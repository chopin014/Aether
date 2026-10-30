/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { Avatar } from "@vector-im/compound-web";
import { VolumeOnSolidIcon } from "@vector-im/compound-design-tokens/assets/web/icons";

import { useI18n } from "../../core/i18n/i18nContext";
import styles from "./ServerVoiceActivity.module.css";

/** Someone in one of a server's voice channels. */
export interface ServerVoiceActivityPerson {
    userId: string;
    name: string;
    avatarUrl?: string;
}

/** A voice channel of a server with people in it. */
export interface ServerVoiceActivityChannel {
    roomId: string;
    name: string;
    people: readonly ServerVoiceActivityPerson[];
}

/** Props for {@link ServerVoiceActivity}. */
export interface ServerVoiceActivityProps {
    /** The server's occupied voice channels, in the order to list them. */
    channels: readonly ServerVoiceActivityChannel[];
}

/** How many faces each channel shows before summing up the rest. */
const MAX_FACES = 5;

/**
 * Who is talking in a server, for the tooltip of its rail icon: each occupied voice channel with the faces of the
 * people in it, like Discord's server hover card.
 */
export function ServerVoiceActivity({ channels }: Readonly<ServerVoiceActivityProps>): JSX.Element {
    const { translate: _t } = useI18n();
    return (
        <span className={styles.activity}>
            {channels.map(({ roomId, name, people }) => (
                <span key={roomId} className={styles.channel}>
                    <span className={styles.channelName}>
                        <VolumeOnSolidIcon aria-hidden />
                        <span>{name}</span>
                    </span>
                    <span
                        className={styles.faces}
                        aria-label={_t("desktop|server_voice_activity|people", {
                            names: people.map((person) => person.name).join(", "),
                        })}
                    >
                        {people.slice(0, MAX_FACES).map((person) => (
                            <Avatar
                                key={person.userId}
                                className={styles.face}
                                id={person.userId}
                                name={person.name}
                                src={person.avatarUrl}
                                size="24px"
                                aria-hidden
                            />
                        ))}
                        {people.length > MAX_FACES && (
                            <span className={styles.more} aria-hidden>{`+${people.length - MAX_FACES}`}</span>
                        )}
                    </span>
                </span>
            ))}
        </span>
    );
}
