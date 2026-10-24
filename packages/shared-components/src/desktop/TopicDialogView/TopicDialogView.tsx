/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { Button, Heading } from "@vector-im/compound-web";
import { RoomIcon, VolumeOnIcon } from "@vector-im/compound-design-tokens/assets/web/icons";

import { _t } from "../../core/i18n/i18n";
import { useViewModel, type ViewModel } from "../../core/viewmodel";
import { LinkedText } from "../../core/utils/LinkedText";
import styles from "./TopicDialogView.module.css";

/** What the topic dialog shows. */
export interface TopicDialogViewSnapshot {
    /** The channel's name. */
    name: string;
    /** Whether this is a text or a voice channel. */
    kind: "text" | "voice";
    /** The full text of the topic. */
    topic: string;
    /** Whether the user may change the topic. */
    canEdit: boolean;
}

/** What the buttons of the topic dialog do. */
export interface TopicDialogViewActions {
    /** Open the settings where the topic is edited. */
    onEdit: () => void;
    /** Close the dialog. */
    onClose: () => void;
}

/** The view model behind the topic dialog. */
export type TopicDialogViewModel = ViewModel<TopicDialogViewSnapshot, TopicDialogViewActions>;

/** The body of the dialog that opens when the channel topic is clicked in the header. */
export function TopicDialogView({ vm }: { vm: TopicDialogViewModel }): JSX.Element {
    const { name, kind, topic, canEdit } = useViewModel(vm);
    const KindIcon = kind === "voice" ? VolumeOnIcon : RoomIcon;
    return (
        <div className={styles.dialog}>
            <Heading as="h2" size="md" weight="semibold" className={styles.title}>
                <KindIcon className={styles.symbol} aria-hidden />
                <span>{name}</span>
            </Heading>
            <p className={styles.label}>{_t("desktop|topic_dialog|label")}</p>
            <LinkedText as="p" className={styles.topic} dir="auto">
                {topic}
            </LinkedText>
            <div className={styles.actions}>
                <Button kind="tertiary" onClick={vm.onClose}>
                    {_t("action|close")}
                </Button>
                {canEdit && (
                    <Button kind="primary" onClick={vm.onEdit}>
                        {_t("desktop|topic_dialog|edit")}
                    </Button>
                )}
            </div>
        </div>
    );
}
