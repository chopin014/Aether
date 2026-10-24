/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, type ReactNode, useEffect, useRef } from "react";
import CloseIcon from "@vector-im/compound-design-tokens/assets/web/icons/close";
import { Button, Text } from "@vector-im/compound-web";

import { type ViewModel, useViewModel } from "../../core/viewmodel";
import { useI18n } from "../../core/i18n/i18nContext";
import styles from "./DesktopSearchResultsView.module.css";

/** A piece of message text, marked when it matched the search. */
export interface DesktopSearchSegment {
    text: string;
    match: boolean;
}

export interface DesktopSearchResultRow {
    id: string;
    roomId: string;
    senderId: string;
    senderName: string;
    timeLabel: string;
    /** Full date and time, for the tooltip. */
    fullTimeLabel: string;
    segments: DesktopSearchSegment[];
    /** Set when the message is an attachment, so the host can render a safe preview. */
    attachmentName?: string;
}

export interface DesktopSearchResultGroup {
    roomId: string;
    roomName: string;
    rows: DesktopSearchResultRow[];
}

export type DesktopSearchSort = "recent" | "relevance";

export interface DesktopSearchResultsSnapshot {
    status: "idle" | "loading" | "ready" | "error";
    /** Number of results to show in the header. */
    resultCount: number;
    /** Whether more results may exist than are loaded, shown as "N+". */
    countIsLowerBound: boolean;
    sort: DesktopSearchSort;
    /** Sort orders the search can honour. The tabs are hidden when only one remains. */
    sorts: DesktopSearchSort[];
    groups: DesktopSearchResultGroup[];
    hasMore: boolean;
    loadingMore: boolean;
    /** Some filters are applied on the client, so the list and count are approximate. */
    approximate: boolean;
    /** Encrypted rooms are in scope but cannot be searched. */
    encryptedSkipped: boolean;
    /** The query had only filters, which cannot reach encrypted rooms. */
    browseSkipsEncrypted: boolean;
    activeId: string | null;
}

export interface DesktopSearchResultsActions {
    setSort: (sort: DesktopSearchSort) => void;
    loadMore: () => void;
    retry: () => void;
    openResult: (id: string) => void;
    close: () => void;
    openSecuritySettings: () => void;
}

export type DesktopSearchResultsModel = ViewModel<DesktopSearchResultsSnapshot, DesktopSearchResultsActions>;

export interface DesktopSearchResultsProps {
    vm: DesktopSearchResultsModel;
    /** Avatar for the sender, supplied by the host so it can use Matrix media. */
    renderAvatar?: (row: DesktopSearchResultRow) => ReactNode;
    /** Preview of an attachment, supplied by the host so it can use Element's authorised media components. */
    renderAttachment?: (row: DesktopSearchResultRow) => ReactNode;
}

function Segments({ segments }: { segments: DesktopSearchSegment[] }): JSX.Element {
    // Segments never reorder, so the offset into the text identifies each one.
    const keyed = segments.map((segment, index) => ({
        segment,
        key: segments.slice(0, index).reduce((total, previous) => total + previous.text.length, 0),
    }));
    return (
        <>
            {keyed.map(({ segment, key }) =>
                segment.match ? (
                    <mark key={key} className={styles.match}>
                        {segment.text}
                    </mark>
                ) : (
                    <React.Fragment key={key}>{segment.text}</React.Fragment>
                ),
            )}
        </>
    );
}

