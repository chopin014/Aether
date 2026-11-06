/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, useEffect, useRef } from "react";
import { Button, Form, Search, Text } from "@vector-im/compound-web";
import { ExploreIcon, RestartIcon, SearchIcon } from "@vector-im/compound-design-tokens/assets/web/icons";

import { useViewModel, type ViewModel } from "../../core/viewmodel";
import { useI18n } from "../../core/i18n/i18nContext";
import { DiscoverCard } from "./DiscoverCard";
import styles from "./DiscoverView.module.css";

/** Which kind of public community the Discover page lists. */
export type DiscoverSection = "spaces" | "rooms";

/** Topic groups shown as tabs. `home` lists everything. */
export type DiscoverCategory = "home" | "gaming" | "music" | "entertainment" | "tech" | "education";

/** Every category, in tab order. */
export const DISCOVER_CATEGORIES: readonly DiscoverCategory[] = [
    "home",
    "gaming",
    "music",
    "entertainment",
    "tech",
    "education",
];

/** One public Space or room from a Matrix room directory. */
export interface DiscoverEntry {
    roomId: string;
    name: string;
    /** Plain-text topic with Markdown links reduced to their text. */
    topic?: string;
    /** HTTP URL of a square avatar thumbnail. */
    avatarUrl?: string;
    memberCount: number;
    /** The user is already a member, so opening it goes straight in. */
    joined: boolean;
}

/** A room directory the user can browse. */
export interface DiscoverServer {
    name: string;
    /** The user's own homeserver. */
    isHome: boolean;
}

/** Loading state of the current listing. */
export type DiscoverStatus = "loading" | "ready" | "error";

/** Everything the Discover page and its sidebar display. */
export interface DiscoverViewSnapshot {
    section: DiscoverSection;
    category: DiscoverCategory;
    query: string;
    /** The directory currently being browsed. */
    server: string;
    servers: DiscoverServer[];
    entries: DiscoverEntry[];
    status: DiscoverStatus;
    loadingMore: boolean;
    hasMore: boolean;
}

/** Actions the Discover page and its sidebar can take. */
export interface DiscoverViewActions {
    setSection: (section: DiscoverSection) => void;
    setCategory: (category: DiscoverCategory) => void;
    setQuery: (query: string) => void;
    setServer: (server: string) => void;
    /** Ask the user for another server's directory and switch to it. */
    addServer: () => void;
    loadMore: () => void;
    retry: () => void;
    /** Preview the community, or go straight in when already joined. */
    open: (roomId: string) => void;
}

/** Model shared by the Discover page and its sidebar. */
export type DiscoverViewModel = ViewModel<DiscoverViewSnapshot, DiscoverViewActions>;

const SKELETON_CARDS = 8;

