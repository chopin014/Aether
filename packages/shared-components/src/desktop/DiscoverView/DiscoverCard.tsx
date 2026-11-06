/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, useState } from "react";
import { Avatar, Text } from "@vector-im/compound-web";
import { CheckIcon } from "@vector-im/compound-design-tokens/assets/web/icons";

import { useI18n } from "../../core/i18n/i18nContext";
import type { DiscoverEntry } from "./DiscoverView";
import styles from "./DiscoverView.module.css";

/** Number of Compound decorative colours a card without an avatar can take. */
const DECORATIVE_COLOURS = 6;

/** Picks a stable decorative colour so a community keeps the same banner between visits. */
function decorativeColour(roomId: string): number {
    let hash = 0;
    for (const char of roomId) hash = (hash * 31 + char.charCodeAt(0)) | 0;
    return (Math.abs(hash) % DECORATIVE_COLOURS) + 1;
}

/** Props for {@link DiscoverCard}. */
interface DiscoverCardProps {
    entry: DiscoverEntry;
    /** Language used to format the member count. */
    language: string;
    onOpen: (roomId: string) => void;
}

/** A community card: banner from the avatar, name, topic and member count. */
export function DiscoverCard({ entry, language, onOpen }: DiscoverCardProps): JSX.Element {
    const { translate: _t } = useI18n();
    // The banner and the avatar share one image, so a failed load falls back to initials and colour for both.
    const [imageFailed, setImageFailed] = useState(false);
    const members = new Intl.NumberFormat(language).format(entry.memberCount);
    const imageUrl = imageFailed ? undefined : entry.avatarUrl;

    return (
        <button
            type="button"
            className={styles.card}
            onClick={() => onOpen(entry.roomId)}
            aria-label={entry.name}
            aria-describedby={`mx_DiscoverCard_${entry.roomId}_details`}
        >
            <span className={styles.banner} data-colour={decorativeColour(entry.roomId)} aria-hidden>
                {imageUrl && (
                    <img className={styles.bannerImage} src={imageUrl} alt="" onError={() => setImageFailed(true)} />
                )}
            </span>
            <span className={styles.cardAvatar} aria-hidden>
                <Avatar id={entry.roomId} name={entry.name} src={imageUrl} size="48px" type="square" />
            </span>
            <span className={styles.cardBody} id={`mx_DiscoverCard_${entry.roomId}_details`}>
                <Text as="span" weight="semibold" className={styles.cardName}>
                    {entry.name}
                </Text>
                {entry.topic && (
                    <Text as="span" size="sm" className={styles.cardTopic}>
                        {entry.topic}
                    </Text>
                )}
                <span className={styles.cardFooter}>
                    <Text as="span" size="xs" className={styles.members}>
                        <span className={styles.membersDot} />
                        {_t("desktop|discover|members", { count: entry.memberCount, formattedCount: members })}
                    </Text>
                    {entry.joined && (
                        <Text as="span" size="xs" weight="semibold" className={styles.joined}>
                            <CheckIcon />
                            {_t("desktop|discover|joined")}
                        </Text>
                    )}
                </span>
            </span>
        </button>
    );
}
