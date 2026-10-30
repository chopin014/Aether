/*
 * Copyright 2025 New Vector Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import React, { type JSX, type MouseEventHandler, type SVGProps } from "react";
import { Button } from "@vector-im/compound-web";
import SearchIcon from "@vector-im/compound-design-tokens/assets/web/icons/search";
import DialPadIcon from "@vector-im/compound-design-tokens/assets/web/icons/dial-pad";

import styles from "./RoomListSearchView.module.css";
import { type ViewModel, useViewModel } from "../../core/viewmodel";
import { Flex } from "../../core/utils/Flex";
import { useI18n } from "../../core/i18n/i18nContext";

/** The arrow a map shows for where you are, for exploring rooms beyond your own. */
function NavigationIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
    return (
        <svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor" {...props}>
            <path
                d="M12 3.2 5.4 19.6a.6.6 0 0 0 .84.75L12 17.3l5.76 3.05a.6.6 0 0 0 .84-.75z"
                stroke="currentColor"
                strokeWidth={1.4}
                strokeLinejoin="round"
            />
        </svg>
    );
}

export interface RoomListSearchViewSnapshot {
    /**
     * Whether to display the explore button.
     */
    displayExploreButton: boolean;
    /**
     * Whether to display the dial pad button.
     */
    displayDialButton: boolean;
    /**
     * The keyboard shortcut text to display for the search action.
     * For example: "⌘ K" on macOS or "Ctrl K" on other platforms.
     */
    searchShortcut: string;
}

export interface RoomListSearchViewActions {
    /**
     * Handles the click event on the search button.
     */
    onSearchClick: MouseEventHandler<HTMLButtonElement>;
    /**
     * Handles the click event on the dial pad button.
     */
    onDialPadClick: MouseEventHandler<HTMLButtonElement>;
    /**
     * Handles the click event on the explore button.
     */
    onExploreClick: MouseEventHandler<HTMLButtonElement>;
}

/**
 * The view model for the room list search component.
 */
export type RoomListSearchViewModel = ViewModel<RoomListSearchViewSnapshot, RoomListSearchViewActions>;

interface RoomListSearchViewProps {
    /**
     * The view model for the room list search component.
     */
    vm: RoomListSearchViewModel;
}

/**
 * A search component to be displayed at the top of the room list.
 * The component provides search functionality, optional dial pad access, and optional room exploration.
 *
 * @example
 * ```tsx
 * <RoomListSearchView vm={roomListSearchViewModel} />
 * ```
 */
export function RoomListSearchView({ vm }: Readonly<RoomListSearchViewProps>): JSX.Element {
    const { translate: _t } = useI18n();
    const { displayExploreButton, displayDialButton, searchShortcut } = useViewModel(vm);

    return (
        <Flex
            data-testid="room-list-search"
            className={styles.view}
            role="search"
            gap="var(--cpd-space-2x)"
            align="center"
        >
            <Button
                id="room-list-search-button"
                className={styles.search}
                kind="secondary"
                size="md"
                Icon={SearchIcon}
                onClick={vm.onSearchClick}
            >
                <Flex className={styles["search_container"]} as="span" justify="space-between">
                    <span className={styles["search_text"]}>{_t("action|search")}</span>
                    <kbd>{searchShortcut}</kbd>
                </Flex>
            </Button>
            {displayDialButton && (
                <Button
                    className={styles.action}
                    kind="secondary"
                    size="md"
                    Icon={DialPadIcon}
                    iconOnly={true}
                    aria-label={_t("left_panel|open_dial_pad")}
                    onClick={vm.onDialPadClick}
                />
            )}
            {displayExploreButton && (
                <Button
                    className={styles.action}
                    kind="secondary"
                    size="md"
                    Icon={NavigationIcon}
                    iconOnly={true}
                    aria-label={_t("action|explore_rooms")}
                    onClick={vm.onExploreClick}
                />
            )}
        </Flex>
    );
}
