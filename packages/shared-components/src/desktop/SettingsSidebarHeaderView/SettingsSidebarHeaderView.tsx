/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, type KeyboardEvent } from "react";
import { Avatar, Text } from "@vector-im/compound-web";
import { ChevronRightIcon, SearchIcon } from "@vector-im/compound-design-tokens/assets/web/icons";

import { type ViewModel, useViewModel } from "../../core/viewmodel";
import { useI18n } from "../../core/i18n/i18nContext";
import styles from "./SettingsSidebarHeaderView.module.css";

/** Who is signed in, and what they are searching the settings for. */
export interface SettingsSidebarHeaderViewSnapshot {
    userId: string;
    displayName: string;
    avatarUrl?: string;
    /** The text in the search field. */
    query: string;
}

/** What the top of the settings sidebar can do. */
export interface SettingsSidebarHeaderViewActions {
    /** Opens the profile editor. */
    editProfile: () => void;
    setQuery: (query: string) => void;
    /** Opens the first page that matches the search. */
    openFirstMatch: () => void;
}

/** View model contract for the top of the settings sidebar. */
export type SettingsSidebarHeaderViewModel = ViewModel<
    SettingsSidebarHeaderViewSnapshot,
    SettingsSidebarHeaderViewActions
>;

interface Props {
    vm: SettingsSidebarHeaderViewModel;
}

/** The top of the settings sidebar: the signed-in user, a link to their profile, and a search over the pages. */
export function SettingsSidebarHeaderView({ vm }: Props): JSX.Element {
    const { translate: _t } = useI18n();
    const { userId, displayName, avatarUrl, query } = useViewModel(vm);

    const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
        if (event.key === "Enter") {
            event.preventDefault();
            vm.openFirstMatch();
        } else if (event.key === "Escape" && query) {
            // Clears the search instead of closing the dialog.
            event.stopPropagation();
            vm.setQuery("");
        }
    };

    return (
        <div className={styles.header}>
            <button type="button" className={styles.user} onClick={vm.editProfile}>
                <Avatar id={userId} name={displayName} src={avatarUrl} size="36px" type="round" />
                <span className={styles.userText}>
                    <Text as="span" weight="semibold" className={styles.name}>
                        {displayName}
                    </Text>
                    <Text as="span" size="xs" className={styles.editProfile}>
                        {_t("desktop|settings_sidebar|edit_profile")}
                        <ChevronRightIcon aria-hidden="true" className={styles.chevron} />
                    </Text>
                </span>
            </button>
            <label className={styles.search}>
                <SearchIcon aria-hidden="true" className={styles.searchIcon} />
                <input
                    type="search"
                    className={styles.searchInput}
                    placeholder={_t("desktop|settings_sidebar|search_placeholder")}
                    aria-label={_t("desktop|settings_sidebar|search_label")}
                    value={query}
                    onChange={(event) => vm.setQuery(event.target.value)}
                    onKeyDown={onKeyDown}
                />
            </label>
        </div>
    );
}
