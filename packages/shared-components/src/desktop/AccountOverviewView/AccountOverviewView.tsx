/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, type ReactNode, useId } from "react";
import { Button, H3, Text } from "@vector-im/compound-web";
import { ChevronRightIcon, PopOutIcon } from "@vector-im/compound-design-tokens/assets/web/icons";

import { type ViewModel, useViewModel } from "../../core/viewmodel";
import { useI18n } from "../../core/i18n/i18nContext";
import { DesktopProfileBanner, type DesktopProfileIdentitySnapshot } from "../DesktopProfileIdentity";
import styles from "./AccountOverviewView.module.css";

/** How the account's password can be changed from here. */
export type AccountPasswordMode =
    /** In this dialog. */
    | "change"
    /** On the account provider's site, which `accountManagementHost` names. */
    | "managed"
    /** Not at all: the server does not allow it. */
    | "none";

/** The account as the overview shows it. */
export interface AccountOverviewViewSnapshot {
    /** The user's own profile, drawn with the same banner and avatar others see. */
    identity: DesktopProfileIdentitySnapshot;
    /** Email addresses on the account. */
    emails: string[];
    /** Whether the server lets the user add or remove email addresses. */
    canChangeEmails: boolean;
    password: AccountPasswordMode;
    /** The host of the site where the account is managed, when it is managed elsewhere. */
    accountManagementHost?: string;
    /** How many sessions the account is signed in to, once known. */
    sessionCount?: number;
    /** Whether the account can be deactivated, here or on the account provider's site. */
    canDeactivate: boolean;
    /** Which inline editor is open under its row. */
    editing?: "email" | "password";
    /** Whether the user ID was just copied. */
    copied: boolean;
}

/** What the user can do from the account overview. */
export interface AccountOverviewViewActions {
    /** Opens the profile editor. */
    editProfile: () => void;
    copyUserId: () => void;
    /** Opens or closes the email editor. */
    toggleEmailEditor: () => void;
    /** Opens or closes the password form. */
    togglePasswordEditor: () => void;
    /** Opens the account provider's site. */
    manageAccount: () => void;
    /** Shows the list of sessions. */
    openSessions: () => void;
    deactivate: () => void;
}

/** View model contract for the account overview. */
export type AccountOverviewViewModel = ViewModel<AccountOverviewViewSnapshot, AccountOverviewViewActions>;

interface Props {
    vm: AccountOverviewViewModel;
    /** The email editor, shown under the email row while it is open. */
    emailEditor?: ReactNode;
    /** The password form, shown under the password row while it is open. */
    passwordEditor?: ReactNode;
}

interface RowProps {
    label: string;
    value?: ReactNode;
    action?: ReactNode;
    /** Makes the whole row a button. */
    onClick?: () => void;
    /** Shown under the row, inside the same card. */
    children?: ReactNode;
}

/** One line of a card: what it is, its current value, and what can be done with it. */
function Row({ label, value, action, onClick, children }: RowProps): JSX.Element {
    const main = (
        <span className={styles.rowMain}>
            <span className={styles.rowText}>
                <Text as="span" weight="semibold" className={styles.rowLabel}>
                    {label}
                </Text>
                {value !== undefined && (
                    <Text as="span" className={styles.rowValue}>
                        {value}
                    </Text>
                )}
            </span>
            {action}
        </span>
    );
    if (onClick) {
        return (
            <button type="button" className={`${styles.row} ${styles.rowButton}`} onClick={onClick}>
                {main}
            </button>
        );
    }
    return (
        <div className={styles.row}>
            {main}
            {children && <div className={styles.rowEditor}>{children}</div>}
        </div>
    );
}

/** A small heading over a card. */
function Caption({ id, children, critical }: { id: string; children: ReactNode; critical?: boolean }): JSX.Element {
    return (
        <H3 id={id} className={critical ? `${styles.caption} ${styles.captionCritical}` : styles.caption}>
            {children}
        </H3>
    );
}

/**
 * The top of the account settings: the user's profile card with their name, ID and email, how they sign in, and
 * the actions that cannot be undone.
 */
