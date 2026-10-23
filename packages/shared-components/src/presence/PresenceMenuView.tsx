/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { MenuItem, MenuTitle, RadioMenuItem, SubMenu, Text } from "@vector-im/compound-web";

import { type ViewModel, useViewModel } from "../core/viewmodel";
import { useI18n } from "../core/i18n/i18nContext";
import styles from "./PresenceMenuView.module.css";

/** Matrix presence intent for this device; online includes automatic idle detection. */
export type PresencePreference = "online" | "unavailable" | "offline";

/** Requested presence and independently received server state. */
export interface PresenceSnapshot {
    enabled: boolean;
    preference: PresencePreference;
    current?: PresencePreference;
    busy: boolean;
    error?: string;
}

/** Changes are applied by the host, with explicit retry after a failed request. */
export type PresenceViewModel = ViewModel<
    PresenceSnapshot,
    {
        setPreference: (preference: PresencePreference) => Promise<void>;
        retry: () => Promise<void>;
    }
>;

/** Current server observation, also used in the account dock. No dot is shown for unknown status. */
export function PresenceSummaryView({
    vm,
    compact = false,
}: {
    vm: PresenceViewModel;
    compact?: boolean;
}): JSX.Element | null {
    const { enabled, current } = useViewModel(vm);
    const { translate: _t } = useI18n();
    const labels = {
        online: _t("presence_controls|online"),
        unavailable: _t("presence_controls|away"),
        offline: _t("presence_controls|offline"),
    };
    const label = !enabled
        ? _t("presence_controls|disabled_short")
        : current
          ? labels[current]
          : _t("presence_controls|unknown");
    if (compact)
        return enabled && current ? (
            <span className={styles.compactSummary} role="img" aria-label={label} title={label}>
                <span className={styles.dot} data-presence={current} />
            </span>
        ) : null;
    return (
        <Text as="span" size="xs" className={styles.summary}>
            {enabled && current && <span className={styles.dot} data-presence={current} aria-hidden="true" />}
            {!enabled
                ? _t("presence_controls|disabled_short")
                : current
                  ? labels[current]
                  : _t("presence_controls|unknown")}
        </Text>
    );
}

/** Presence radio actions inside the existing account menu, separate from the custom profile status. */
export function PresenceMenuView({ vm }: { vm: PresenceViewModel }): JSX.Element {
    const { enabled, preference, busy, error } = useViewModel(vm);
    const { translate: _t } = useI18n();
    const choices = {
        online: _t("presence_controls|automatic"),
        unavailable: _t("presence_controls|away"),
        offline: _t("presence_controls|invisible"),
    };
    return (
        <SubMenu
            trigger={
                <MenuItem
                    label={
                        enabled
                            ? _t("presence_controls|requested", { status: choices[preference] })
                            : _t("presence_controls|disabled_short")
                    }
                    onSelect={null}
                />
            }
        >
            <section className={styles.root} aria-label={_t("presence_controls|title")}>
                <MenuTitle title={_t("presence_controls|title")} />
                <div className={styles.description} role="status" aria-live="polite">
                    <PresenceSummaryView vm={vm} />
                    <Text as="span" size="xs">
                        {enabled ? _t("presence_controls|server_hint") : _t("presence_controls|disabled")}
                    </Text>
                </div>
                {enabled && (
                    <>
                        {(Object.keys(choices) as PresencePreference[]).map((value) => (
                            <RadioMenuItem
                                key={value}
                                label={choices[value]}
                                checked={preference === value}
                                disabled={busy}
                                onSelect={(event) => {
                                    event.preventDefault();
                                    void vm.setPreference(value);
                                }}
                            />
                        ))}
                        <Text as="p" size="xs" className={styles.description}>
                            {_t("presence_controls|requested", { status: choices[preference] })}
                            {busy && ` · ${_t("presence_controls|saving")}`}
                        </Text>
                        {error && (
                            <>
                                <Text as="p" size="xs" role="alert" className={styles.error}>
                                    {error}
                                </Text>
                                <MenuItem
                                    label={_t("presence_controls|retry")}
                                    disabled={busy}
                                    onSelect={(event) => {
                                        event.preventDefault();
                                        void vm.retry();
                                    }}
                                />
                            </>
                        )}
                    </>
                )}
            </section>
        </SubMenu>
    );
}
