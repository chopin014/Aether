/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { Button, InlineSpinner, Text } from "@vector-im/compound-web";

import { useViewModel, type ViewModel } from "../../core/viewmodel";
import { _t } from "../../core/i18n/i18n";
import styles from "./DeleteChannelView.module.css";

/** Confirmation, progress and recovery state for deleting a channel. */
export interface DeleteChannelViewSnapshot {
    /** The name of the channel being removed. */
    name: string;
    /** Whether deletion is in progress. */
    busy: boolean;
    /** The current operation, announced as progress. */
    progress?: string;
    /** A recoverable failure, including what has already happened. */
    error?: string;
    /** Whether deletion reached the final step of forgetting the room. */
    left: boolean;
}

/** The actions in the deletion confirmation. */
export interface DeleteChannelViewActions {
    /** Start deletion, or resume after a failed operation. */
    confirm: () => void;
    /** Dismiss the confirmation when no operation is running. */
    cancel: () => void;
}

/** The model behind a channel deletion confirmation. */
export type DeleteChannelViewModel = ViewModel<DeleteChannelViewSnapshot, DeleteChannelViewActions>;

/** Confirmation content; the host supplies the dialog and its accessible title. */
export function DeleteChannelView({
    vm,
}: {
    /** The confirmation's view model. */ vm: DeleteChannelViewModel;
}): JSX.Element {
    const { name, busy, progress, error, left } = useViewModel(vm);
    return (
        <div className={styles.content} aria-busy={busy}>
            <Text as="p">{_t("desktop|delete_channel|description", { name })}</Text>
            <Text as="p" size="sm" className={styles.note}>
                {_t("desktop|delete_channel|history_note")}
            </Text>
            {error && (
                <Text as="p" role="alert" className={styles.error}>
                    {error}
                </Text>
            )}
            <div role="status" className={styles.progress}>
                {busy && <InlineSpinner />}
                {busy && progress}
            </div>
            <div className={styles.actions}>
                <Button kind="secondary" onClick={vm.cancel} disabled={busy} autoFocus>
                    {_t("action|cancel")}
                </Button>
                <Button kind="destructive" onClick={vm.confirm} disabled={busy}>
                    {error ? _t("action|retry") : _t("desktop|delete_channel|delete")}
                </Button>
            </div>
            {left && (
                <Text as="p" size="sm">
                    {_t("desktop|delete_channel|left_note")}
                </Text>
            )}
        </div>
    );
}
