/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, type MouseEvent } from "react";
import classNames from "classnames";
import { IconButton } from "@vector-im/compound-web";
import { SettingsSolidIcon, UserAddSolidIcon } from "@vector-im/compound-design-tokens/assets/web/icons";

import { Flex } from "../../../../core/utils/Flex";
import { _t } from "../../../../core/i18n/i18n";
import { useViewModel } from "../../../../core/viewmodel";
import { type RoomListItemViewModel } from "./RoomListItemView";
import styles from "./RoomListItemView.module.css";

/** Props for {@link ChannelRowActions}. */
export interface ChannelRowActionsProps {
    /** The channel's room list item view model. */
    vm: RoomListItemViewModel;
    /** Whether the row also shows a notification badge, which the actions give way to on a selected row. */
    hasDecoration: boolean;
}

/**
 * The invite and edit buttons a desktop channel row shows while it is pointed at, focused or selected, as in
 * Discord. Everything else about the channel is in its context menu.
 */
export function ChannelRowActions({ vm, hasDecoration }: ChannelRowActionsProps): JSX.Element | null {
    const { canInvite, canEditChannel, name } = useViewModel(vm);
    if (!canInvite && !(canEditChannel && vm.onEditChannel)) return null;

    // The row itself opens the channel, so a click on one of its buttons must not reach it.
    const run =
        (action: () => void) =>
        (event: MouseEvent<HTMLButtonElement>): void => {
            event.stopPropagation();
            action();
        };

    return (
        <Flex
            className={classNames(styles.hoverMenu, styles.channelActions, { [styles.withDecoration]: hasDecoration })}
            align="center"
            gap="var(--cpd-space-1x)"
            // Keyboard navigation inside the buttons must not move the list's focus.
            onKeyDown={(event) => event.stopPropagation()}
        >
            {canInvite && (
                <IconButton
                    size="20px"
                    style={{ padding: "2px" }}
                    // The tooltip names the button, so it carries the channel's name as well.
                    tooltip={_t("desktop|channel_row|invite_to", { channel: name })}
                    aria-label={_t("desktop|channel_row|invite_to", { channel: name })}
                    onClick={run(vm.onInvite)}
                >
                    <UserAddSolidIcon />
                </IconButton>
            )}
            {canEditChannel && vm.onEditChannel && (
                <IconButton
                    size="20px"
                    style={{ padding: "2px" }}
                    tooltip={_t("desktop|channel_row|edit_named", { channel: name })}
                    aria-label={_t("desktop|channel_row|edit_named", { channel: name })}
                    onClick={run(vm.onEditChannel)}
                >
                    <SettingsSolidIcon />
                </IconButton>
            )}
        </Flex>
    );
}
