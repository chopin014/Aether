/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, type ReactNode } from "react";
import { ChevronDownIcon } from "@vector-im/compound-design-tokens/assets/web/icons";
import { H3, ToggleInput } from "@vector-im/compound-web";
import classNames from "classnames";

import styles from "./DesktopVoiceVideoSettingsView.module.css";

interface ToggleRowProps {
    /** Used to tie the label and description to the switch. */
    id: string;
    label: string;
    description?: string;
    checked: boolean;
    disabled?: boolean;
    onChange: (checked: boolean) => void;
}

/** A setting with its name and explanation on the left and a switch on the right. */
export function ToggleRow({ id, label, description, checked, disabled, onChange }: ToggleRowProps): JSX.Element {
    return (
        <div className={styles.row}>
            <div className={styles.rowText}>
                <label className={styles.rowLabel} htmlFor={id}>
                    {label}
                </label>
                {description && (
                    <p className={styles.description} id={`${id}-description`}>
                        {description}
                    </p>
                )}
            </div>
            <ToggleInput
                id={id}
                checked={checked}
                disabled={disabled}
                aria-describedby={description ? `${id}-description` : undefined}
                onChange={(event) => onChange(event.target.checked)}
            />
        </div>
    );
}

interface ExpanderProps {
    id: string;
    title: string;
    description: string;
    expanded: boolean;
    onToggle: () => void;
    children: ReactNode;
}

/** A row that shows more settings below it when its chevron is pressed. */
export function Expander({ id, title, description, expanded, onToggle, children }: ExpanderProps): JSX.Element {
    return (
        <div>
            <div className={styles.row}>
                <div className={styles.rowText}>
                    <H3 className={styles.rowLabel}>{title}</H3>
                    <p className={styles.description}>{description}</p>
                </div>
                <button
                    type="button"
                    className={classNames(styles.chevron, expanded && styles.chevronOpen)}
                    aria-expanded={expanded}
                    aria-controls={id}
                    aria-label={title}
                    onClick={onToggle}
                >
                    <ChevronDownIcon />
                </button>
            </div>
            {expanded && (
                <div id={id} className={styles.expanded}>
                    {children}
                </div>
            )}
        </div>
    );
}
