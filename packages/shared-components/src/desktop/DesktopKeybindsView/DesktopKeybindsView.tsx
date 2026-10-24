/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { H3, Text, Button } from "@vector-im/compound-web";

import { useViewModel, type ViewModel } from "../../core/viewmodel";
import { useI18n } from "../../core/i18n/i18nContext";
import styles from "./DesktopKeybindsView.module.css";

/** A configurable action, its current binding and registration feedback. */
export interface DesktopKeybindRow {
    id: string;
    label: string;
    key: string;
    status: string;
}
/** Shortcut settings state. */
export interface DesktopKeybindsSnapshot {
    rows: DesktopKeybindRow[];
    recording?: string;
    description: string;
    error?: string;
}
/** Shortcut recording and clearing actions. */
export interface DesktopKeybindsActions {
    record: (id: string) => void;
    clear: (id: string) => void;
}
/** Presentation contract for compact keyboard settings. */
export type DesktopKeybindsViewModel = ViewModel<DesktopKeybindsSnapshot, DesktopKeybindsActions>;

/** Lists configurable call shortcuts. The model owns recording and registration. */
export function DesktopKeybindsView({ vm }: { vm: DesktopKeybindsViewModel }): JSX.Element {
    const { rows, recording, description, error } = useViewModel(vm);
    const { translate: _t } = useI18n();
    return (
        <section className={styles.section} aria-label={_t("desktop|keybinds|title")}>
            <H3>{_t("desktop|keybinds|title")}</H3>
            <Text as="p" size="sm">
                {description}
            </Text>
            <Text as="p" size="sm">
                {_t("desktop|keybinds|ptt_hint")}
            </Text>
            {rows.map((row) => (
                <div className={styles.row} key={row.id}>
                    <div className={styles.label}>
                        <Text id={`keybind-${row.id}`} as="span" size="md">
                            {row.label}
                        </Text>
                        <Text as="span" size="sm" className={styles.status}>
                            {row.status}
                        </Text>
                    </div>
                    <Button
                        size="md"
                        kind="secondary"
                        aria-labelledby={`keybind-${row.id} binding-${row.id}`}
                        aria-pressed={recording === row.id}
                        onClick={() => vm.record(row.id)}
                    >
                        <span id={`binding-${row.id}`}>
                            {recording === row.id
                                ? _t("desktop|keybinds|recording")
                                : row.key || _t("desktop|keybinds|record")}
                        </span>
                    </Button>
                    <Button
                        size="md"
                        kind="tertiary"
                        disabled={!row.key}
                        aria-label={_t("desktop|keybinds|clear_action", { action: row.label })}
                        onClick={() => vm.clear(row.id)}
                    >
                        {_t("action|clear")}
                    </Button>
                </div>
            ))}
            <div role="status" aria-live="polite">
                {error}
            </div>
        </section>
    );
}
