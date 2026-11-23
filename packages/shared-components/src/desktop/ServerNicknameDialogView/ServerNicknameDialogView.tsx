/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, useId } from "react";
import { Button, Heading, InlineSpinner, Text, TextInput } from "@vector-im/compound-web";

import { _t } from "../../core/i18n/i18n";
import { useViewModel, type ViewModel } from "../../core/viewmodel";
import styles from "./ServerNicknameDialogView.module.css";

/** The longest nickname, as in Discord. */
export const SERVER_NICKNAME_MAX_LENGTH = 32;

/** What the nickname dialog shows. */
export interface ServerNicknameDialogViewSnapshot {
    /** Whether the user changes their own nickname, or a moderator someone else's. */
    forSelf: boolean;
    /** The person's name without a nickname, shown when the field is empty. */
    personName: string;
    /** The nickname as typed. */
    nickname: string;
    /** Whether there is a nickname to reset. */
    canReset: boolean;
    /** Whether a moderator gave the user their nickname, which wins over the one they choose until it is reset. */
    setByModerator: boolean;
    /** Whether the change is being sent. */
    busy: boolean;
    /** Why the last attempt failed. */
    error?: string;
}

/** What the nickname dialog's controls do. */
export interface ServerNicknameDialogViewActions {
    setNickname: (nickname: string) => void;
    /** Save the nickname, or reset it when the field is empty, and close the dialog once that is accepted. */
    save: () => void;
    /** Reset the nickname and close the dialog. */
    reset: () => void;
    cancel: () => void;
}

/** The view model behind the nickname dialog. */
export type ServerNicknameDialogViewModel = ViewModel<
    ServerNicknameDialogViewSnapshot,
    ServerNicknameDialogViewActions
>;

/**
 * Discord's "Change Nickname" dialog: a nickname that applies in one server. A moderator changing someone else's sees
 * Discord's warning first.
 */
export function ServerNicknameDialogView({ vm }: { vm: ServerNicknameDialogViewModel }): JSX.Element {
    const s = useViewModel(vm);
    const fieldId = useId();
    return (
        <form
            className={styles.dialog}
            onSubmit={(event) => {
                event.preventDefault();
                if (!s.busy) vm.save();
            }}
        >
            <Heading as="h2" size="md" weight="semibold" className={styles.title}>
                {_t("desktop|nickname_dialog|title")}
            </Heading>
            {!s.forSelf && (
                <Text as="p" size="sm" className={styles.warning}>
                    {_t("desktop|nickname_dialog|warning")}
                </Text>
            )}
            {s.forSelf && s.setByModerator && (
                <Text as="p" size="sm" className={styles.note}>
                    {_t("desktop|nickname_dialog|set_by_moderator")}
                </Text>
            )}
            <label className={styles.field} htmlFor={fieldId}>
                <Text as="span" size="sm" weight="semibold" className={styles.label}>
                    {_t("desktop|nickname_dialog|label")}
                </Text>
                <TextInput
                    id={fieldId}
                    value={s.nickname}
                    placeholder={s.personName}
                    onChange={(event) => vm.setNickname(event.target.value)}
                    disabled={s.busy}
                    autoFocus
                    autoComplete="off"
                    maxLength={SERVER_NICKNAME_MAX_LENGTH}
                />
            </label>
            {s.canReset && (
                <button type="button" className={styles.reset} onClick={vm.reset} disabled={s.busy}>
                    {_t("desktop|nickname_dialog|reset")}
                </button>
            )}
            {s.error && (
                <Text as="p" size="sm" role="alert" className={styles.error}>
                    {s.error}
                </Text>
            )}
            <div className={styles.actions}>
                <Button type="button" kind="tertiary" onClick={vm.cancel} disabled={s.busy}>
                    {_t("action|cancel")}
                </Button>
                <Button type="submit" kind="primary" disabled={s.busy}>
                    {s.busy && <InlineSpinner />}
                    {_t("action|save")}
                </Button>
            </div>
        </form>
    );
}