/** Discord-style browser for public Matrix Spaces and rooms. */
export function DiscoverView({ vm }: { vm: DiscoverViewModel }): JSX.Element {
    const { section, category, query, server, entries, status, loadingMore, hasMore } = useViewModel(vm);
    const { translate: _t, language } = useI18n();
    const sentinel = useRef<HTMLDivElement>(null);
    const scroller = useRef<HTMLDivElement>(null);
    const canLoadMore = status === "ready" && hasMore && !loadingMore;

    // Load the next page as the user nears the end of the grid.
    useEffect(() => {
        const target = sentinel.current;
        if (!target || !canLoadMore || typeof IntersectionObserver === "undefined") return;
        const observer = new IntersectionObserver(
            (records) => {
                if (records.some((record) => record.isIntersecting)) vm.loadMore();
            },
            { root: scroller.current, rootMargin: "400px" },
        );
        observer.observe(target);
        return () => observer.disconnect();
    }, [canLoadMore, vm]);

    // A new listing starts at the top.
    useEffect(() => {
        scroller.current?.scrollTo?.({ top: 0 });
    }, [section, category, server]);

    const categoryLabels: Record<DiscoverCategory, string> = {
        home: _t("desktop|discover|category_home"),
        gaming: _t("desktop|discover|category_gaming"),
        music: _t("desktop|discover|category_music"),
        entertainment: _t("desktop|discover|category_entertainment"),
        tech: _t("desktop|discover|category_tech"),
        education: _t("desktop|discover|category_education"),
    };
    const trimmedQuery = query.trim();
    let heading: string;
    if (trimmedQuery) heading = _t("desktop|discover|results_heading", { query: trimmedQuery });
    else if (category !== "home") heading = categoryLabels[category];
    else if (section === "spaces") heading = _t("desktop|discover|popular_spaces");
    else heading = _t("desktop|discover|popular_rooms");

    const searchLabel =
        section === "spaces" ? _t("desktop|discover|search_spaces") : _t("desktop|discover|search_rooms");

    return (
        <main className={styles.page} data-desktop-discover>
            <header className={styles.header}>
                <ExploreIcon className={styles.headerIcon} aria-hidden />
                <nav className={styles.tabs} aria-label={_t("desktop|discover|categories")}>
                    {DISCOVER_CATEGORIES.map((id) => (
                        <button
                            key={id}
                            type="button"
                            aria-current={category === id ? "page" : undefined}
                            onClick={() => vm.setCategory(id)}
                        >
                            {categoryLabels[id]}
                        </button>
                    ))}
                </nav>
            </header>
            <div className={styles.scroller} ref={scroller}>
                <section className={styles.hero} data-section={section}>
                    <div className={styles.heroContent}>
                        <Text as="h1" className={styles.heroTitle}>
                            {section === "spaces"
                                ? _t("desktop|discover|hero_spaces_title")
                                : _t("desktop|discover|hero_rooms_title")}
                        </Text>
                        <Text className={styles.heroSubtitle}>
                            {section === "spaces"
                                ? _t("desktop|discover|hero_spaces_subtitle")
                                : _t("desktop|discover|hero_rooms_subtitle")}
                        </Text>
                        <Form.Root className={styles.heroSearch} onSubmit={(event) => event.preventDefault()}>
                            <Search
                                className={styles.search}
                                name="discoverSearch"
                                placeholder={searchLabel}
                                aria-label={searchLabel}
                                value={query}
                                onChange={(event) => vm.setQuery(event.target.value)}
                            />
                        </Form.Root>
                    </div>
                </section>
                <section
                    className={styles.results}
                    aria-labelledby="mx_DiscoverView_heading"
                    aria-busy={status === "loading"}
                >
                    <div className={styles.resultsHeader}>
                        <Text as="h2" size="lg" weight="semibold" id="mx_DiscoverView_heading">
                            {heading}
                        </Text>
                        <Text size="sm" className={styles.directoryNote}>
                            {_t("desktop|discover|directory_note", { server })}
                        </Text>
                    </div>
                    {status === "error" ? (
                        <div className={styles.state} role="alert">
                            <Text weight="semibold">{_t("desktop|discover|error_title", { server })}</Text>
                            <Text size="sm">{_t("desktop|discover|error_description")}</Text>
                            <Button kind="secondary" size="md" Icon={RestartIcon} onClick={vm.retry}>
                                {_t("desktop|discover|retry")}
                            </Button>
                        </div>
                    ) : status === "ready" && entries.length === 0 ? (
                        <div className={styles.state}>
                            <SearchIcon />
                            <Text weight="semibold">
                                {trimmedQuery
                                    ? _t("desktop|discover|empty_query_title", { query: trimmedQuery })
                                    : _t("desktop|discover|empty_title")}
                            </Text>
                            <Text size="sm">{_t("desktop|discover|empty_description")}</Text>
                        </div>
                    ) : (
                        <ul className={styles.grid}>
                            {entries.map((entry) => (
                                <li key={entry.roomId}>
                                    <DiscoverCard entry={entry} language={language} onOpen={vm.open} />
                                </li>
                            ))}
                            {(status === "loading" || loadingMore) &&
                                Array.from({ length: SKELETON_CARDS }, (_, index) => (
                                    <li key={`skeleton-${index}`} aria-hidden>
                                        <div className={styles.skeleton} />
                                    </li>
                                ))}
                        </ul>
                    )}
                    {canLoadMore && (
                        <div className={styles.more} ref={sentinel}>
                            <Button kind="secondary" size="md" onClick={vm.loadMore}>
                                {_t("desktop|discover|load_more")}
                            </Button>
                        </div>
                    )}
                </section>
            </div>
        </main>
    );
}
