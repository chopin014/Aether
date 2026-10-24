/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { Button, Form, Search, Text } from "@vector-im/compound-web";
import ThreadsIcon from "@vector-im/compound-design-tokens/assets/web/icons/threads-solid";

import { type ViewModel, useViewModel } from "../../core/viewmodel";
import { useI18n } from "../../core/i18n/i18nContext";
import { Flex } from "../../core/utils/Flex";
import styles from "./DesktopThreadBrowserView.module.css";

/** A loaded Matrix thread, labelled using its root message. */
export interface DesktopThreadRow {
    id: string;
    title: string;
    preview: string;
    replies: number;
    activity: string;
    unread: boolean;
}

/** State of channel thread discovery. Search covers loaded pages only. */
export interface DesktopThreadBrowserSnapshot {
    query: string;
    filter: "all" | "mine";
    rows: DesktopThreadRow[];
    loading: boolean;
    error: boolean;
    hasMore: boolean;
    canCreate: boolean;
}

/** Actions supplied by the Matrix-backed discovery model. */
export interface DesktopThreadBrowserActions {
    setQuery: (query: string) => void;
    setFilter: (filter: "all" | "mine") => void;
    loadMore: () => Promise<void>;
    retry: () => Promise<void>;
    openThread: (id: string) => void;
    createThread: () => void;
}

/** Model contract for the channel's thread browser. */
export type DesktopThreadBrowserModel = ViewModel<DesktopThreadBrowserSnapshot, DesktopThreadBrowserActions>;

/** Searchable non-modal thread browser. Its owner supplies positioning and dismissal. */
export function DesktopThreadBrowserView({ vm }: { vm: DesktopThreadBrowserModel }): JSX.Element {
    const { translate: _t } = useI18n();
    const { query, filter, rows, loading, error, hasMore, canCreate } = useViewModel(vm);
    return (
        <section className={styles.browser} aria-label={_t("common|threads")}>
            <Flex as="header" className={styles.header} align="center" gap="var(--cpd-space-3x)">
                <ThreadsIcon aria-hidden className={styles.icon} />
                <Text as="h2" weight="semibold" className={styles.title}>
                    {_t("common|threads")}
                </Text>
                <Form.Root className={styles.searchForm} onSubmit={(event) => event.preventDefault()}>
                    <Search
                        autoFocus
                        name="threadSearch"
                        className={styles.search}
                        aria-label={_t("desktop|threads|search")}
                        placeholder={_t("desktop|threads|search")}
                        value={query}
                        onChange={(event) => vm.setQuery(event.target.value)}
                    />
                </Form.Root>
                {canCreate && (
                    <Button size="md" onClick={vm.createThread}>
                        {_t("action|create")}
                    </Button>
                )}
            </Flex>
            {(rows.length > 0 || query || filter === "mine" || hasMore) && (
                <Flex as="nav" className={styles.filters} gap="var(--cpd-space-2x)" aria-label={_t("common|threads")}>
                    <button type="button" aria-pressed={filter === "all"} onClick={() => vm.setFilter("all")}>
                        {_t("threads|all_threads")}
                    </button>
                    <button type="button" aria-pressed={filter === "mine"} onClick={() => vm.setFilter("mine")}>
                        {_t("threads|my_threads")}
                    </button>
                </Flex>
            )}
            <div className={styles.body} aria-busy={loading}>
                {error && (
                    <div className={styles.notice} role="alert">
                        <Text>{_t("desktop|threads|load_error")}</Text>
                        <Button size="md" kind="secondary" disabled={loading} onClick={() => void vm.retry()}>
                            {_t("action|retry")}
                        </Button>
                    </div>
                )}
                {loading && (
                    <Text className={styles.notice} role="status">
                        {_t("common|loading")}
                    </Text>
                )}
                {!loading && !error && !rows.length && (
                    <Flex
                        className={styles.empty}
                        direction="column"
                        align="center"
                        justify="center"
                        gap="var(--cpd-space-4x)"
                    >
                        <div className={styles.illustration} aria-hidden>
                            <ThreadsIcon />
                            <ThreadsIcon />
                            <ThreadsIcon />
                        </div>
                        <Text as="h3" size="lg" weight="semibold">
                            {query ? _t("desktop|threads|no_results") : _t("desktop|threads|empty_title")}
                        </Text>
                        <Text className={styles.description}>
                            {query ? _t("desktop|threads|search_scope") : _t("desktop|threads|empty_description")}
                        </Text>
                        {canCreate && !query && (
                            <Button size="md" onClick={vm.createThread}>
                                {_t("desktop|threads|create")}
                            </Button>
                        )}
                    </Flex>
                )}
                {rows.length > 0 && (
                    <ul className={styles.list}>
                        {rows.map((row) => (
                            <li key={row.id}>
                                <button type="button" className={styles.row} onClick={() => vm.openThread(row.id)}>
                                    <ThreadsIcon className={styles.rowIcon} aria-hidden />
                                    <span className={styles.details}>
                                        <Text as="span" weight="semibold" className={styles.rowTitle} dir="auto">
                                            {row.title}
                                        </Text>
                                        <Text as="span" size="sm" className={styles.preview} dir="auto">
                                            {row.preview}
                                        </Text>
                                        <Text as="span" size="sm" className={styles.metadata}>
                                            {_t("desktop|threads|replies", { count: row.replies })} · {row.activity}
                                        </Text>
                                    </span>
                                    {row.unread && (
                                        <span className={styles.unread} aria-label={_t("desktop|threads|unread")} />
                                    )}
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
                {hasMore && (
                    <Button
                        className={styles.more}
                        size="md"
                        kind="tertiary"
                        disabled={loading}
                        onClick={() => void vm.loadMore()}
                    >
                        {_t("desktop|threads|load_more")}
                    </Button>
                )}
            </div>
            {(query || hasMore) && (
                <Text size="sm" className={styles.scope}>
                    {_t("desktop|threads|search_scope")}
                </Text>
            )}
        </section>
    );
}
