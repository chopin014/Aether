/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type HTMLAttributes, type JSX } from "react";
import classNames from "classnames";
import { Avatar, ContextMenu, MenuItem, Separator, Tooltip } from "@vector-im/compound-web";
import { MarkAsReadIcon } from "@vector-im/compound-design-tokens/assets/web/icons";

import { _t } from "../../core/i18n/i18n";
import { useViewModel, type ViewModel } from "../../core/viewmodel";
import { MuteMenu } from "../MuteMenu";
import { useRovingTabIndex } from "../../core/roving";
import styles from "./UnreadConversationsView.module.css";

/** A conversation outside any server that is waiting to be read. */
export interface UnreadConversation {
    /** The room's id. */
    id: string;
    /** The conversation's name: the other person's for a direct message. */
    name: string;
    /** The conversation's picture: the other person's for a direct message. */
    avatarUrl?: string;
    /** How many unread messages notify the person. */
    count: number;
}

/** What the server rail shows under Home. */
export interface UnreadConversationsViewSnapshot {
    /** The unread conversations, newest first. */
    conversations: UnreadConversation[];
}

/** What can be done with an unread conversation from the rail. */
export interface UnreadConversationsViewActions {
    /** Open the conversation in Home. */
    openConversation: (id: string) => void;
    /** Mark the conversation as read, which takes it off the rail. */
    markAsRead: (id: string) => void;
    /** Mute the conversation for this many milliseconds, or until turned back on for null. */
    mute: (id: string, duration: number | null) => void;
}

/** The view model behind {@link UnreadConversationsView}. */
export type UnreadConversationsViewModel = ViewModel<UnreadConversationsViewSnapshot, UnreadConversationsViewActions>;

/** Props for {@link UnreadConversationsView}. */
export interface UnreadConversationsViewProps {
    vm: UnreadConversationsViewModel;
    /** A class for the item that holds the list, so the rail can place its divider after it. */
    className?: string;
}

function badgeText(conversation: UnreadConversation): string {
    return conversation.count > 99 ? "99+" : String(conversation.count);
}

function accessibleName(conversation: UnreadConversation): string {
    return _t("desktop|unread_conversations|unread", { name: conversation.name, count: conversation.count });
}

/**
 * One conversation on the rail. Its button takes part in the rail's arrow-key navigation, between Home and the
 * servers, rather than being a stop of its own for Tab.
 */
function UnreadConversationItem({
    conversation,
    vm,
    ...props
}: {
    conversation: UnreadConversation;
    vm: UnreadConversationsViewModel;
} & HTMLAttributes<HTMLLIElement>): JSX.Element {
    const [onFocus, isActive, ref] = useRovingTabIndex<HTMLButtonElement>();
    return (
        // The context menu wrapping this item passes its trigger props down to the list item.
        <li {...props} role="treeitem" aria-selected={false} className={styles.item}>
            <Tooltip description={conversation.name} placement="right">
                <button
                    ref={ref}
                    type="button"
                    className={styles.button}
                    aria-label={accessibleName(conversation)}
                    tabIndex={isActive ? 0 : -1}
                    onFocus={onFocus}
                    onClick={() => vm.openConversation(conversation.id)}
                >
                    <Avatar
                        id={conversation.id}
                        name={conversation.name}
                        src={conversation.avatarUrl}
                        size="48px"
                        className={styles.avatar}
                    />
                    <span className={styles.badge} aria-hidden>
                        {badgeText(conversation)}
                    </span>
                </button>
            </Tooltip>
        </li>
    );
}

/**
 * The direct messages and group conversations waiting to be read, under Home in the server rail, as in Discord: each
 * one's picture with its unread count, newest first. Clicking one opens it; its menu marks it as read or mutes it.
 * Invitations to new conversations are counted on Home itself, as Discord counts friend requests.
 * Shows nothing while everything is read.
 */
export function UnreadConversationsView({ vm, className }: UnreadConversationsViewProps): JSX.Element | null {
    const { conversations } = useViewModel(vm);
    if (conversations.length === 0) return null;

    return (
        // The rail is a tree; the conversations are a group in it.
        <li role="none" className={classNames(styles.unreadConversations, className)}>
            <ul role="group" className={styles.list} aria-label={_t("desktop|unread_conversations|label")}>
                {conversations.map((conversation) => (
                    <ContextMenu
                        key={conversation.id}
                        title={conversation.name}
                        showTitle={false}
                        // Opening the conversation offers the same, through its own menus.
                        hasAccessibleAlternative={true}
                        trigger={<UnreadConversationItem conversation={conversation} vm={vm} />}
                    >
                        <MenuItem
                            Icon={MarkAsReadIcon}
                            label={_t("desktop|unread_conversations|mark_read")}
                            onSelect={() => vm.markAsRead(conversation.id)}
                            hideChevron
                        />
                        <Separator />
                        <MuteMenu
                            muteLabel={_t("desktop|unread_conversations|mute")}
                            unmuteLabel={_t("desktop|unread_conversations|mute")}
                            // A muted conversation leaves the rail, so the menu only ever offers to mute.
                            isMuted={false}
                            onMute={(duration) => vm.mute(conversation.id, duration)}
                            onUnmute={() => {}}
                        />
                    </ContextMenu>
                ))}
            </ul>
        </li>
    );
}
