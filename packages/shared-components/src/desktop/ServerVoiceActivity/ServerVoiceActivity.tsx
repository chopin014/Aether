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

/** The server a {@link ServerVoiceActivity} card is about. */
export interface ServerVoiceActivityServer {
    /** The server's ID, which picks the colour of its placeholder icon. */
    id: string;
    name: string;
    /** The server's icon, if it has one. */
    avatarUrl?: string;
}

/** Props for {@link ServerVoiceActivity}. */
export interface ServerVoiceActivityProps {
    /** The server being hovered. */
    server: ServerVoiceActivityServer;
    /** The server's occupied voice channels, in the order to list them. */
    channels: readonly ServerVoiceActivityChannel[];
}

/** How many faces the card shows before summing up the rest. */
const MAX_FACES = 5;

/**
 * The hover card of a server's rail icon while people are talking in it, like Discord's: the server's icon and name,
 * then the faces of everyone in its voice channels.
 *
 * Marked with `data-server-hover-card` so the tooltip that shows it can take on the card's look.
 */
export function ServerVoiceActivity({ server, channels }: Readonly<ServerVoiceActivityProps>): JSX.Element {
    const { translate: _t } = useI18n();
    // Someone with a device in two channels shows once.
    const people = [
        ...new Map(channels.flatMap((channel) => channel.people).map((person) => [person.userId, person])).values(),
    ];
    const label = _t("desktop|server_voice_activity|people", {
        names: channels.map((channel) => `${channel.name}: ${channel.people.map((p) => p.name).join(", ")}`).join("; "),
    });

    return (
        <span className={styles.card} data-server-hover-card="">
            <span className={styles.header}>
                <Avatar
                    className={styles.serverIcon}
                    id={server.id}
                    name={server.name}
                    src={server.avatarUrl}
                    type="square"
                    size="24px"
                    aria-hidden
                />
                <span className={styles.serverName}>{server.name}</span>
            </span>
            <span className={styles.voice} aria-label={label}>
                <VolumeOnSolidIcon className={styles.speaker} aria-hidden />
                <span className={styles.faces}>
                    {people.slice(0, MAX_FACES).map((person) => (
                        <Avatar
                            key={person.userId}
                            className={styles.face}
                            id={person.userId}
                            name={person.name}
                            src={person.avatarUrl}
                            size="32px"
                            aria-hidden
                        />
                    ))}
                    {people.length > MAX_FACES && (
                        <span className={styles.more} aria-hidden>{`+${people.length - MAX_FACES}`}</span>
                    )}
                </span>
            </span>
        </span>
    );
}
