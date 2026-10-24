/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, useState } from "react";
import { Avatar, Button, Form, IconButton, Menu, MenuItem, Search, Text } from "@vector-im/compound-web";
import {
    ChatIcon,
    CheckIcon,
    CloseIcon,
    GroupIcon,
    OverflowHorizontalIcon,
    PlusIcon,
    SearchIcon,
} from "@vector-im/compound-design-tokens/assets/web/icons";
import classNames from "classnames";

import { useViewModel, type ViewModel } from "../../core/viewmodel";
import { useI18n } from "../../core/i18n/i18nContext";
import styles from "./DesktopContactsView.module.css";

/** The contacts tabs are backed by Matrix DMs, invitations and ignored users. */
export type DesktopContactsTab = "online" | "all" | "pending" | "blocked";

/** A contact or invitation, identified by its actual Matrix user and room IDs. */
export interface DesktopContact {
    userId: string;
    name: string;
    avatarUrl?: string;
    presence: "online" | "unavailable" | "offline" | "unknown";
    roomId?: string;
    invited?: boolean;
    blocked?: boolean;
}

/** Current contacts state. No synthetic activity or friend requests are displayed. */
export interface DesktopContactsViewSnapshot {
    tab: DesktopContactsTab;
    query: string;
    contacts: DesktopContact[];
    onlineContacts: DesktopContact[];
    pendingCount: number;
    busyIds: string[];
    error?: string;
}

/** Actions use the host's real Matrix and navigation services. */
export interface DesktopContactsViewActions {
    setTab: (tab: DesktopContactsTab) => void;
    setQuery: (query: string) => void;
    openHome: () => void;
    startChat: () => void;
    openConversation: (userId: string) => void;
    viewProfile: (userId: string) => void;
    acceptInvitation: (roomId: string) => Promise<void>;
    declineInvitation: (roomId: string) => Promise<void>;
    unblock: (userId: string) => Promise<void>;
}

/** Model contract shared by the contacts page and its sidebar navigation. */
export type DesktopContactsViewModel = ViewModel<DesktopContactsViewSnapshot, DesktopContactsViewActions>;

/** Home navigation above the existing Matrix conversation list. */
export function DesktopHomeNavigationView({ vm }: { vm: DesktopContactsViewModel }): JSX.Element {
    const { pendingCount } = useViewModel(vm);
    const { translate: _t } = useI18n();
    return (
        <div className={styles.navigation}>
            <button type="button" className={styles.friendsButton} onClick={vm.openHome}>
                <GroupIcon />
                {_t("desktop|contacts|friends")}
                {pendingCount > 0 && <span className={styles.badge}>{pendingCount}</span>}
            </button>
            <div className={styles.conversationsHeading}>
                <Text size="sm" weight="medium">
                    {_t("desktop|contacts|direct_messages")}
                </Text>
                <IconButton size="24px" tooltip={_t("desktop|contacts|new_message")} onClick={vm.startChat}>
                    <PlusIcon />
                </IconButton>
            </div>
        </div>
    );
}

