/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import React, { type JSX, useState, useId } from "react";
import { IconButton, Menu, MenuItem, Separator } from "@vector-im/compound-web";
import ChevronDownIcon from "@vector-im/compound-design-tokens/assets/web/icons/chevron-down";
import HomeIcon from "@vector-im/compound-design-tokens/assets/web/icons/home";
import SettingsIcon from "@vector-im/compound-design-tokens/assets/web/icons/settings";
import ChatNewIcon from "@vector-im/compound-design-tokens/assets/web/icons/chat-new";
import AudioIcon from "@vector-im/compound-design-tokens/assets/web/icons/audio";
import UserAddIcon from "@vector-im/compound-design-tokens/assets/web/icons/user-add";

import styles from "./SpaceMenuView.module.css";
import { useViewModel } from "../../../core/viewmodel";
import { useI18n } from "../../../core/i18n/i18nContext";
import { type RoomListHeaderViewModel } from "../RoomListHeaderView";

interface SpaceMenuViewProps {
    /**
     * The view model for the room list header
     */
    vm: RoomListHeaderViewModel;
    /** Use the whole Space name as the menu trigger. */
    fullWidth?: boolean;
}

/**
 * A menu component that provides space-specific actions.
 * Displays a dropdown menu with options to navigate to space home, invite users,
 * and manage space settings. The full-width desktop menu also groups room creation actions.
 *
 * @example
 * ```tsx
 * <SpaceMenuView vm={roomListHeaderViewModel} />
 * ```
 */
export function SpaceMenuView({ vm, fullWidth = false }: SpaceMenuViewProps): JSX.Element {
    const { translate: _t } = useI18n();
    const { canInviteInSpace, canAccessSpaceSettings, canCreateRoom, canCreateVideoRoom, title } = useViewModel(vm);
    const [open, setOpen] = useState(false);
    const titleId = useId();

    return (
        <Menu
            open={open}
            onOpenChange={setOpen}
            title={title}
            showTitle={!fullWidth}
            className={fullWidth ? styles.desktopMenu : undefined}
            collisionPadding={fullWidth ? 8 : 0}
            align="start"
            trigger={
                fullWidth ? (
                    <button
                        className={styles.spaceTrigger}
                        aria-label={_t("room_list|open_space_menu")}
                        aria-describedby={titleId}
                        type="button"
                    >
                        <span id={titleId} title={title}>
                            {title}
                        </span>
                        <ChevronDownIcon aria-hidden />
                    </button>
                ) : (
                    <IconButton
                        className={styles.button}
                        aria-label={_t("room_list|open_space_menu")}
                        // 24px icon with a 20px icon
                        size="24px"
                        style={{ padding: "2px" }}
                    >
                        <ChevronDownIcon />
                    </IconButton>
                )
            }
        >
            {fullWidth && canInviteInSpace && (
                <MenuItem
                    className={styles.invite}
                    Icon={UserAddIcon}
                    label={_t("action|invite")}
                    onSelect={vm.inviteInSpace}
                    hideChevron
                />
            )}
            <MenuItem Icon={HomeIcon} label={_t("room_list|space_menu|home")} onSelect={vm.openSpaceHome} hideChevron />
            {!fullWidth && canInviteInSpace && (
                <MenuItem Icon={UserAddIcon} label={_t("action|invite")} onSelect={vm.inviteInSpace} hideChevron />
            )}
            {fullWidth && <Separator kind="secondary" />}
            {fullWidth && (canCreateRoom || canCreateVideoRoom) && (
                <>
                    {canCreateRoom && (
                        <MenuItem
                            Icon={ChatNewIcon}
                            label={_t("action|new_room")}
                            onSelect={vm.createRoom}
                            hideChevron
                        />
                    )}
                    {canCreateVideoRoom && (
                        <MenuItem
                            Icon={AudioIcon}
                            label={_t("action|new_voice_room")}
                            onSelect={vm.createVideoRoom}
                            hideChevron
                        />
                    )}
                    <Separator kind="secondary" />
                </>
            )}
            {canAccessSpaceSettings && (
                <MenuItem
                    Icon={SettingsIcon}
                    label={_t("room_list|space_menu|space_settings")}
                    onSelect={vm.openSpaceSettings}
                    hideChevron
                />
            )}
        </Menu>
    );
}