export function AccountOverviewView({ vm, emailEditor, passwordEditor }: Props): JSX.Element {
    const { translate: _t } = useI18n();
    const snapshot = useViewModel(vm);
    const { identity } = snapshot;
    const accessId = useId();
    const dangerId = useId();

    let passwordValue: string;
    let passwordAction: ReactNode;
    switch (snapshot.password) {
        case "managed":
            passwordValue = _t("desktop|account|password_managed", { host: snapshot.accountManagementHost ?? "" });
            passwordAction = (
                <Button size="md" kind="secondary" Icon={PopOutIcon} onClick={vm.manageAccount}>
                    {_t("desktop|account|manage_account")}
                </Button>
            );
            break;
        case "change":
            passwordValue = _t("desktop|account|password_change_description");
            passwordAction = (
                <Button
                    size="md"
                    kind="secondary"

                    aria-expanded={snapshot.editing === "password"}
                    onClick={vm.togglePasswordEditor}
                >
                    {snapshot.editing === "password" ? _t("action|cancel") : _t("desktop|account|change")}
                </Button>
            );
            break;
        case "none":
            passwordValue = _t("desktop|account|password_unavailable");
            break;
    }

    return (
        <div className={styles.view}>
            <section className={styles.card} aria-label={_t("desktop|account|profile_label")}>
                <DesktopProfileBanner identity={identity} size="popout" />
                <div className={styles.identity}>
                    <div className={styles.names}>
                        <Text as="span" size="lg" weight="semibold" className={styles.displayName}>
                            {identity.displayName}
                        </Text>
                        <Text as="span" className={styles.userId}>
                            {identity.userId}
                        </Text>
                    </div>
                    <Button size="md" kind="primary" onClick={vm.editProfile}>
                        {_t("desktop|account|edit_profile")}
                    </Button>
                </div>
                <Row
                    label={_t("desktop|account|display_name")}
                    value={identity.displayName}
                    action={
                        <Button size="md" kind="secondary" onClick={vm.editProfile}>
                            {_t("action|edit")}
                        </Button>
                    }
                />
                <Row
                    label={_t("desktop|account|username")}
                    value={<span className={styles.mono}>{identity.userId}</span>}
                    action={
                        <Button size="md" kind="secondary" onClick={vm.copyUserId}>
                            {snapshot.copied ? _t("desktop|account|copied") : _t("desktop|account|copy")}
                        </Button>
                    }
                />
                <Row
                    label={_t("desktop|account|email")}
                    value={snapshot.emails.length ? snapshot.emails.join(", ") : _t("desktop|account|email_none")}
                    action={
                        snapshot.canChangeEmails && (
                            <Button
                                size="md"
                                kind="secondary"

                                aria-expanded={snapshot.editing === "email"}
                                onClick={vm.toggleEmailEditor}
                            >
                                {snapshot.editing === "email"
                                    ? _t("desktop|account|done")
                                    : snapshot.emails.length
                                      ? _t("desktop|account|manage")
                                      : _t("desktop|account|add")}
                            </Button>
                        )
                    }
                >
                    {snapshot.editing === "email" && emailEditor}
                </Row>
            </section>

            <section aria-labelledby={accessId}>
                <Caption id={accessId}>{_t("desktop|account|access_heading")}</Caption>
                <div className={styles.card}>
                    <Row label={_t("desktop|account|password")} value={passwordValue} action={passwordAction}>
                        {snapshot.editing === "password" && passwordEditor}
                    </Row>
                    <Row
                        label={_t("desktop|account|sessions")}
                        value={
                            snapshot.sessionCount === undefined
                                ? _t("desktop|account|sessions_description")
                                : _t("desktop|account|sessions_count", { count: snapshot.sessionCount })
                        }
                        action={<ChevronRightIcon className={styles.chevron} aria-hidden="true" />}
                        onClick={vm.openSessions}
                    />
                </div>
            </section>

            {snapshot.canDeactivate && (
                <section aria-labelledby={dangerId}>
                    <Caption id={dangerId} critical>
                        {_t("desktop|account|danger_heading")}
                    </Caption>
                    <div className={`${styles.card} ${styles.critical}`}>
                        <Row
                            label={_t("desktop|account|deactivate")}
                            value={
                                snapshot.password === "managed"
                                    ? _t("desktop|account|deactivate_managed_description", {
                                          host: snapshot.accountManagementHost ?? "",
                                      })
                                    : _t("desktop|account|deactivate_description")
                            }
                            action={
                                <Button
                                    size="md"
                                    kind="secondary"
                                    destructive

                                    Icon={snapshot.password === "managed" ? PopOutIcon : undefined}
                                    onClick={vm.deactivate}
                                >
                                    {_t("desktop|account|deactivate_button")}
                                </Button>
                            }
                        />
                    </div>
                </section>
            )}
        </div>
    );
}
