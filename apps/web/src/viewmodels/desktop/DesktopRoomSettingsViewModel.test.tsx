/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { describe, expect, it, vi } from "vitest";

import { Tab } from "../../components/structures/TabbedView";
import { RoomSettingsTab } from "../../components/views/dialogs/RoomSettingsDialog-tab";
import { DesktopRoomSettingsViewModel } from "./DesktopRoomSettingsViewModel";

describe("DesktopRoomSettingsViewModel", () => {
    it("groups available Matrix settings and forwards selection to the dialog", () => {
        const onTabChange = vi.fn();
        const general = new Tab(RoomSettingsTab.General, "common|general", null, <div>General body</div>);
        const security = new Tab(
            RoomSettingsTab.Security,
            "room_settings|security|title",
            null,
            <div>Security body</div>,
        );
        const permissions = new Tab(
            RoomSettingsTab.Roles,
            "room_settings|permissions|title",
            null,
            <div>Roles body</div>,
        );
        const vm = new DesktopRoomSettingsViewModel({
            roomName: "Build Room",
            tabs: [general, security, permissions],
            activeTabId: RoomSettingsTab.General,
            onTabChange,
        });

        expect(vm.getSnapshot().navigationLabel).toBe("Channel settings for Build Room");
        expect(vm.getSnapshot().groups.map((group) => group.tabs.map((tab) => tab.id))).toEqual([
            [RoomSettingsTab.General],
            [RoomSettingsTab.Security, RoomSettingsTab.Roles],
        ]);
        expect(vm.getSnapshot().activeTabContent).toEqual(<div>General body</div>);

        vm.selectTab(RoomSettingsTab.Roles);
        vm.selectTab("unknown");
        expect(onTabChange).toHaveBeenCalledTimes(1);
        expect(onTabChange).toHaveBeenCalledWith(RoomSettingsTab.Roles);

        vm.setProps({
            roomName: "Operations Room",
            tabs: [security, permissions],
            activeTabId: RoomSettingsTab.General,
            onTabChange,
        });
        expect(vm.getSnapshot().navigationLabel).toBe("Channel settings for Operations Room");
        expect(vm.getSnapshot().activeTabId).toBe(RoomSettingsTab.Security);
        expect(vm.getSnapshot().activeTabContent).toEqual(<div>Security body</div>);
    });
});