/** Desktop contacts layout with real message, profile, invitation and unblock actions. */
export function DesktopContactsView({ vm }: { vm: DesktopContactsViewModel }): JSX.Element {
    const { tab, query, contacts, onlineContacts, pendingCount, busyIds, error } = useViewModel(vm);
    const [openMenu, setOpenMenu] = useState<string>();
    const { translate: _t } = useI18n();
    const tabLabels = {
        online: _t("desktop|contacts|online"),
        all: _t("desktop|contacts|all"),
        pending: _t("desktop|contacts|pending"),
        blocked: _t("desktop|contacts|blocked"),
    };
    const presenceLabels = {
        online: _t("desktop|contacts|online"),
        unavailable: _t("desktop|contacts|unavailable"),
        offline: _t("desktop|contacts|offline"),
        unknown: _t("presence_controls|unknown"),
    };
    return (
        <main className={styles.root} data-desktop-contacts>
            <header className={styles.header}>
                <div className={styles.title}>
                    <GroupIcon />
                    <Text weight="semibold">{_t("desktop|contacts|friends")}</Text>
                </div>
                <nav className={styles.tabs} aria-label={_t("desktop|contacts|friends")}>
                    {(Object.keys(tabLabels) as DesktopContactsTab[]).map((id) => (
                        <button
                            key={id}
                            type="button"
                            aria-current={tab === id ? "page" : undefined}
                            onClick={() => vm.setTab(id)}
                        >
                            {tabLabels[id]}
                            {id === "pending" && pendingCount > 0 && (
                                <span className={styles.badge}>{pendingCount}</span>
                            )}
                        </button>
                    ))}
                    <Button className={styles.addFriend} size="md" onClick={vm.startChat}>
                        {_t("desktop|contacts|add_friend")}
                    </Button>
                </nav>
                <IconButton tooltip={_t("desktop|contacts|new_message")} onClick={vm.startChat}>
                    <ChatIcon />
                </IconButton>
            </header>
            <div className={styles.body}>
                <section className={styles.contacts} aria-label={tabLabels[tab]}>
                    <Form.Root onSubmit={(event) => event.preventDefault()}>
                        <Search
                            className={styles.search}
                            name="contactsSearch"
                            placeholder={_t("desktop|contacts|search")}
                            aria-label={_t("desktop|contacts|search")}
                            value={query}
                            onChange={(event) => vm.setQuery(event.target.value)}
                        />
                    </Form.Root>
                    {error && (
                        <Text className={styles.error} role="alert">
                            {error}
                        </Text>
                    )}
                    <Text as="h2" size="sm" weight="semibold" className={styles.sectionTitle}>
                        {tabLabels[tab]} — {contacts.length}
                    </Text>
                    {contacts.length ? (
                        <ul className={styles.list}>
                            {contacts.map((contact) => (
                                <li key={contact.roomId ?? contact.userId} className={styles.contact}>
                                    <button
                                        aria-label={`${_t("desktop|contacts|profile")} ${contact.name}`}
                                        className={styles.identity}
                                        type="button"
                                        onClick={() => vm.viewProfile(contact.userId)}
                                    >
                                        <span className={styles.avatar}>
                                            <Avatar
                                                id={contact.userId}
                                                name={contact.name}
                                                src={contact.avatarUrl}
                                                size="32px"
                                                type="round"
                                            />
                                            {!contact.invited && !contact.blocked && contact.presence !== "unknown" && (
                                                <span className={styles.presence} data-presence={contact.presence} />
                                            )}
                                        </span>
                                        <span className={styles.names}>
                                            <Text weight="semibold">{contact.name}</Text>
                                            <Text size="sm" className={styles.subtitle}>
                                                {contact.invited
                                                    ? _t("desktop|contacts|incoming_request")
                                                    : contact.blocked
                                                      ? contact.userId
                                                      : presenceLabels[contact.presence]}
                                            </Text>
                                        </span>
                                    </button>
                                    <div className={styles.actions}>
                                        {contact.blocked ? (
                                            <Button
                                                kind="tertiary"
                                                size="md"
                                                disabled={busyIds.includes(contact.userId)}
                                                onClick={() => void vm.unblock(contact.userId)}
                                            >
                                                {_t("desktop|contacts|unblock")}
                                            </Button>
                                        ) : contact.invited && contact.roomId ? (
                                            <>
                                                <IconButton
                                                    tooltip={_t("desktop|contacts|accept")}
                                                    disabled={busyIds.includes(contact.roomId)}
                                                    onClick={() => void vm.acceptInvitation(contact.roomId!)}
                                                >
                                                    <CheckIcon />
                                                </IconButton>
                                                <IconButton
                                                    tooltip={_t("desktop|contacts|ignore")}
                                                    disabled={busyIds.includes(contact.roomId)}
                                                    onClick={() => void vm.declineInvitation(contact.roomId!)}
                                                >
                                                    <CloseIcon />
                                                </IconButton>
                                            </>
                                        ) : (
                                            <>
                                                <IconButton
                                                    tooltip={_t("desktop|contacts|message")}
                                                    onClick={() => vm.openConversation(contact.userId)}
                                                >
                                                    <ChatIcon />
                                                </IconButton>
                                                <Menu
                                                    open={openMenu === contact.userId}
                                                    onOpenChange={(open) =>
                                                        setOpenMenu(open ? contact.userId : undefined)
                                                    }
                                                    title={contact.name}
                                                    showTitle={false}
                                                    trigger={
                                                        <IconButton tooltip={_t("desktop|contacts|more")}>
                                                            <OverflowHorizontalIcon />
                                                        </IconButton>
                                                    }
                                                >
                                                    <MenuItem
                                                        onSelect={() => vm.viewProfile(contact.userId)}
                                                        label={_t("desktop|contacts|profile")}
                                                    />
                                                    <MenuItem
                                                        onSelect={() => vm.openConversation(contact.userId)}
                                                        label={_t("desktop|contacts|message")}
                                                    />
                                                </Menu>
                                            </>
                                        )}
                                    </div>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <div className={styles.empty}>
                            <SearchIcon />
                            <Text>{query ? _t("desktop|contacts|no_matches") : _t("desktop|contacts|empty")}</Text>
                        </div>
                    )}
                </section>
                <aside className={styles.activity} aria-label={_t("desktop|contacts|active_now")}>
                    <Text as="h2" size="lg" weight="bold">
                        {_t("desktop|contacts|active_now")}
                    </Text>
                    {onlineContacts.length ? (
                        onlineContacts.slice(0, 12).map((contact) => (
                            <button
                                key={contact.userId}
                                type="button"
                                className={classNames(styles.activityContact, styles.identity)}
                                onClick={() => vm.openConversation(contact.userId)}
                            >
                                <Avatar
                                    id={contact.userId}
                                    name={contact.name}
                                    src={contact.avatarUrl}
                                    size="32px"
                                    type="round"
                                />
                                <span className={styles.names}>
                                    <Text weight="semibold">{contact.name}</Text>
                                    <Text size="sm" className={styles.subtitle}>
                                        {presenceLabels[contact.presence]}
                                    </Text>
                                </span>
                            </button>
                        ))
                    ) : (
                        <div className={styles.quiet}>
                            <Text weight="semibold">{_t("desktop|contacts|quiet_title")}</Text>
                            <Text size="sm">{_t("desktop|contacts|quiet_description")}</Text>
                        </div>
                    )}
                </aside>
            </div>
        </main>
    );
}
