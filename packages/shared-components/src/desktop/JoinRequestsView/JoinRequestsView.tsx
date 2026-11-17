/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { Avatar, IconButton, Text } from "@vector-im/compound-web";
import { CheckIcon, ChevronDownIcon, CloseIcon } from "@vector-im/compound-design-tokens/assets/web/icons";
import classNames from "classnames";

import { useViewModel, type ViewModel } from "../../core/viewmodel";
import { _t } from "../../core/i18n/i18n";
import styles from "./JoinRequestsView.module.css";

/** Someone who asked to join a server. */
export interface JoinRequest {
    /** Their Matrix user ID. */
    userId: string;
    /** Their display name, or the user ID when they have none. */
    name: string;
    /** A thumbnail of their avatar. */
    avatarUrl?: string;
    /** The message they sent with the request. */
    reason?: string;
}

/** What the list of requests to join shows. */
export interface JoinRequestsViewSnapshot {
    /** The people waiting for an answer, oldest first. Nothing is shown when there are none. */
    requests: JoinRequest[];
    /** Whether the list is open; when closed only the count shows. */
    expanded: boolean;
    /** Whether the user may turn requests down, which needs more power than letting people in. */
    canDecline: boolean;
    /** The users whose request is being answered right now. */
    busyIds: string[];
    /** Why the last answer failed. */
    error?: string;
}

/** The actions of the list of requests to join. */
export interface JoinRequestsViewActions {
    /** Open or close the list. */
    toggle: () => void;
    /** Let someone in. */
    approve: (userId: string) => void;
    /** Turn someone's request down. */
    decline: (userId: string) => void;
}

/** The model behind the list of requests to join. */
export type JoinRequestsViewModel = ViewModel<JoinRequestsViewSnapshot, JoinRequestsViewActions>;

/**
 * The people asking to join a server, shown above its channels to the members who can let them in, with a button
 * to let each one in or turn them down.
 */
export function JoinRequestsView({
    vm,
}: {
    /** The list's model. */
    vm: JoinRequestsViewModel;
}): JSX.Element | null {
    const { requests, expanded, canDecline, busyIds, error } = useViewModel(vm);
    if (!requests.length) return null;

    const listId = "join-requests-list";
    return (
        <section className={styles.requests} aria-label={_t("desktop|join_requests|label")}>
            <button
                type="button"
                className={styles.header}
                aria-expanded={expanded}
                aria-controls={listId}
                onClick={vm.toggle}
            >
                <span className={styles.count}>{requests.length}</span>
                <Text as="span" size="sm" weight="semibold" className={styles.title}>
                    {_t("desktop|join_requests|title", { count: requests.length })}
                </Text>
                <ChevronDownIcon className={classNames(styles.chevron, { [styles.open]: expanded })} />
            </button>
            {expanded && (
                <ul id={listId} className={styles.list}>
                    {requests.map((request) => {
                        const busy = busyIds.includes(request.userId);
                        return (
                            <li key={request.userId} className={styles.request}>
                                <Avatar
                                    id={request.userId}
                                    name={request.name}
                                    src={request.avatarUrl}
                                    size="32px"
                                    type="round"
                                />
                                <span className={styles.names}>
                                    <Text as="span" size="sm" weight="semibold" className={styles.line}>
                                        {request.name}
                                    </Text>
                                    <Text as="span" size="xs" className={styles.subtitle}>
                                        {request.userId}
                                    </Text>
                                    {request.reason && (
                                        <Text as="span" size="xs" className={styles.reason}>
                                            “{request.reason}”
                                        </Text>
                                    )}
                                </span>
                                <span className={styles.actions}>
                                    <IconButton
                                        size="28px"
                                        tooltip={_t("desktop|join_requests|approve", { name: request.name })}
                                        disabled={busy}
                                        onClick={() => vm.approve(request.userId)}
                                    >
                                        <CheckIcon />
                                    </IconButton>
                                    {canDecline && (
                                        <IconButton
                                            size="28px"
                                            tooltip={_t("desktop|join_requests|decline", { name: request.name })}
                                            disabled={busy}
                                            onClick={() => vm.decline(request.userId)}
                                        >
                                            <CloseIcon />
                                        </IconButton>
                                    )}
                                </span>
                            </li>
                        );
                    })}
                </ul>
            )}
            {error && (
                <Text as="p" size="xs" className={styles.error} role="alert">
                    {error}
                </Text>
            )}
        </section>
    );
}
