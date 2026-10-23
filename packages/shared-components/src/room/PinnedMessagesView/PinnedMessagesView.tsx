/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, type ReactNode } from "react";
import { Button, Heading, IconButton, Text } from "@vector-im/compound-web";
import CloseIcon from "@vector-im/compound-design-tokens/assets/web/icons/close";
import PinIcon from "@vector-im/compound-design-tokens/assets/web/icons/pin";

import { type ViewModel, useViewModel } from "../../core/viewmodel";
import { useI18n } from "../../core/i18n/i18nContext";
import { Flex } from "../../core/utils/Flex";
import styles from "./PinnedMessagesView.module.css";

/** Presentation metadata for one pinned Matrix message. */
export interface PinnedMessageItem {
    id: string;
    author: string;
    timestamp: string;
    datetime?: string;
    unavailable: boolean;
    canUnpin: boolean;
    unpinning: boolean;
}

/** Current pinned-message list and request state. */
export interface PinnedMessagesViewSnapshot {
    items: PinnedMessageItem[];
    loading: boolean;
    error: "load" | "unpin" | null;
}

/** Actions available from the pinned-message browser. */
export interface PinnedMessagesViewActions {
    retry(this: void): void;
    jump(this: void, id: string): void;
    unpin(this: void, id: string): void;
    close(this: void): void;
}

/** Contract for a pinned-message browser. */
export type PinnedMessagesViewModel = ViewModel<PinnedMessagesViewSnapshot, PinnedMessagesViewActions>;

/** Properties for the pinned-message browser, with authenticated message and avatar slots. */
interface PinnedMessagesViewProps {
    vm: PinnedMessagesViewModel;
    renderMessage(this: void, id: string): ReactNode;
    renderAvatar(this: void, id: string): ReactNode;
}

/** Compact pinned-message cards; the host supplies Element's secure message renderer. */
export function PinnedMessagesView({ vm, renderMessage, renderAvatar }: PinnedMessagesViewProps): JSX.Element {
    const { translate: _t } = useI18n();
    const { items, loading, error } = useViewModel(vm);
    return (
        <section className={styles.view}>
            <Flex className={styles.header} align="center" justify="space-between">
                <Text as="h2" size="md" weight="semibold">
                    {_t("pinned_messages|title")}
                </Text>
                <IconButton size="24px" aria-label={_t("action|close")} onClick={vm.close} autoFocus>
                    <CloseIcon />
                </IconButton>
            </Flex>
            <div className={styles.scroll} aria-busy={loading}>
                {loading && (
                    <Text as="p" role="status">
                        {_t("pinned_messages|loading")}
                    </Text>
                )}
                {error && (
                    <div role="alert" className={styles.notice}>
                        <Text as="p">
                            {error === "unpin" ? _t("pinned_messages|unpin_error") : _t("pinned_messages|load_error")}
                        </Text>
                        <Button size="md" kind="secondary" onClick={vm.retry}>
                            {_t("action|retry")}
                        </Button>
                    </div>
                )}
                {!loading && !items.length && !error && (
                    <Flex className={styles.empty} direction="column" align="center" gap="var(--cpd-space-3x)">
                        <PinIcon aria-hidden />
                        <Heading as="h3" size="sm">
                            {_t("pinned_messages|empty_title")}
                        </Heading>
                        <Text as="p" size="sm">
                            {_t("pinned_messages|empty_description")}
                        </Text>
                    </Flex>
                )}
                {!!items.length && (
                    <ol className={styles.list} aria-label={_t("pinned_messages|title")}>
                        {items.map((item) => (
                            <li key={item.id} className={styles.card}>
                                <div className={styles.avatar}>{renderAvatar(item.id)}</div>
                                <div className={styles.message}>
                                    <Flex align="baseline" gap="var(--cpd-space-2x)" className={styles.metadata}>
                                        <Text as="span" weight="semibold" className={styles.author} dir="auto">
                                            {item.author}
                                        </Text>
                                        {item.datetime && <time dateTime={item.datetime}>{item.timestamp}</time>}
                                    </Flex>
                                    <div className={styles.body}>
                                        {item.unavailable ? (
                                            <Text as="p" size="sm">
                                                {_t("pinned_messages|unavailable")}
                                            </Text>
                                        ) : (
                                            renderMessage(item.id)
                                        )}
                                    </div>
                                    <Flex gap="var(--cpd-space-2x)" className={styles.actions}>
                                        {!item.unavailable && (
                                            <Button size="md" kind="tertiary" onClick={() => vm.jump(item.id)}>
                                                {_t("pinned_messages|jump")}
                                            </Button>
                                        )}
                                        {item.canUnpin && (
                                            <Button
                                                size="md"
                                                kind="tertiary"
                                                disabled={item.unpinning}
                                                onClick={() => vm.unpin(item.id)}
                                            >
                                                {_t("pinned_messages|unpin")}
                                            </Button>
                                        )}
                                    </Flex>
                                </div>
                            </li>
                        ))}
                    </ol>
                )}
            </div>
        </section>
    );
}
