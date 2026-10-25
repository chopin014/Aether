/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { Text } from "@vector-im/compound-web";

import { AutoHideScrollbar } from "../../core/utils/Scrollbar";
import { RovingTabIndexProvider, RovingTabIndexWrapper } from "../../core/roving";
import { type ViewModel, useViewModel } from "../../core/viewmodel";
import styles from "./DesktopRoomSettingsView.module.css";

/** A translated room settings tab used to build the navigation list. */
export interface DesktopRoomSettingsTab {
    /** Stable tab identifier. */
    id: string;
    /** Visible and accessible tab label. */
    label: string;
    /** Optional icon shown before the label. */
    icon: React.ReactNode;
}

/** A translated group of available room settings tabs. */
export interface DesktopRoomSettingsTabGroup {
    /** Visible group heading. */
    label: string;
    /** Available tabs in this group. */
    tabs: readonly DesktopRoomSettingsTab[];
}

/** Data rendered by the desktop room settings view. */
export interface DesktopRoomSettingsViewSnapshot {
    /** Accessible label for the settings navigation. */
    navigationLabel: string;
    /** Visible groups and their available tabs. */
    groups: readonly DesktopRoomSettingsTabGroup[];
    /** Identifier for the selected tab and panel. */
    activeTabId: string;
    /** Legacy room settings body displayed in the selected panel. */
    activeTabContent: React.ReactNode;
}

/** User actions available from the desktop room settings view. */
export interface DesktopRoomSettingsViewActions {
    /** Select a room settings tab. */
    selectTab: (tabId: string) => void;
}

/** View model contract for the desktop room settings view. */
export type DesktopRoomSettingsViewModel = ViewModel<DesktopRoomSettingsViewSnapshot, DesktopRoomSettingsViewActions>;

interface DesktopRoomSettingsViewProps {
    /** View model providing room settings and selection actions. */
    vm: DesktopRoomSettingsViewModel;
}

function panelId(tabId: string): string {
    return `mx_tabpanel_${tabId}`;
}

function RoomSettingsTabButton({
    tab,
    selected,
    onSelect,
}: {
    tab: DesktopRoomSettingsTab;
    selected: boolean;
    onSelect: (tabId: string) => void;
}): JSX.Element {
    return (
        <RovingTabIndexWrapper>
            {({ onFocus, isActive, ref }) => (
                <button
                    ref={ref}
                    type="button"
                    className={styles.tab}
                    onFocus={() => {
                        onFocus();
                        if (!selected) onSelect(tab.id);
                    }}
                    tabIndex={isActive ? 0 : -1}
                    onClick={() => onSelect(tab.id)}
                    data-testid={`settings-tab-${tab.id}`}
                    role="tab"
                    aria-selected={selected}
                    aria-controls={panelId(tab.id)}
                    id={`${panelId(tab.id)}_label`}
                >
                    {tab.icon && (
                        <span className={styles.tabIcon} aria-hidden="true">
                            {tab.icon}
                        </span>
                    )}
                    <Text as="span" size="sm" weight="medium" className={styles.tabLabel}>
                        {tab.label}
                    </Text>
                </button>
            )}
        </RovingTabIndexWrapper>
    );
}

/**
 * Displays room settings in a channel-style navigation layout while keeping each settings tab's existing content.
 * @param props The view model containing translated settings tabs, the selected tab and its content.
 */
export function DesktopRoomSettingsView({ vm }: Readonly<DesktopRoomSettingsViewProps>): JSX.Element {
    const snapshot = useViewModel(vm);
    const activePanelId = panelId(snapshot.activeTabId);

    return (
        <div className={styles.layout}>
            <nav className={styles.navigation} aria-label={snapshot.navigationLabel}>
                <RovingTabIndexProvider handleLoop handleHomeEnd handleUpDown>
                    {({ onKeyDownHandler }) => (
                        <div
                            className={styles.tabList}
                            role="tablist"
                            aria-orientation="vertical"
                            tabIndex={-1}
                            onKeyDown={onKeyDownHandler}
                        >
                            {snapshot.groups.map((group) => (
                                <React.Fragment key={group.label}>
                                    <Text
                                        as="div"
                                        size="xs"
                                        weight="semibold"
                                        className={styles.groupLabel}
                                        role="presentation"
                                    >
                                        {group.label}
                                    </Text>
                                    {group.tabs.map((tab) => (
                                        <RoomSettingsTabButton
                                            key={tab.id}
                                            tab={tab}
                                            selected={tab.id === snapshot.activeTabId}
                                            onSelect={vm.selectTab}
                                        />
                                    ))}
                                </React.Fragment>
                            ))}
                        </div>
                    )}
                </RovingTabIndexProvider>
            </nav>
            <main className={styles.main}>
                <div
                    className={`${styles.tabPanel} mx_TabbedView_tabPanel`}
                    id={activePanelId}
                    role="tabpanel"
                    aria-labelledby={`${activePanelId}_label`}
                    tabIndex={0}
                >
                    <AutoHideScrollbar className={`${styles.panelContent} mx_TabbedView_tabPanelContent`}>
                        {snapshot.activeTabContent}
                    </AutoHideScrollbar>
                </div>
            </main>
        </div>
    );
}
