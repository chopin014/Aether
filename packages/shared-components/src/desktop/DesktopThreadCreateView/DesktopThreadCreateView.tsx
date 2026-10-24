/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { Button, Text } from "@vector-im/compound-web";

import { type ViewModel, useViewModel } from "../../core/viewmodel";
import { useI18n } from "../../core/i18n/i18nContext";
import { Flex } from "../../core/utils/Flex";
import styles from "./DesktopThreadCreateView.module.css";

/** A draft of a normal room message and its first thread reply. */
export interface DesktopThreadCreateSnapshot {
    starter: string;
    reply: string;
    sending: boolean;
    locked: boolean;
    starterSent: boolean;
    error: boolean;
}

/** Actions for committing a native Matrix thread without duplicate messages on retry. */
export interface DesktopThreadCreateActions {
    setStarter: (value: string) => void;
    setReply: (value: string) => void;
    submit: () => Promise<void>;
    cancel: () => void;
}

/** Model for the starter and initial reply form. */
export type DesktopThreadCreateModel = ViewModel<DesktopThreadCreateSnapshot, DesktopThreadCreateActions>;

/** Creates a root and first reply only when the user submits both fields. */
export function DesktopThreadCreateView({ vm }: { vm: DesktopThreadCreateModel }): JSX.Element {
    const { translate: _t } = useI18n();
    const { starter, reply, sending, locked, starterSent, error } = useViewModel(vm);
    return (
        <form
            className={styles.form}
            onSubmit={(event) => {
                event.preventDefault();
                void vm.submit();
            }}
            aria-label={_t("desktop|threads|create")}
            aria-busy={sending}
        >
            <Text as="h2" size="lg" weight="semibold">
                {_t("desktop|threads|create")}
            </Text>
            <Text className={styles.description}>{_t("desktop|threads|create_description")}</Text>
            <label className={styles.field}>
                <Text weight="medium">{_t("desktop|threads|starter")}</Text>
                <textarea
                    autoFocus
                    required
                    value={starter}
                    disabled={locked}
                    onChange={(event) => vm.setStarter(event.target.value)}
                    rows={2}
                />
            </label>
            <label className={styles.field}>
                <Text weight="medium">{_t("desktop|threads|first_reply")}</Text>
                <textarea
                    required
                    value={reply}
                    disabled={locked}
                    onChange={(event) => vm.setReply(event.target.value)}
                    rows={4}
                />
            </label>
            {starterSent && error && <Text role="status">{_t("desktop|threads|starter_sent")}</Text>}
            {error && <Text role="alert">{_t("desktop|threads|send_error")}</Text>}
            <Flex justify="end" gap="var(--cpd-space-2x)">
                <Button type="button" size="md" kind="secondary" disabled={sending} onClick={vm.cancel}>
                    {_t("action|cancel")}
                </Button>
                <Button type="submit" size="md" disabled={sending || !starter.trim() || !reply.trim()}>
                    {sending
                        ? _t("desktop|threads|sending")
                        : error
                          ? _t("action|retry")
                          : _t("desktop|threads|create")}
                </Button>
            </Flex>
        </form>
    );
}