/** Discord-style search results for the right column: header, sort tabs, results grouped by channel. */
export function DesktopSearchResultsView({
    vm,
    renderAvatar,
    renderAttachment,
}: DesktopSearchResultsProps): JSX.Element {
    const { translate: _t } = useI18n();
    const snapshot = useViewModel(vm);
    const { status, groups, hasMore, loadingMore, sorts, sort } = snapshot;
    const sentinel = useRef<HTMLDivElement>(null);

    // Load the next page when the end of the list scrolls into view.
    useEffect(() => {
        const node = sentinel.current;
        if (!node || !hasMore || loadingMore || typeof IntersectionObserver === "undefined") return;
        const observer = new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting)) vm.loadMore();
        });
        observer.observe(node);
        return () => observer.disconnect();
    }, [vm, hasMore, loadingMore, groups]);

    const title =
        status === "ready" || (status === "loading" && snapshot.resultCount > 0)
            ? _t(snapshot.countIsLowerBound ? "desktop|search|results|title_more" : "desktop|search|results|title", {
                  count: snapshot.resultCount,
              })
            : _t("desktop|search|results|label");

    return (
        <section className={styles.panel} aria-label={_t("desktop|search|results|label")}>
            <header className={styles.header}>
                <Text as="h2" className={styles.title} aria-live="polite">
                    {title}
                </Text>
                {sorts.length > 1 && (
                    <div role="tablist" aria-label={_t("desktop|search|results|sort_label")} className={styles.tabs}>
                        {sorts.map((option) => (
                            <button
                                key={option}
                                type="button"
                                role="tab"
                                aria-selected={option === sort}
                                className={styles.tab}
                                onClick={() => vm.setSort(option)}
                            >
                                {_t(`desktop|search|results|sort_${option}`)}
                            </button>
                        ))}
                    </div>
                )}
                <button
                    type="button"
                    className={styles.close}
                    aria-label={_t("desktop|search|results|close")}
                    onClick={vm.close}
                >
                    <CloseIcon aria-hidden />
                </button>
            </header>
            {snapshot.encryptedSkipped && (
                <div className={styles.notice} role="note">
                    {_t("desktop|search|results|encrypted")}{" "}
                    <button type="button" className={styles.link} onClick={vm.openSecuritySettings}>
                        {_t("desktop|search|results|encrypted_action")}
                    </button>
                </div>
            )}
            {snapshot.browseSkipsEncrypted && !snapshot.encryptedSkipped && (
                <div className={styles.notice} role="note">
                    {_t("desktop|search|results|browse_encrypted")}
                </div>
            )}
            {snapshot.approximate && status !== "idle" && (
                <div className={styles.subtle} role="note">
                    {_t("desktop|search|results|approximate")}
                </div>
            )}
            <div className={styles.body} aria-busy={status === "loading" || loadingMore}>
                {status === "idle" && <p className={styles.state}>{_t("desktop|search|results|idle")}</p>}
                {status === "loading" && groups.length === 0 && (
                    <p className={styles.state} role="status">
                        {_t("desktop|search|results|loading")}
                    </p>
                )}
                {status === "error" && (
                    <div className={styles.state} role="alert">
                        <p>{_t("desktop|search|results|error")}</p>
                        <Button size="md" kind="secondary" onClick={vm.retry}>
                            {_t("desktop|search|results|retry")}
                        </Button>
                    </div>
                )}
                {status === "ready" && groups.length === 0 && (
                    <div className={styles.state}>
                        <Text as="h3" className={styles.emptyTitle}>
                            {_t("desktop|search|results|empty_title")}
                        </Text>
                        <p>{_t("desktop|search|results|empty_description")}</p>
                    </div>
                )}
                {groups.map((group) => (
                    <section key={group.roomId} className={styles.group} aria-label={group.roomName}>
                        <Text as="h3" className={styles.groupName}>
                            <span aria-hidden>#</span>
                            {group.roomName}
                        </Text>
                        <ul className={styles.list}>
                            {group.rows.map((row) => (
                                <li key={row.id}>
                                    {/* Clicking the card is a pointer shortcut; keyboard users use the Jump button. */}
                                    {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events */}
                                    <article
                                        className={styles.card}
                                        data-active={row.id === snapshot.activeId || undefined}
                                        onClick={(event) => {
                                            // Attachment previews have their own controls; let those work normally.
                                            if (
                                                !(event.target as HTMLElement).closest("a, button, audio, video, input")
                                            ) {
                                                vm.openResult(row.id);
                                            }
                                        }}
                                    >
                                        <div className={styles.avatar}>{renderAvatar?.(row)}</div>
                                        <div className={styles.content}>
                                            <div className={styles.meta}>
                                                <span className={styles.sender} dir="auto">
                                                    {row.senderName}
                                                </span>
                                                <time className={styles.time} title={row.fullTimeLabel}>
                                                    {row.timeLabel}
                                                </time>
                                            </div>
                                            <p className={styles.text} dir="auto">
                                                <Segments segments={row.segments} />
                                            </p>
                                            {row.attachmentName !== undefined && renderAttachment && (
                                                <div className={styles.attachment}>{renderAttachment(row)}</div>
                                            )}
                                        </div>
                                        <button
                                            type="button"
                                            className={styles.jump}
                                            aria-label={_t("desktop|search|results|jump_to", { name: row.senderName })}
                                            onClick={() => vm.openResult(row.id)}
                                        >
                                            {_t("desktop|search|results|jump")}
                                        </button>
                                    </article>
                                </li>
                            ))}
                        </ul>
                    </section>
                ))}
                {hasMore && status !== "error" && (
                    <div ref={sentinel} className={styles.more}>
                        <Button size="md" kind="tertiary" disabled={loadingMore} onClick={vm.loadMore}>
                            {loadingMore
                                ? _t("desktop|search|results|loading_more")
                                : _t("desktop|search|results|load_more")}
                        </Button>
                    </div>
                )}
            </div>
        </section>
    );
}
