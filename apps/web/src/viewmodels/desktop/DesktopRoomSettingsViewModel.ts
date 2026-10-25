/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { BaseViewModel } from "@element-hq/web-shared-components";
import type {
    DesktopRoomSettingsTab,
    DesktopRoomSettingsViewModel as DesktopRoomSettingsViewModelContract,
    DesktopRoomSettingsViewSnapshot,
} from "@element-hq/web-shared-components";

import { type NonEmptyArray } from "../../@types/common";
import { _t, _td } from "../../languageHandler";
import { RoomSettingsTab } from "../../components/views/dialogs/RoomSettingsDialog-tab";
import type { Tab } from "../../components/structures/TabbedView";

/** Inputs from the legacy settings tabs needed to present the desktop navigation. */
export interface DesktopRoomSettingsViewModelProps {
    /** Current room name used in the navigation's accessible label. */
    roomName: string;
    /** Existing Matrix settings tabs and their original content. */
    tabs: NonEmptyArray<Tab<RoomSettingsTab>>;
    /** Selected settings tab. */
    activeTabId: RoomSettingsTab;
    /** Existing dialog action for changing the active tab. */
    onTabChange: (tabId: RoomSettingsTab) => void;
}

const roomSettingsGroups = [
    { label: _td("desktop|channel_settings|group_channel"), tabIds: [RoomSettingsTab.General] },
    { label: _td("desktop|channel_settings|group_access"), tabIds: [RoomSettingsTab.Security, RoomSettingsTab.Roles] },
    {
        label: _td("desktop|channel_settings|group_activity"),
        tabIds: [
            RoomSettingsTab.People,
            RoomSettingsTab.Voip,
            RoomSettingsTab.Notifications,
            RoomSettingsTab.PollHistory,
        ],
    },
    { label: _td("desktop|channel_settings|group_integrations"), tabIds: [RoomSettingsTab.Bridges] },
    { label: _td("desktop|channel_settings|group_advanced"), tabIds: [RoomSettingsTab.Advanced] },
] as const;

/** Return the channel-settings label for a Matrix settings tab. */
export function desktopRoomSettingsTabLabel(tab: Tab<RoomSettingsTab>): TranslationKey {
    switch (tab.id) {
        case RoomSettingsTab.General:
            return _td("desktop|channel_settings|overview");
        case RoomSettingsTab.Roles:
            return _td("desktop|channel_settings|permissions");
        case RoomSettingsTab.Voip:
            return _td("desktop|channel_settings|voice");
        case RoomSettingsTab.Notifications:
            return _td("desktop|channel_settings|notifications");
        default:
            return tab.label;
    }
}

function createSnapshot(props: DesktopRoomSettingsViewModelProps): DesktopRoomSettingsViewSnapshot {
    const activeTab = props.tabs.find((tab) => tab.id === props.activeTabId) ?? props.tabs[0];
    const tabGroups = roomSettingsGroups.flatMap((group) => {
        const tabs = group.tabIds.flatMap((tabId) => {
            const tab = props.tabs.find((candidate) => candidate.id === tabId);
            if (!tab) return [];

            const viewTab: DesktopRoomSettingsTab = {
                id: tab.id,
                label: _t(desktopRoomSettingsTabLabel(tab)),
                icon: tab.icon,
            };
            return [viewTab];
        });
        return tabs.length > 0 ? [{ label: _t(group.label), tabs }] : [];
    });

    return {
        navigationLabel: _t("desktop|channel_settings|aria_label", { roomName: props.roomName }),
        groups: tabGroups,
        activeTabId: activeTab.id,
        activeTabContent: activeTab.body,
    };
}

/**
 * Adapts the existing Matrix room settings tabs to the shared desktop settings view.
 * The room settings dialog remains the source of truth for the selected tab and its behavior.
 */
export class DesktopRoomSettingsViewModel
    extends BaseViewModel<DesktopRoomSettingsViewSnapshot, DesktopRoomSettingsViewModelProps>
    implements DesktopRoomSettingsViewModelContract
{
    public constructor(props: DesktopRoomSettingsViewModelProps) {
        super(props, createSnapshot(props));
    }

    /** Refresh the view snapshot after the dialog room or selected tab changes. */
    public setProps = (props: DesktopRoomSettingsViewModelProps): void => {
        this.props = props;
        this.snapshot.set(createSnapshot(props));
    };

    /** Forward a tab selection to the existing dialog state. */
    public selectTab = (tabId: string): void => {
        const tab = this.props.tabs.find((candidate) => candidate.id === tabId);
        if (tab) this.props.onTabChange(tab.id);
    };
}
