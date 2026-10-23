/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import React, { type JSX } from "react";
import { Avatar, Button, Link, Menu, MenuItem, Separator, Text } from "@vector-im/compound-web";
import {
    ChatProblemIcon,
    DevicesIcon,
    EditIcon,
    HomeIcon,
    LockIcon,
    SettingsIcon,
    UserProfileIcon,
} from "@vector-im/compound-design-tokens/assets/web/icons";
import classNames from "classnames";

import { PresenceMenuView, PresenceSummaryView, type PresenceViewModel } from "../../presence/PresenceMenuView";

import styles from "./UserMenu.module.css";
import { useViewModel, type ViewModel } from "../../core/viewmodel";
import { useI18n } from "../../core/i18n/i18nContext";
import { type UserStatus } from "../../core/userStatus";
import { SetStatusView, type SetStatusViewModel } from "../../status/SetStatusView";

export interface UserMenuViewSnapshot {
    /**
     * Is the menu open or closed.
     */
    open: boolean;
    /** Presence controls for authenticated accounts, independent of the custom status text. */
    presence?: PresenceViewModel;
    /**
     * Is the menu toggle expanded (avatar + displayname) or collapsed (avatar).
     */
    expanded: boolean;
    /**
     * Avatar URL for the user, if one is set.
     */
    avatarUrl?: string;
    /**
     * Should the avatar be visible.
     */
    showAvatar?: boolean;
    /**
     * Display name for the user.
     */
    displayName: string;
    /**
     * Matrix user ID for the user.
     */
    userId: string;
    /**
     * The user status to display, or undefined for no icon / status.
     */
    userStatus?: UserStatus;
    /**
     * Whether to show UI for user status.
     * Temporary while user status is in labs.
     * Default: true
     */
    showUserStatus?: boolean;
    /**
     * ViewModel for the set status view.
     */
    setStatusViewModel: SetStatusViewModel;
    /**
     * A set of actions that the user can perform from the menu.
     */
    actions: Partial<{
        editProfile: boolean;
        createAccount: boolean;
        signIn: boolean;
        openHomePage: boolean;
        linkNewDevice: boolean;
        openSecurity: boolean;
        openFeedback: boolean;
        openSettings: boolean;
    }>;
}

export declare interface UserMenuViewActions {
    /**
     * Called when the menu is opened or closed.
     */
    setOpen: (open: boolean) => void;
    /**
     * Called to change the user's avatar and display name.
     */
    editProfile: () => void;
    /**
     * Called to open the create new account view.
     */
    createAccount: () => void;
    /**
     * Called to open the sign in view.
     */
    signIn: () => void;
    /**
     * Called to change the view to the configured home page.
     */
    openHomePage: () => void;
    /**
     * Called to open the link new device flow.
     */
    linkNewDevice: () => void;
    /**
     * Called to open the security tab of the settings dialog.
     */
    openSecurity: () => void;
    /**
     * Called to open the feedback dialog.
     */
    openFeedback: () => void;
    /**
     * Called to open the settings dialog.
     */
    openSettings: () => void;
    /**
     * Called when the user clicks the button to clear their status.
     */
    clearStatus: () => void;
}

export type UserMenuViewProps = {
    vm: ViewModel<UserMenuViewSnapshot, UserMenuViewActions>;
    /**
     * Class name for the wrapper
     */
    className?: string;
    /** Render the full identity inside the account-dock menu trigger. */
    presentation?: "rail" | "dock";
};

