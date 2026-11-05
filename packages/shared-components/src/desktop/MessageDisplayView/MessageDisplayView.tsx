/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { Text } from "@vector-im/compound-web";
import { CheckIcon } from "@vector-im/compound-design-tokens/assets/web/icons";

import { type ViewModel, useViewModel } from "../../core/viewmodel";
import { useI18n } from "../../core/i18n/i18nContext";
import styles from "./MessageDisplayView.module.css";

/** How messages are laid out: roomy with avatars, or one line per message. */
export type MessageDisplay = "cozy" | "compact";

export interface MessageDisplayViewSnapshot {
    /** The layout in use. */
    display: MessageDisplay;
    /** The space between one person's messages and the next person's, in pixels. */
    groupSpacing: number;
    /** The spacings to choose from, in pixels. */
    groupSpacingOptions: number[];
}

export interface MessageDisplayViewActions {
    /** Switch layout. */
    setDisplay: (display: MessageDisplay) => void;
    /** Change the space between message groups. */
    setGroupSpacing: (spacing: number) => void;
}

export type MessageDisplayViewModel = ViewModel<MessageDisplayViewSnapshot, MessageDisplayViewActions>;

interface MessageDisplayViewProps {
    /** The view model holding the choices and saving them. */
    vm: MessageDisplayViewModel;
}

/** A miniature of a conversation in each layout. */
function DisplayPreview({ display }: Readonly<{ display: MessageDisplay }>): JSX.Element {
    if (display === "cozy") {
        return (
            <span className={styles.preview} aria-hidden="true">
                {[0, 1].map((group) => (
                    <span key={group} className={styles.cozyGroup}>
                        <span className={styles.avatar} />
                        <span className={styles.lines}>
                            <span className={styles.name} />
                            <span className={styles.line} />
                            <span className={styles.line} data-short="true" />
                        </span>
                    </span>
                ))}
            </span>
        );
    }
    return (
        <span className={styles.preview} aria-hidden="true">
            {[0, 1, 2, 3].map((row) => (
                <span key={row} className={styles.compactRow}>
                    <span className={styles.time} />
                    <span className={styles.name} />
                    <span className={styles.line} data-short={row % 2 === 1 ? "true" : undefined} />
                </span>
            ))}
        </span>
    );
}

/**
 * Lets a person choose how messages are laid out in the timeline, and how far apart message groups sit.
 *
 * @example
 * ```tsx
 * <MessageDisplayView vm={messageDisplayViewModel} />
 * ```
 */
export function MessageDisplayView({ vm }: Readonly<MessageDisplayViewProps>): JSX.Element {
    const { translate: _t } = useI18n();
    const { display, groupSpacing, groupSpacingOptions } = useViewModel(vm);

    const displays: { id: MessageDisplay; name: string; description: string }[] = [
        {
            id: "cozy",
            name: _t("desktop|message_display|cozy"),
            description: _t("desktop|message_display|cozy_description"),
        },
        {
            id: "compact",
            name: _t("desktop|message_display|compact"),
            description: _t("desktop|message_display|compact_description"),
        },
    ];

    return (
        <section className={styles.root} data-testid="messageDisplayPanel">
            <Text as="h3" size="lg" weight="semibold" className={styles.heading}>
                {_t("desktop|message_display|title")}
            </Text>
            <div className={styles.displays} role="radiogroup" aria-label={_t("desktop|message_display|title")}>
                {displays.map((option) => (
                    <label key={option.id} className={styles.tile} data-selected={option.id === display}>
                        <input
                            type="radio"
                            name="messageDisplay"
                            className={styles.visuallyHidden}
                            value={option.id}
                            checked={option.id === display}
                            onChange={() => vm.setDisplay(option.id)}
                        />
                        <DisplayPreview display={option.id} />
                        <span className={styles.label}>
                            <span className={styles.labelText}>
                                <span className={styles.labelName}>{option.name}</span>
                                <span className={styles.labelDescription}>{option.description}</span>
                            </span>
                            {option.id === display && <CheckIcon className={styles.check} aria-hidden={true} />}
                        </span>
                    </label>
                ))}
            </div>
            <div>
                <Text as="div" size="sm" weight="medium" className={styles.groupTitle} id="messageGroupSpacingTitle">
                    {_t("desktop|message_display|group_spacing")}
                </Text>
                <div className={styles.spacings} role="radiogroup" aria-labelledby="messageGroupSpacingTitle">
                    {groupSpacingOptions.map((spacing) => (
                        <label key={spacing} className={styles.spacing} data-selected={spacing === groupSpacing}>
                            <input
                                type="radio"
                                name="messageGroupSpacing"
                                className={styles.visuallyHidden}
                                value={spacing}
                                checked={spacing === groupSpacing}
                                onChange={() => vm.setGroupSpacing(spacing)}
                            />
                            {_t("desktop|message_display|group_spacing_value", { size: spacing })}
                        </label>
                    ))}
                </div>
            </div>
        </section>
    );
}
