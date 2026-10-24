/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, type ReactNode } from "react";
import { Menu, MenuItem, Separator, SubMenu, ToggleMenuItem } from "@vector-im/compound-web";
import {
    CheckIcon,
    EditIcon,
    ExportArchiveIcon,
    ExtensionsIcon,
    FavouriteIcon,
    FilesIcon,
    HistoryIcon,
    LeaveIcon,
    LinkIcon,
    LockSolidIcon,
    MarkAsReadIcon,
    NotificationsIcon,
    NotificationsOffIcon,
    PollsIcon,
    ErrorIcon,
    PlusIcon,
    UserAddIcon,
    LockOffIcon,
} from "@vector-im/compound-design-tokens/assets/web/icons";

import { _t } from "../../core/i18n/i18n";
import { useViewModel, type ViewModel } from "../../core/viewmodel";
import { RoomNotifState } from "../../room-list/VirtualizedRoomListView/RoomListItemWrapper/RoomListItemView/RoomNotifs";
import styles from "./ChannelMenuView.module.css";

/** Who can read the channel's history, as Matrix reports it. */
export type ChannelHistoryVisibility = "shared" | "invited" | "joined" | "world_readable";

/** Everything the channel menu needs to know about one channel. */
export interface ChannelMenuViewSnapshot {
    /** The channel's name. */
    name: string;
    /** Whether this is a text or a voice channel; it picks the symbol drawn beside the name. */
    kind: "text" | "voice";
    /** The channel's custom icon, if it has one. */
    iconUrl?: string;
    /** The plain text of the channel's topic. */
    topic?: string;
    /** Whether the user may change the topic. */
    canEditTopic: boolean;
    /** Whether messages in the channel are end-to-end encrypted. */
    isEncrypted: boolean;
    /** Who can read earlier messages. */
    historyVisibility?: ChannelHistoryVisibility;
    /** Whether the channel carries messages, so files, polls, extensions and export apply. */
    hasMessages: boolean;
    /** Whether there is anything unread to mark as read. */
    canMarkAsRead: boolean;
    /** Whether the channel is one of the user's favourites. */
    isFavourite: boolean;
    /** Whether the user may invite people. */
    canInvite: boolean;
    /** Whether the channel has a link to copy. */
    canCopyLink: boolean;
    /** Whether notification settings can be changed for this channel. */
    canChangeNotifications: boolean;
    /** The channel's notification setting. */
    roomNotifState: RoomNotifState;
    /** Whether the user may open the channel's settings to rename it or change its icon. */
    canEditChannel: boolean;
    /** Whether the user may add another text channel to the channel's Space. */
    canCreateChannel: boolean;
}

/** What choosing an entry in the channel menu does. */
export interface ChannelMenuViewActions {
    /** Mark the channel as read. */
    onMarkAsRead: () => void;
    /** Add or remove the channel from the favourites. */
    onToggleFavourite: () => void;
    /** Invite people to the channel. */
    onInvite: () => void;
    /** Copy the channel's link. */
    onCopyLink: () => void;
    /** Change how the channel notifies the user. */
    onSetNotifState: (state: RoomNotifState) => void;
    /** Open the channel's settings. */
    onEditChannel: () => void;
    /** Open the settings where the topic is edited. */
    onEditTopic: () => void;
    /** Open the settings that cover encryption and history. */
    onOpenSecuritySettings: () => void;
    /** Create another text channel in the same Space. */
    onCreateChannel: () => void;
    /** Leave the channel, after the usual confirmation. */
    onLeave: () => void;
    /** Show the channel's files. */
    onFiles: () => void;
    /** Show the channel's poll history. */
    onPolls: () => void;
    /** Open the channel's extensions and apps. */
    onExtensions: () => void;
    /** Export the channel's chat. */
    onExport: () => void;
    /** Report the channel to the server's administrators. */
    onReport: () => void;
}

/** The view model behind the channel menu. */
export type ChannelMenuViewModel = ViewModel<ChannelMenuViewSnapshot, ChannelMenuViewActions>;

