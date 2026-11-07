/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { Tooltip } from "@vector-im/compound-web";
import { AudioIcon, DeleteIcon, DocumentIcon, PlaySolidIcon } from "@vector-im/compound-design-tokens/assets/web/icons";

import { type ViewModel, useViewModel } from "../../../core/viewmodel";
import { useI18n } from "../../../core/i18n/i18nContext";
import { formatBytes } from "../../../core/utils/FormattingUtils";
import styles from "./AttachmentTrayView.module.css";

/** What kind of file an attachment is, which decides its preview. */
export type PendingAttachmentKind = "image" | "video" | "audio" | "file";

/** A file waiting in the composer to be sent with the next message. */
export interface PendingAttachment {
    /** Stable identity for the file while it waits. */
    id: string;
    /** The file's name. */
    name: string;
    /** The file's size, in bytes. */
    size: number;
    kind: PendingAttachmentKind;
    /** A local URL for a picture of the file, for images and videos. */
    previewUrl?: string;
}

export interface AttachmentTrayViewSnapshot {
    /** The files waiting to be sent, in the order they will be sent. */
    attachments: PendingAttachment[];
}

export interface AttachmentTrayViewActions {
    /** Takes a file out of the tray. */
    removeAttachment: (id: string) => void;
    /** Shows a waiting image at full size, before it is sent. */
    openAttachment: (id: string) => void;
}

export type AttachmentTrayViewModel = ViewModel<AttachmentTrayViewSnapshot, AttachmentTrayViewActions>;

interface AttachmentTrayViewProps {
    /** The view model holding the waiting files. */
    vm: AttachmentTrayViewModel;
}

function Preview({ attachment }: Readonly<{ attachment: PendingAttachment }>): JSX.Element {
    if (attachment.kind === "image" && attachment.previewUrl) {
        return <img className={styles.media} src={attachment.previewUrl} alt="" draggable={false} />;
    }
    if (attachment.kind === "video" && attachment.previewUrl) {
        return (
            <span className={styles.videoFrame}>
                {/* Only the first frame shows, as a still. */}
                <video className={styles.media} src={attachment.previewUrl} muted preload="metadata" />
                <PlaySolidIcon className={styles.videoBadge} aria-hidden={true} />
            </span>
        );
    }
    const Icon = attachment.kind === "audio" ? AudioIcon : DocumentIcon;
    return (
        <span className={styles.iconFrame}>
            <Icon className={styles.icon} aria-hidden={true} />
        </span>
    );
}

/**
 * The files waiting to go with the next message, shown above the composer's text: a picture of each, its name, and
 * a button that takes it out. Clicking a waiting image opens it at full size. Nothing is shown when the tray is empty.
 *
 * @example
 * ```tsx
 * <AttachmentTrayView vm={roomUploadViewModel} />
 * ```
 */
export function AttachmentTrayView({ vm }: Readonly<AttachmentTrayViewProps>): JSX.Element | null {
    const { translate: _t } = useI18n();
    const { attachments } = useViewModel(vm);
    if (attachments.length === 0) return null;

    return (
        <ul className={styles.tray} aria-label={_t("composer|attachments|label", { count: attachments.length })}>
            {attachments.map((attachment) => {
                const removeLabel = _t("composer|attachments|remove", { name: attachment.name });
                // Like Discord's, a waiting picture opens at full size when clicked, so it can be checked before sending.
                const viewable = attachment.kind === "image" && !!attachment.previewUrl;
                return (
                    <li key={attachment.id} className={styles.card}>
                        {viewable ? (
                            <button
                                type="button"
                                className={styles.open}
                                aria-label={_t("composer|attachments|view", { name: attachment.name })}
                                onClick={() => vm.openAttachment(attachment.id)}
                            >
                                <Preview attachment={attachment} />
                            </button>
                        ) : (
                            <Preview attachment={attachment} />
                        )}
                        <span className={styles.details}>
                            <span className={styles.name} title={attachment.name}>
                                {attachment.name}
                            </span>
                            <span className={styles.size}>{formatBytes(attachment.size, 1)}</span>
                        </span>
                        <Tooltip label={removeLabel}>
                            <button
                                type="button"
                                className={styles.remove}
                                aria-label={removeLabel}
                                onClick={() => vm.removeAttachment(attachment.id)}
                            >
                                <DeleteIcon aria-hidden={true} />
                            </button>
                        </Tooltip>
                    </li>
                );
            })}
        </ul>
    );
}