export function UserMenuView({ vm, className, presentation = "rail" }: UserMenuViewProps): JSX.Element {
    const {
        userId,
        displayName,
        avatarUrl,
        expanded,
        open,
        presence,
        actions,
        showAvatar,
        userStatus,
        setStatusViewModel,
        showUserStatus = true,
    } = useViewModel(vm);
    const { translate: _t } = useI18n();
    const isDock = presentation === "dock";
    const trigger = (
        <button
            className={classNames(styles.triggerButton, { [styles.dockTrigger]: isDock })}
            aria-label={_t("menus|user_menu|title")}
            type="button"
        >
            <div className={styles.avatarWrapper}>
                <Avatar
                    id={userId}
                    name={displayName}
                    type="round"
                    size="36px"
                    src={avatarUrl}
                    className={userStatus ? styles.avatarWithStatus : undefined}
                />
                {userStatus && (
                    <Text as="div" className={styles.iconStatusEmoji}>
                        {userStatus.emoji}
                    </Text>
                )}
                {isDock && presence && <PresenceSummaryView vm={presence} compact />}
            </div>
            {isDock && (
                <span className={styles.identity}>
                    <Text as="span" size="sm" weight="semibold">
                        {displayName}
                    </Text>
                    <Text as="span" size="xs" className={styles.matrixId}>
                        {userId}
                    </Text>
                </span>
            )}
        </button>
    );

    // The menu should appear to the right of the avatar, over the displayname if the menu is expanded,
    // so the display name goes outside the menu block in a wrapper.
    return (
        <div className={classNames(styles.wrapper, { [styles.dockWrapper]: isDock }, className)}>
            <Menu
                open={open}
                showTitle={false}
                title={_t("menus|user_menu|title")}
                trigger={trigger}
                onOpenChange={vm.setOpen}
                align="start"
                side={isDock ? "top" : "right"}
                className={styles.container}
            >
                <section className={classNames(styles.profile, styles.profilePrimary)}>
                    {showAvatar &&
                        (actions.editProfile ? (
                            // Clicking your own picture is the quickest way to change it, as in Discord
                            <button
                                type="button"
                                className={styles.editableAvatar}
                                aria-label={_t("user_menu|edit_profile")}
                                onClick={vm.editProfile}
                            >
                                <Avatar id={userId} name={displayName} type="round" size="64px" src={avatarUrl} />
                                <span className={styles.editableAvatarBadge} aria-hidden="true">
                                    <EditIcon />
                                </span>
                            </button>
                        ) : (
                            <Avatar id={userId} name={displayName} type="round" size="64px" src={avatarUrl} />
                        ))}
                    <Text
                        className={classNames(styles.displayname, styles.constrainedText)}
                        type="body"
                        size="lg"
                        weight="semibold"
                        as="span"
                    >
                        {displayName}
                    </Text>
                    {showUserStatus && <SetStatusView vm={setStatusViewModel} />}
                </section>
                <section className={classNames(styles.profile, styles.profileSecondary)}>
                    <Text
                        data-testid="userId"
                        size="md"
                        as="span"
                        type="body"
                        className={classNames(styles.userId, styles.constrainedText)}
                    >
                        {userId}
                    </Text>
                    {actions.createAccount && (
                        <Button
                            className={styles.createAccount}
                            size="md"
                            as="button"
                            kind="primary"
                            onClick={vm.createAccount}
                        >
                            {_t("menus|user_menu|create_an_account")}
                        </Button>
                    )}
                    {actions.signIn && (
                        <Text as="span" weight="medium">
                            {_t("menus|user_menu|got_an_account")}
                            <Link as="button" onClick={vm.signIn}>
                                {_t("menus|user_menu|sign_in")}
                            </Link>
                        </Text>
                    )}
                </section>
                {presence && (
                    <>
                        <Separator />
                        <PresenceMenuView vm={presence} />
                    </>
                )}
                <Separator />
                <section className={styles.actions}>
                    {actions.editProfile && (
                        <MenuItem
                            Icon={UserProfileIcon}
                            label={_t("user_menu|edit_profile")}
                            onSelect={vm.editProfile}
                        />
                    )}
                    {actions.openHomePage && (
                        <MenuItem Icon={HomeIcon} label={_t("user_menu|open_home")} onSelect={vm.openHomePage} />
                    )}
                    {actions.linkNewDevice && (
                        <MenuItem
                            Icon={DevicesIcon}
                            label={_t("user_menu|link_new_device")}
                            onSelect={vm.linkNewDevice}
                        />
                    )}
                    {actions.openSecurity && (
                        <MenuItem Icon={LockIcon} label={_t("user_menu|open_security")} onSelect={vm.openSecurity} />
                    )}
                    {actions.openFeedback && (
                        <MenuItem
                            Icon={ChatProblemIcon}
                            label={_t("user_menu|open_feedback")}
                            onSelect={vm.openFeedback}
                        />
                    )}
                    {actions.openSettings && (
                        <MenuItem
                            Icon={SettingsIcon}
                            label={_t("user_menu|open_settings")}
                            onSelect={vm.openSettings}
                        />
                    )}
                </section>
            </Menu>
            {expanded && !isDock && (
                <Text type="heading" size="sm" as="span" weight="semibold" className={styles.displayName}>
                    {displayName}
                </Text>
            )}
        </div>
    );
}