function historyLabel(visibility: ChannelHistoryVisibility): string {
    switch (visibility) {
        case "shared":
            return _t("desktop|channel_menu|history_shared");
        case "invited":
            return _t("desktop|channel_menu|history_invited");
        case "joined":
            return _t("desktop|channel_menu|history_joined");
        case "world_readable":
            return _t("desktop|channel_menu|history_world_readable");
    }
}

function notifLabel(state: RoomNotifState): string {
    switch (state) {
        case RoomNotifState.AllMessagesLoud:
            return _t("desktop|channel_menu|notify_all");
        case RoomNotifState.MentionsOnly:
            return _t("desktop|channel_menu|notify_mentions");
        case RoomNotifState.Mute:
            return _t("desktop|channel_menu|notify_muted");
        default:
            return _t("desktop|channel_menu|notify_default");
    }
}

interface ChannelMenuContentProps {
    /** The channel menu view model. */
    vm: ChannelMenuViewModel;
    /** Show the channel's topic and encryption lines above the actions, as the header dropdown does. */
    showInfo?: boolean;
}

/**
 * The entries of the Discord-style channel menu. Both the header dropdown and the room list's context menu
 * render this, so the two never differ.
 */
export function ChannelMenuContent({ vm, showInfo = false }: ChannelMenuContentProps): JSX.Element {
    const s = useViewModel(vm);
    const isMuted = s.roomNotifState === RoomNotifState.Mute;
    const stop = (evt: React.MouseEvent): void => evt.stopPropagation();
    const check = <CheckIcon width="20px" height="20px" color="var(--cpd-color-icon-primary)" />;
    const notifOptions: [RoomNotifState, string][] = [
        [RoomNotifState.AllMessages, _t("desktop|channel_menu|notify_default")],
        [RoomNotifState.AllMessagesLoud, _t("desktop|channel_menu|notify_all")],
        [RoomNotifState.MentionsOnly, _t("desktop|channel_menu|notify_mentions")],
    ];

    return (
        // Arrow keys move between entries; they must not also move the room list's selection.
        <div onKeyDown={(e) => e.stopPropagation()} data-testid="channel-menu">
            {showInfo && (
                <>
                    {s.topic && (
                        <div className={styles.info}>
                            <p className={styles.topic}>{s.topic}</p>
                        </div>
                    )}
                    {s.canEditTopic && (
                        <MenuItem
                            Icon={EditIcon}
                            label={_t("desktop|channel_menu|edit_topic")}
                            onSelect={vm.onEditTopic}
                            onClick={stop}
                            hideChevron
                        />
                    )}
                    <MenuItem
                        Icon={s.isEncrypted ? LockSolidIcon : LockOffIcon}
                        label={
                            s.isEncrypted
                                ? _t("desktop|channel_menu|encrypted")
                                : _t("desktop|channel_menu|not_encrypted")
                        }
                        onSelect={vm.onOpenSecuritySettings}
                        onClick={stop}
                        hideChevron
                    />
                    {s.historyVisibility && (
                        <MenuItem
                            Icon={HistoryIcon}
                            label={historyLabel(s.historyVisibility)}
                            onSelect={vm.onOpenSecuritySettings}
                            onClick={stop}
                            hideChevron
                        />
                    )}
                    <Separator />
                </>
            )}
            <MenuItem
                Icon={MarkAsReadIcon}
                label={_t("desktop|channel_menu|mark_read")}
                disabled={!s.canMarkAsRead}
                onSelect={vm.onMarkAsRead}
                onClick={stop}
                hideChevron
            />
            <Separator />
            <ToggleMenuItem
                checked={s.isFavourite}
                Icon={FavouriteIcon}
                label={_t("desktop|channel_menu|favourite")}
                onSelect={vm.onToggleFavourite}
                onClick={stop}
            />
            {(s.canInvite || s.canCopyLink) && <Separator />}
            {s.canInvite && (
                <MenuItem
                    Icon={UserAddIcon}
                    label={_t("desktop|channel_menu|invite")}
                    onSelect={vm.onInvite}
                    onClick={stop}
                    hideChevron
                />
            )}
            {s.canCopyLink && (
                <MenuItem
                    Icon={LinkIcon}
                    label={_t("desktop|channel_menu|copy_link")}
                    onSelect={vm.onCopyLink}
                    onClick={stop}
                    hideChevron
                />
            )}
            {s.canChangeNotifications && (
                <>
                    <Separator />
                    <MenuItem
                        Icon={isMuted ? NotificationsIcon : NotificationsOffIcon}
                        label={isMuted ? _t("desktop|channel_menu|unmute") : _t("desktop|channel_menu|mute")}
                        onSelect={() => vm.onSetNotifState(isMuted ? RoomNotifState.AllMessages : RoomNotifState.Mute)}
                        onClick={stop}
                        hideChevron
                    />
                    <SubMenu
                        trigger={
                            <MenuItem label={_t("desktop|channel_menu|notification_settings")} onSelect={null}>
                                <span className={styles.value}>{notifLabel(s.roomNotifState)}</span>
                            </MenuItem>
                        }
                    >
                        {notifOptions.map(([state, label]) => (
                            <MenuItem
                                key={state}
                                label={label}
                                aria-selected={s.roomNotifState === state}
                                onSelect={() => vm.onSetNotifState(state)}
                                onClick={stop}
                                hideChevron
                            >
                                {s.roomNotifState === state && check}
                            </MenuItem>
                        ))}
                    </SubMenu>
                </>
            )}
            {(s.canEditChannel || s.canCreateChannel) && <Separator />}
            {s.canEditChannel && (
                <MenuItem
                    Icon={EditIcon}
                    label={_t("desktop|channel_menu|edit_channel")}
                    onSelect={vm.onEditChannel}
                    onClick={stop}
                    hideChevron
                />
            )}
            {s.canCreateChannel && (
                <MenuItem
                    Icon={PlusIcon}
                    label={_t("desktop|channel_menu|create_channel")}
                    onSelect={vm.onCreateChannel}
                    onClick={stop}
                    hideChevron
                />
            )}
            <Separator />
            {s.hasMessages && (
                <>
                    <MenuItem
                        Icon={FilesIcon}
                        label={_t("desktop|channel_menu|files")}
                        onSelect={vm.onFiles}
                        onClick={stop}
                        hideChevron
                    />
                    <MenuItem
                        Icon={PollsIcon}
                        label={_t("desktop|channel_menu|polls")}
                        onSelect={vm.onPolls}
                        onClick={stop}
                        hideChevron
                    />
                    <MenuItem
                        Icon={ExtensionsIcon}
                        label={_t("desktop|channel_menu|extensions")}
                        onSelect={vm.onExtensions}
                        onClick={stop}
                        hideChevron
                    />
                    <MenuItem
                        Icon={ExportArchiveIcon}
                        label={_t("desktop|channel_menu|export")}
                        onSelect={vm.onExport}
                        onClick={stop}
                        hideChevron
                    />
                </>
            )}
            <MenuItem
                Icon={ErrorIcon}
                label={_t("desktop|channel_menu|report")}
                onSelect={vm.onReport}
                onClick={stop}
                hideChevron
            />
            <Separator />
            <MenuItem
                kind="critical"
                Icon={LeaveIcon}
                label={_t("desktop|channel_menu|leave")}
                onSelect={vm.onLeave}
                onClick={stop}
                hideChevron
            />
        </div>
    );
}

/** Props for {@link ChannelMenuView}. */
export interface ChannelMenuViewProps {
    /** The channel menu view model. */
    vm: ChannelMenuViewModel;
    /** The button that opens the menu. It must accept a ref and spread its props. */
    trigger: ReactNode;
    /** Whether the menu is open. */
    open: boolean;
    /** Called when the menu opens or closes. */
    onOpenChange: (open: boolean) => void;
}

/** The dropdown that opens beneath the channel name in the header. */
export function ChannelMenuView({ vm, trigger, open, onOpenChange }: ChannelMenuViewProps): JSX.Element {
    return (
        <Menu
            open={open}
            onOpenChange={onOpenChange}
            title={_t("desktop|channel_menu|title")}
            showTitle={false}
            side="bottom"
            align="start"
            trigger={trigger}
        >
            <ChannelMenuContent vm={vm} showInfo />
        </Menu>
    );
}
