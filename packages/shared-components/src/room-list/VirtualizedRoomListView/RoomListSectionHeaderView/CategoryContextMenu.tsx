/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, type ReactElement } from "react";
import { CheckboxMenuItem, ContextMenu, MenuItem, Separator } from "@vector-im/compound-web";
import {
    CheckIcon,
    CollapseIcon,
    DeleteIcon,
    EditIcon,
    PlusIcon,
} from "@vector-im/compound-design-tokens/assets/web/icons";

import { _t } from "../../../core/i18n/i18n";
import { useViewModel } from "../../../core/viewmodel";
import { type RoomListSectionHeaderViewModel } from "./RoomListSectionHeaderView";
import { MuteMenu } from "../../../desktop/MuteMenu";

/** Props for {@link CategoryContextMenu}. */
export interface CategoryContextMenuProps {
    vm: RoomListSectionHeaderViewModel;
    /** The category header, which right-clicking opens the menu on. */
    children: ReactElement;
}

/**
 * The menu a server category opens when its header is right-clicked, as in Discord: read, collapse, add a channel,
 * rename or delete it. Entries the person may not use are left out.
 */
export function CategoryContextMenu({ vm, children }: CategoryContextMenuProps): JSX.Element {
    const { title, isExpanded, isUnread, categoryMenu, createChannelKind } = useViewModel(vm);
    if (!categoryMenu) return children;
    const canAdd = !!createChannelKind && !!vm.createChannel;
    return (
        <ContextMenu
            title={_t("desktop|category_menu|title", { category: title })}
            showTitle={false}
            // The header toggles the category itself, and the server's menu creates channels and categories.
            hasAccessibleAlternative={true}
            trigger={children}
        >
            {isUnread && vm.markCategoryAsRead && (
                <MenuItem
                    Icon={CheckIcon}
                    label={_t("desktop|category_menu|mark_read")}
                    onSelect={vm.markCategoryAsRead}
                    hideChevron
                />
            )}
            <CheckboxMenuItem
                label={_t("desktop|category_menu|collapse")}
                checked={!isExpanded}
                onSelect={() => vm.onClick()}
            />
            {vm.collapseAllCategories && (
                <MenuItem
                    Icon={CollapseIcon}
                    label={_t("desktop|category_menu|collapse_all")}
                    onSelect={vm.collapseAllCategories}
                    hideChevron
                />
            )}
            {vm.muteCategory && vm.unmuteCategory && (
                <>
                    <Separator />
                    <MuteMenu
                        muteLabel={_t("desktop|category_menu|mute")}
                        unmuteLabel={_t("desktop|category_menu|unmute")}
                        isMuted={!!categoryMenu.isMuted}
                        mutedUntil={categoryMenu.mutedUntil}
                        onMute={vm.muteCategory}
                        onUnmute={vm.unmuteCategory}
                    />
                </>
            )}
            {(canAdd || categoryMenu.canEdit) && <Separator />}
            {canAdd && (
                <MenuItem
                    Icon={PlusIcon}
                    label={_t("desktop|category_menu|create_channel")}
                    onSelect={() => vm.createChannel?.()}
                    hideChevron
                />
            )}
            {categoryMenu.canEdit && vm.editCategory && (
                <MenuItem
                    Icon={EditIcon}
                    label={_t("desktop|category_menu|edit")}
                    onSelect={vm.editCategory}
                    hideChevron
                />
            )}
            {categoryMenu.canEdit && vm.deleteCategory && (
                <MenuItem
                    Icon={DeleteIcon}
                    kind="critical"
                    label={_t("desktop|category_menu|delete")}
                    onSelect={vm.deleteCategory}
                    hideChevron
                />
            )}
        </ContextMenu>
    );
}
