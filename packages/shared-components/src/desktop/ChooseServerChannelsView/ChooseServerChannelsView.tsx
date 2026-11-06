/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { Button, CheckboxInput, InlineSpinner, Text } from "@vector-im/compound-web";
import { VolumeOnIcon } from "@vector-im/compound-design-tokens/assets/web/icons";

import { useViewModel, type ViewModel } from "../../core/viewmodel";
import { _t } from "../../core/i18n/i18n";
import { TextChannelIcon } from "../TextChannelIcon";
import styles from "./ChooseServerChannelsView.module.css";

/** One channel the user may join. */
export interface ChooseServerChannel {
    id: string;
    name: string;
    kind: "text" | "voice";
    topic?: string;
    memberCount: number;
    /** Whether it will be joined. */
    selected: boolean;
}

/** What the channel picker shows after joining a server. */
export interface ChooseServerChannelsViewSnapshot {
    /** The server that was joined. */
    serverName: string;
    /** The server's channels, in its own order. */
    channels: ChooseServerChannel[];
    /** Whether the chosen channels are being joined. */
    busy: boolean;
    /** Why joining failed. */
    error?: string;
}

/** What the channel picker's controls do. */
export interface ChooseServerChannelsViewActions {
    /** Select or deselect one channel. */
    toggle: (id: string) => void;
    /** Select every channel, or none. */
    setAll: (selected: boolean) => void;
    /** Join the selected channels. */
    confirm: () => void;
    /** Join none for now. */
    skip: () => void;
}

/** The model behind the channel picker. */
export type ChooseServerChannelsViewModel = ViewModel<
    ChooseServerChannelsViewSnapshot,
    ChooseServerChannelsViewActions
>;

function ChannelGroup({
    title,
    channels,
    disabled,
    onToggle,
}: {
    title: string;
    channels: ChooseServerChannel[];
    disabled: boolean;
    onToggle: (id: string) => void;
}): JSX.Element | null {
    if (channels.length === 0) return null;
    return (
        <section className={styles.group}>
            <Text as="h3" size="xs" weight="semibold" className={styles.groupTitle}>
                {title}
            </Text>
            <ul className={styles.list}>
                {channels.map((channel) => {
                    const Icon = channel.kind === "voice" ? VolumeOnIcon : TextChannelIcon;
                    return (
                        <li key={channel.id}>
                            <label className={styles.row}>
                                <Icon className={styles.icon} aria-hidden />
                                <span className={styles.text}>
                                    <Text as="span" weight="semibold" className={styles.name}>
                                        {channel.name}
                                    </Text>
                                    {channel.topic && (
                                        <Text as="span" size="sm" className={styles.topic}>
                                            {channel.topic}
                                        </Text>
                                    )}
                                </span>
                                <Text as="span" size="sm" className={styles.members}>
                                    {_t("desktop|choose_channels|members", { count: channel.memberCount })}
                                </Text>
                                {/* While joining, the boxes stay focusable so the list can still be scrolled from
                                    the keyboard; they only stop changing. */}
                                <CheckboxInput
                                    checked={channel.selected}
                                    aria-disabled={disabled || undefined}
                                    onChange={() => {
                                        if (!disabled) onToggle(channel.id);
                                    }}
                                />
                            </label>
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}

/**
 * Lets someone who just joined a large server pick which channels to join, like Discord's channel browser. The
 * host supplies the dialog around it.
 */
export function ChooseServerChannelsView({
    vm,
}: {
    /** The picker's model. */
    vm: ChooseServerChannelsViewModel;
}): JSX.Element {
    const s = useViewModel(vm);
    const selected = s.channels.filter((channel) => channel.selected).length;
    const allSelected = selected === s.channels.length;
    return (
        <form
            className={styles.content}
            aria-busy={s.busy}
            onSubmit={(event) => {
                event.preventDefault();
                vm.confirm();
            }}
        >
            <header className={styles.header}>
                <Text as="h2" size="lg" weight="semibold" className={styles.title}>
                    {_t("desktop|choose_channels|title")}
                </Text>
                <Text as="p" className={styles.secondary}>
                    {_t("desktop|choose_channels|description", {
                        server: s.serverName,
                        count: s.channels.length,
                    })}
                </Text>
            </header>
            <div className={styles.toolbar}>
                <Text as="span" size="sm" className={styles.secondary}>
                    {_t("desktop|choose_channels|selected", { count: selected })}
                </Text>
                <Button
                    type="button"
                    kind="tertiary"
                    size="md"
                    disabled={s.busy}
                    onClick={() => vm.setAll(!allSelected)}
                >
                    {allSelected ? _t("desktop|choose_channels|select_none") : _t("desktop|choose_channels|select_all")}
                </Button>
            </div>
            <div className={styles.scroller}>
                <ChannelGroup
                    title={_t("desktop|choose_channels|text_channels")}
                    channels={s.channels.filter((channel) => channel.kind === "text")}
                    disabled={s.busy}
                    onToggle={vm.toggle}
                />
                <ChannelGroup
                    title={_t("desktop|choose_channels|voice_channels")}
                    channels={s.channels.filter((channel) => channel.kind === "voice")}
                    disabled={s.busy}
                    onToggle={vm.toggle}
                />
            </div>
            {s.error && (
                <Text as="p" size="sm" role="alert" className={styles.error}>
                    {s.error}
                </Text>
            )}
            <footer className={styles.footer}>
                <Button type="button" kind="tertiary" size="md" onClick={vm.skip} disabled={s.busy}>
                    {_t("desktop|choose_channels|skip")}
                </Button>
                <Button type="submit" kind="primary" disabled={s.busy || selected === 0}>
                    {s.busy && <InlineSpinner />}
                    {_t("desktop|choose_channels|join", { count: selected })}
                </Button>
            </footer>
        </form>
    );
}
