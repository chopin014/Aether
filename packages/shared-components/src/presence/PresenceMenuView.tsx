/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { MenuItem, SubMenu, Text } from "@vector-im/compound-web";
import { CheckIcon } from "@vector-im/compound-design-tokens/assets/web/icons";
import classNames from "classnames";

import { type ViewModel, useViewModel } from "../core/viewmodel";
import { useI18n } from "../core/i18n/i18nContext";
import { PresenceGlyph } from "./PresenceGlyph";
import styles from "./PresenceMenuView.module.css";

/** Matrix presence intent for this device; online includes automatic idle detection. */
export type PresencePreference = "online" | "unavailable" | "offline";

/** Requested presence and independently received server state. */
export interface PresenceSnapshot {
    enabled: boolean;
    preference: PresencePreference;
    /** This device's effective intent, including automatic idle, when the host exposes it. */
    desired?: PresencePreference;
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

/** This device's effective status, falling back to received idle state for older hosts. */
export function PresenceSummaryView({
    vm,
    compact = false,
}: {
    vm: PresenceViewModel;
    compact?: boolean;
}): JSX.Element {
    const { enabled, preference, desired, current } = useViewModel(vm);
    const { translate: _t } = useI18n();
    const labels = {
        online: _t("presence_controls|online"),
        unavailable: _t("presence_controls|away"),
        offline: _t("presence_controls|invisible"),
    };
    const status = desired ?? (preference === "online" && current === "unavailable" ? current : preference);
    const label = enabled ? labels[status] : _t("presence_controls|disabled_short");
    const detail = !enabled
        ? _t("presence_controls|disabled")
        : !current
          ? _t("presence_controls|unknown_hint")
          : _t("presence_controls|selected_hint");
    if (compact)
        return (
            <span className={styles.compactSummary} role="img" aria-label={label} title={`${label} · ${detail}`}>
                <PresenceIcon status={enabled ? status : undefined} />
            </span>
        );
    return (
        <Text as="span" size="xs" className={styles.summary} title={detail}>
            {label}
        </Text>
    );
}

function PresenceIcon({
    status,
    ...props
}: React.SVGProps<SVGSVGElement> & { status?: PresencePreference }): JSX.Element {
    return <PresenceGlyph {...props} status={status} className={classNames(styles.dot, props.className)} />;
}

/** Presence radio actions inside the existing account menu, separate from the custom profile status. */
export function PresenceMenuView({ vm }: { vm: PresenceViewModel }): JSX.Element {
    const { enabled, preference, busy, error } = useViewModel(vm);
    const { translate: _t } = useI18n();
    const choices = {
        online: _t("presence_controls|online"),
        unavailable: _t("presence_controls|away"),
        offline: _t("presence_controls|invisible"),
    };
    return (
        <SubMenu
            trigger={
                <MenuItem
                    className={styles.trigger}
                    Icon={<PresenceIcon status={enabled ? preference : undefined} />}
                    label={enabled ? choices[preference] : _t("presence_controls|disabled_short")}
                    onSelect={null}
                />
            }
        >
            <section className={styles.root} aria-label={_t("presence_controls|title")}>
                {!enabled && (
                    <Text as="p" size="sm" className={styles.description}>
                        {_t("presence_controls|disabled")}
                    </Text>
                )}
                {enabled && (
                    <>
                        {(Object.keys(choices) as PresencePreference[]).map((value) => (
                            <MenuItem
                                key={value}
                                as="div"
                                role="menuitemradio"
                                aria-checked={preference === value}
                                Icon={<PresenceIcon status={value} />}
                                label={choices[value]}
                                className={styles.choice}
                                disabled={busy}
                                onSelect={(event) => {
                                    event.preventDefault();
                                    void vm.setPreference(value);
                                }}
                            >
                                {preference === value && <CheckIcon className={styles.check} aria-hidden="true" />}
                            </MenuItem>
                        ))}
                        {busy && (
                            <Text as="p" size="xs" role="status" className={styles.description}>
                                {_t("presence_controls|saving")}
                            </Text>
                        )}
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
