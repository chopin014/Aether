/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, type ReactElement } from "react";
import { CheckboxMenuItem, ContextMenu, MenuItem, Separator } from "@vector-im/compound-web";
import { FolderIcon, PlusIcon, UserAddIcon } from "@vector-im/compound-design-tokens/assets/web/icons";

import { _t } from "../../core/i18n/i18n";

/** What the menu of a server's channel list offers. */
export interface ChannelListMenuSnapshot {
    /** Whether the person hides this server's muted channels. */
    hideMutedChannels: boolean;
    /** Whether the person may create channels in this server. */
    canCreateChannel: boolean;
    /** Whether the person may create categories in this server. */
    canCreateCategory: boolean;
    /** Whether the person may invite people to this server. */
    canInvite: boolean;
}

/** The actions of a server's channel list menu. */
export interface ChannelListMenuActions {
    toggleHideMutedChannels: () => void;
    createChannel: () => void;
    createCategory: () => void;
    inviteToServer: () => void;
}

/** Props for {@link ChannelListContextMenu}. */
export interface ChannelListContextMenuProps {
    menu: ChannelListMenuSnapshot;
    actions: ChannelListMenuActions;
    /** The area right-clicking opens the menu on. Channels and categories open their own menus instead. */
    children: ReactElement;
}

/**
 * The menu a server's channel list opens when its empty space is right-clicked, as in Discord: hide the muted
 * channels, create a channel or a category, or invite people.
 */
export function ChannelListContextMenu({ menu, actions, children }: ChannelListContextMenuProps): JSX.Element {
    const canCreate = menu.canCreateChannel || menu.canCreateCategory || menu.canInvite;
    return (
        <ContextMenu
            title={_t("desktop|channel_list_menu|title")}
            showTitle={false}
            // Everything here is also in the server's menu above the list.
            hasAccessibleAlternative={true}
            trigger={children}
        >
            <CheckboxMenuItem
                label={_t("desktop|channel_list_menu|hide_muted")}
                checked={menu.hideMutedChannels}
                onSelect={actions.toggleHideMutedChannels}
            />
            {canCreate && <Separator />}
            {menu.canCreateChannel && (
                <MenuItem
                    Icon={PlusIcon}
                    label={_t("desktop|channel_list_menu|create_channel")}
                    onSelect={actions.createChannel}
                    hideChevron
                />
            )}
            {menu.canCreateCategory && (
                <MenuItem
                    Icon={FolderIcon}
                    label={_t("desktop|channel_list_menu|create_category")}
                    onSelect={actions.createCategory}
                    hideChevron
                />
            )}
            {menu.canInvite && (
                <MenuItem
                    Icon={UserAddIcon}
                    label={_t("desktop|channel_list_menu|invite")}
                    onSelect={actions.inviteToServer}
                    hideChevron
                />
            )}
        </ContextMenu>
    );
}
