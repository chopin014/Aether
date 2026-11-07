/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, useId } from "react";
import { Button, Heading, InlineSpinner, Text, TextInput } from "@vector-im/compound-web";

import { _t } from "../../core/i18n/i18n";
import { useViewModel, type ViewModel } from "../../core/viewmodel";
import styles from "./CategoryDialogView.module.css";

/** Longest category name, in characters, as in Discord. */
export const CATEGORY_NAME_MAX_LENGTH = 100;

export interface CategoryDialogViewSnapshot {
    /** Whether the dialog creates a category or renames one. */
    mode: "create" | "rename";
    /** The name as typed. */
    name: string;
    /** Whether the name can be saved: not empty once trimmed. */
    canSubmit: boolean;
    /** Whether the change is being sent. */
    busy: boolean;
    /** Why the last attempt failed. */
    error?: string;
}

export interface CategoryDialogViewActions {
    setName: (name: string) => void;
    /** Create or rename the category, closing the dialog once the server accepts it. */
    submit: () => void;
    cancel: () => void;
}

export type CategoryDialogViewModel = ViewModel<CategoryDialogViewSnapshot, CategoryDialogViewActions>;

/** Props for {@link CategoryDialogView}. */
export interface CategoryDialogViewProps {
    vm: CategoryDialogViewModel;
}

/** Name a new server category, or rename one, as in Discord's "Create category" dialog. */
export function CategoryDialogView({ vm }: CategoryDialogViewProps): JSX.Element {
    const s = useViewModel(vm);
    const nameId = useId();
    return (
        <form
            className={styles.dialog}
            onSubmit={(event) => {
                event.preventDefault();
                if (s.canSubmit && !s.busy) vm.submit();
            }}
        >
            <Heading as="h2" size="md" weight="semibold" className={styles.title}>
                {s.mode === "create"
                    ? _t("desktop|category_dialog|create_title")
                    : _t("desktop|category_dialog|rename_title")}
            </Heading>
            <label className={styles.field} htmlFor={nameId}>
                <Text as="span" size="sm" weight="semibold" className={styles.label}>
                    {_t("desktop|category_dialog|name_label")}
                </Text>
                <TextInput
                    id={nameId}
                    value={s.name}
                    placeholder={_t("desktop|category_dialog|name_placeholder")}
                    onChange={(event) => vm.setName(event.target.value)}
                    disabled={s.busy}
                    required
                    autoFocus
                    autoComplete="off"
                    maxLength={CATEGORY_NAME_MAX_LENGTH}
                />
            </label>
            {s.error && (
                <Text as="p" size="sm" role="alert" className={styles.error}>
                    {s.error}
                </Text>
            )}
            <div className={styles.actions}>
                <Button type="button" kind="tertiary" onClick={vm.cancel} disabled={s.busy}>
                    {_t("action|cancel")}
                </Button>
                <Button type="submit" kind="primary" disabled={!s.canSubmit || s.busy}>
                    {s.busy && <InlineSpinner />}
                    {s.mode === "create" ? _t("desktop|category_dialog|create") : _t("desktop|category_dialog|save")}
                </Button>
            </div>
        </form>
    );
}
