/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type ComponentProps, type JSX } from "react";
import { CheckboxMenuItem, MenuItem, RadioMenuItem, Separator, SubMenu } from "@vector-im/compound-web";
import {
    FolderIcon,
    LeaveIcon,
    MarkAsReadIcon,
    NotificationsIcon,
    PlusIcon,
    SettingsIcon,
    UserAddIcon,
    CodeIcon,
} from "@vector-im/compound-design-tokens/assets/web/icons";

import { _t } from "../../core/i18n/i18n";
import { useViewModel, type ViewModel } from "../../core/viewmodel";
import { MuteMenu } from "../MuteMenu";
import styles from "./ServerMenuView.module.css";

/** How a server's channels notify the person. */
export type ServerNotificationLevel = "all" | "mentions";

/** What a server's menu in the server rail offers. */
export interface ServerMenuViewSnapshot {
    /** Whether any of the server's channels has something unread. */
    canMarkAsRead: boolean;
    /** Whether the person may invite people to the server. */
    canInvite: boolean;
    /** Whether the person muted the server. */
    isMuted: boolean;
    /** When the server's mute ends, if it is muted for a while. */
    mutedUntil?: number;
    /** Whether the server's channels notify about every message or only mentions. */
    notificationLevel: ServerNotificationLevel;
    /** Whether the person hides the server's muted channels. */
    hideMutedChannels: boolean;
    /** Whether the person may open the server's settings. */
    canOpenSettings: boolean;
    /** Whether the person may create channels in the server. */
    canCreateChannel: boolean;
    /** Whether the person may create categories in the server. */
    canCreateCategory: boolean;
    /** Whether to offer the server's raw timeline, for people who turned developer mode on. */
    showDevtools: boolean;
}

/** What choosing an entry in a server's menu does. */
export interface ServerMenuViewActions {
    markAsRead: () => void;
    invite: () => void;
    /** Mute the server for this many milliseconds, or until turned back on for null. */
    mute: (duration: number | null) => void;
    unmute: () => void;
    setNotificationLevel: (level: ServerNotificationLevel) => void;
    toggleHideMutedChannels: () => void;
    openSettings: () => void;
    /** Create a channel, choosing whether it is a text or a voice channel. */
    createChannel: () => void;
    createCategory: () => void;
    /** Leave the server, after the usual confirmation. */
    leave: () => void;
    openDevtools: () => void;
}

/** The view model behind {@link ServerMenuView}. */
export type ServerMenuViewModel = ViewModel<ServerMenuViewSnapshot, ServerMenuViewActions>;

function levelLabel(level: ServerNotificationLevel): string {
    return level === "all" ? _t("desktop|server_menu|notify_all") : _t("desktop|server_menu|notify_mentions");
}

/**
 * The entries of a server's menu in the server rail, in Discord's order: mark as read; invite; mute, notifications and
 * hiding muted channels; settings; creating channels and categories; and leaving. Render it inside a compound menu.
 */
export function ServerMenuView({ vm }: { vm: ServerMenuViewModel }): JSX.Element {
    const s = useViewModel(vm);
    const canCreate = s.canCreateChannel || s.canCreateCategory;

    return (
        <>
            <MenuItem
                Icon={MarkAsReadIcon}
                label={_t("desktop|server_menu|mark_read")}
                disabled={!s.canMarkAsRead}
                onSelect={vm.markAsRead}
                hideChevron
            />
            {s.canInvite && (
                <>
                    <Separator />
                    <MenuItem
                        className={styles.invite}
                        Icon={UserAddIcon}
                        label={_t("desktop|channel_list_menu|invite")}
                        onSelect={vm.invite}
                        hideChevron
                    />
                </>
            )}
            <Separator />
            <MuteMenu
                muteLabel={_t("desktop|server_menu|mute")}
                unmuteLabel={_t("desktop|server_menu|unmute")}
                isMuted={s.isMuted}
                mutedUntil={s.mutedUntil}
                onMute={vm.mute}
                onUnmute={vm.unmute}
            />
            <SubMenu
                trigger={
                    <MenuItem
                        className={styles.withValue}
                        Icon={NotificationsIcon}
                        label={_t("desktop|server_menu|notification_settings")}
                        // The current level shows under the label, as in Discord. A submenu's trigger hides any
                        // child after its chevron, so the label draws it.
                        labelProps={
                            { "data-value": levelLabel(s.notificationLevel) } as ComponentProps<
                                typeof MenuItem
                            >["labelProps"]
                        }
                        aria-description={levelLabel(s.notificationLevel)}
                        onSelect={null}
                    />
                }
            >
                {(["all", "mentions"] as const).map((level) => (
                    <RadioMenuItem
                        key={level}
                        label={levelLabel(level)}
                        checked={s.notificationLevel === level}
                        onSelect={() => vm.setNotificationLevel(level)}
                    />
                ))}
            </SubMenu>
            <CheckboxMenuItem
                label={_t("desktop|channel_list_menu|hide_muted")}
                checked={s.hideMutedChannels}
                onSelect={vm.toggleHideMutedChannels}
            />
            {s.canOpenSettings && (
                <>
                    <Separator />
                    <MenuItem
                        Icon={SettingsIcon}
                        label={_t("desktop|server_menu|settings")}
                        onSelect={vm.openSettings}
                        hideChevron
                    />
                </>
            )}
            {canCreate && <Separator />}
            {s.canCreateChannel && (
                <MenuItem
                    Icon={PlusIcon}
                    label={_t("desktop|channel_list_menu|create_channel")}
                    onSelect={vm.createChannel}
                    hideChevron
                />
            )}
            {s.canCreateCategory && (
                <MenuItem
                    Icon={FolderIcon}
                    label={_t("desktop|channel_list_menu|create_category")}
                    onSelect={vm.createCategory}
                    hideChevron
                />
            )}
            {s.showDevtools && (
                <>
                    <Separator />
                    <MenuItem
                        Icon={CodeIcon}
                        label={_t("desktop|server_menu|devtools")}
                        onSelect={vm.openDevtools}
                        hideChevron
                    />
                </>
            )}
            <Separator />
            <MenuItem
                kind="critical"
                Icon={LeaveIcon}
                label={_t("desktop|server_menu|leave")}
                onSelect={vm.leave}
                hideChevron
            />
        </>
    );
}
