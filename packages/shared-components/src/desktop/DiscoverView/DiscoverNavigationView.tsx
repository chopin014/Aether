/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, useState } from "react";
import { Menu, MenuItem, Text } from "@vector-im/compound-web";
import {
    CheckIcon,
    ChevronDownIcon,
    PlusIcon,
    PublicIcon,
    RoomIcon,
    SpaceIcon,
} from "@vector-im/compound-design-tokens/assets/web/icons";

import { useViewModel } from "../../core/viewmodel";
import { useI18n } from "../../core/i18n/i18nContext";
import type { DiscoverSection, DiscoverViewModel } from "./DiscoverView";
import styles from "./DiscoverView.module.css";

/** Sidebar of the Discover page: Spaces or rooms, and which directory to browse. */
export function DiscoverNavigationView({ vm }: { vm: DiscoverViewModel }): JSX.Element {
    const { section, server, servers } = useViewModel(vm);
    const { translate: _t } = useI18n();
    const [menuOpen, setMenuOpen] = useState(false);
    const sections: { id: DiscoverSection; label: string; description: string; icon: JSX.Element }[] = [
        {
            id: "spaces",
            label: _t("desktop|discover|section_spaces"),
            description: _t("desktop|discover|section_spaces_description"),
            icon: <SpaceIcon />,
        },
        {
            id: "rooms",
            label: _t("desktop|discover|section_rooms"),
            description: _t("desktop|discover|section_rooms_description"),
            icon: <RoomIcon />,
        },
    ];

    return (
        <nav className={styles.navigation} aria-label={_t("desktop|discover|title")}>
            <header className={styles.navigationHeader}>
                <Text as="h2" size="lg" weight="semibold">
                    {_t("desktop|discover|title")}
                </Text>
            </header>
            <ul className={styles.sections}>
                {sections.map(({ id, label, description, icon }) => (
                    <li key={id}>
                        <button
                            type="button"
                            className={styles.sectionButton}
                            aria-current={section === id ? "page" : undefined}
                            onClick={() => vm.setSection(id)}
                        >
                            {icon}
                            <span className={styles.sectionText}>
                                <Text as="span" weight="medium">
                                    {label}
                                </Text>
                                <Text as="span" size="xs" className={styles.sectionDescription}>
                                    {description}
                                </Text>
                            </span>
                        </button>
                    </li>
                ))}
            </ul>
            <div className={styles.directory}>
                <Text as="h3" size="xs" weight="semibold" className={styles.directoryLabel}>
                    {_t("desktop|discover|directory")}
                </Text>
                <Menu
                    open={menuOpen}
                    onOpenChange={setMenuOpen}
                    title={_t("desktop|discover|directory")}
                    showTitle={false}
                    side="top"
                    align="start"
                    trigger={
                        <button
                            type="button"
                            className={styles.serverButton}
                            aria-label={_t("desktop|discover|change_directory", { server })}
                        >
                            <PublicIcon />
                            <Text as="span" weight="medium" className={styles.serverName}>
                                {server}
                            </Text>
                            <ChevronDownIcon />
                        </button>
                    }
                >
                    {servers.map((option) => (
                        <MenuItem
                            key={option.name}
                            Icon={option.name === server ? CheckIcon : PublicIcon}
                            label={option.name}
                            onSelect={() => vm.setServer(option.name)}
                            hideChevron
                        >
                            {option.isHome && (
                                <Text as="span" size="xs" className={styles.sectionDescription}>
                                    {_t("desktop|discover|your_server")}
                                </Text>
                            )}
                        </MenuItem>
                    ))}
                    <MenuItem
                        Icon={PlusIcon}
                        label={_t("desktop|discover|add_server")}
                        onSelect={vm.addServer}
                        hideChevron
                    />
                </Menu>
                <Text size="xs" className={styles.directoryHint}>
                    {_t("desktop|discover|directory_hint")}
                </Text>
            </div>
        </nav>
    );
}
