/*
Copyright 2024 New Vector Ltd.
Copyright 2022 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// @vitest-environment happy-dom

import React, { type ReactElement } from "react";
import { vi, describe, it, expect, beforeEach, type MockedObject } from "vitest";
import { render, screen, waitFor } from "test-utils-rtl";
import userEvent from "@testing-library/user-event";
import { ClientEvent, MatrixEvent, type MatrixClient } from "matrix-js-sdk/src/matrix";
import {
    getMockClientWithEventEmitter,
    mockClientMethodsUser,
    mockClientMethodsServer,
    mockPlatformPeg,
    mockClientMethodsCrypto,
    mockClientMethodsRooms,
    useMockMediaDevices,
    TestSDKContext,
} from "test-utils";
import { makeDelegatedAuthMetadata } from "test-utils/auth.ts";

import SettingsStore, { type CallbackFn } from "../../../settings/SettingsStore";
import SdkConfig from "../../../SdkConfig";
import { UserTab } from "./UserTab";
import UserSettingsDialog from "./UserSettingsDialog";
import { UIFeature } from "../../../settings/UIFeature";
import { SettingLevel } from "../../../settings/SettingLevel";
import { type FeatureSettingKey } from "../../../settings/Settings.tsx";
import defaultDispatcher from "../../../dispatcher/dispatcher";

mockPlatformPeg({
    supportsSpellCheckSettings: vi.fn().mockReturnValue(false),
    getAppVersion: vi.fn().mockResolvedValue("1"),
});

// Signing out only asks first when keys are at risk, which these tests do not set up.
vi.mock("./LogoutDialog", () => ({ default: vi.fn(), shouldShowLogoutDialog: vi.fn().mockResolvedValue(false) }));

vi.mock("../../../settings/SettingsStore", () => ({
    default: {
        getValue: vi.fn(),
        getValueAt: vi.fn(),
        canSetValue: vi.fn(),
        monitorSetting: vi.fn(),
        watchSetting: vi.fn(),
        unwatchSetting: vi.fn(),
        getFeatureSettingNames: vi.fn(),
        getBetaInfo: vi.fn(),
        getDisplayName: vi.fn(),
        getDescription: vi.fn(),
        shouldHaveWarning: vi.fn(),
        disabledMessage: vi.fn(),
        settingIsOveriddenAtConfigLevel: vi.fn(),
        doesSettingSupportLevel: vi.fn(),
    },
}));

describe("<UserSettingsDialog />", () => {
    const userId = "@alice:server.org";
    const mockSettingsStore = vi.mocked(SettingsStore);
    let mockClient!: MockedObject<MatrixClient>;

    let sdkContext: TestSDKContext;
    const defaultProps = { onFinished: vi.fn() };
    const getComponent = (
        props: Partial<typeof defaultProps & { initialTabId?: UserTab; props: Record<string, any> }> = {},
    ): ReactElement => <UserSettingsDialog sdkContext={sdkContext} {...defaultProps} {...props} />;

    beforeEach(() => {
        vi.clearAllMocks();
        mockClient = getMockClientWithEventEmitter({
            ...mockClientMethodsUser(userId),
            ...mockClientMethodsServer(),
            ...mockClientMethodsCrypto(),
            ...mockClientMethodsRooms(),
            getIgnoredUsers: vi.fn().mockResolvedValue([]),
            getPushers: vi.fn().mockResolvedValue({ pushers: [] }),
            getDevices: vi.fn().mockResolvedValue({ devices: [] }),
            getProfileInfo: vi.fn().mockResolvedValue({}),
            getMediaConfig: vi.fn().mockResolvedValue({}),
            getAuthMetadata: vi.fn().mockResolvedValue(makeDelegatedAuthMetadata()),
            getSyncState: vi.fn().mockReturnValue("SYNCING"),
        });
        vi.mocked(mockClient.getCrypto()!.getUserDeviceInfo).mockResolvedValue(new Map());
        sdkContext = new TestSDKContext();
        sdkContext._client = mockClient;
        mockSettingsStore.getValue.mockReturnValue(false);
        mockSettingsStore.getValueAt.mockReturnValue(false);
        mockSettingsStore.getFeatureSettingNames.mockReturnValue([]);
        SdkConfig.reset();
        SdkConfig.put({ brand: "Test" });
    });

    const getActiveTabLabel = (container: Element) =>
        container.querySelector(".mx_TabbedView_tabLabel_active")?.textContent;

    it("should render general settings tab when no initialTabId", () => {
        const { container } = render(getComponent());

        expect(getActiveTabLabel(container)).toEqual("Account");
    });

    it("should render initial tab when initialTabId is set", () => {
        const { container } = render(getComponent({ initialTabId: UserTab.Help }));

        expect(getActiveTabLabel(container)).toEqual("Help & About");
    });

    it("should render general tab if initialTabId tab cannot be rendered", () => {
        // mjolnir tab is only rendered in some configs
        const { container } = render(getComponent({ initialTabId: UserTab.Mjolnir }));

        expect(getActiveTabLabel(container)).toEqual("Account");
    });

    it("renders tabs correctly", () => {
        SdkConfig.add({
            show_labs_settings: true,
        });
        const { container } = render(getComponent());
        expect(container.querySelectorAll(".mx_TabbedView_tabLabel")).toMatchSnapshot();
    });

    it("shows the Updates tab in the desktop shell", () => {
        const originalElectron = window.electron;
        window.electron = {} as Electron;
        try {
            const { container, getByTestId } = render(getComponent({ initialTabId: UserTab.Updates }));

            expect(getByTestId(`settings-tab-${UserTab.Updates}`)).toBeTruthy();
            expect(getActiveTabLabel(container)).toEqual("Updates");
        } finally {
            window.electron = originalElectron;
        }
    });

    it("renders ignored users tab when feature_mjolnir is enabled", () => {
        mockSettingsStore.getValue.mockImplementation((settingName) => settingName === "feature_mjolnir");
        const { getByTestId } = render(getComponent());
        expect(getByTestId(`settings-tab-${UserTab.Mjolnir}`)).toBeTruthy();
    });

    it("renders voip tab when voip is enabled", () => {
        mockSettingsStore.getValue.mockImplementation((settingName: any): any => settingName === UIFeature.Voip);
        const { getByTestId } = render(getComponent());
        expect(getByTestId(`settings-tab-${UserTab.Voice}`)).toBeTruthy();
    });

    it("renders with session manager tab selected", () => {
        const { getByTestId } = render(getComponent({ initialTabId: UserTab.SessionManager }));
        expect(getByTestId(`settings-tab-${UserTab.SessionManager}`)).toBeTruthy();
        expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Settings: Devices");
    });

    it("renders with appearance tab selected", () => {
        const { container } = render(getComponent({ initialTabId: UserTab.Appearance }));

        expect(getActiveTabLabel(container)).toEqual("Appearance");
        expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Settings: Appearance");
    });

    it("renders with notifications tab selected", () => {
        const { container } = render(getComponent({ initialTabId: UserTab.Notifications }));

        expect(getActiveTabLabel(container)).toEqual("Notifications");
        expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Settings: Notifications");
    });

    it.each([
        [UserTab.Chat, "Chat"],
        [UserTab.LanguageAndTime, "Language & time"],
        [UserTab.System, "System"],
    ])("renders with the %s tab selected", (tabId, label) => {
        const { container } = render(getComponent({ initialTabId: tabId }));

        expect(getActiveTabLabel(container)).toEqual(label);
        expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(`Settings: ${label}`);
    });

    it("lists the tabs under user, app and about headings", () => {
        const { container } = render(getComponent());
        const headings = [...container.querySelectorAll(".mx_TabbedView_tabGroup")].map((h) => h.textContent);
        expect(headings).toEqual(["User settings", "App settings", "About"]);
    });

    it("renders with keyboard tab selected", () => {
        const { container } = render(getComponent({ initialTabId: UserTab.Keyboard }));

        expect(getActiveTabLabel(container)).toEqual("Keyboard");
        expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Settings: Keyboard");
    });

    it("renders with voip tab selected", () => {
        useMockMediaDevices();
        mockSettingsStore.getValue.mockImplementation((settingName: any): any => settingName === UIFeature.Voip);
        const { container } = render(getComponent({ initialTabId: UserTab.Voice }));

        expect(getActiveTabLabel(container)).toEqual("Voice & Video");
        expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Settings: Voice & Video");
    });

    it("renders with security tab selected", () => {
        const { container } = render(getComponent({ initialTabId: UserTab.Security }));

        expect(getActiveTabLabel(container)).toEqual("Security & Privacy");
        expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Settings: Security & Privacy");
    });

    it("renders with mjolnir tab selected", () => {
        mockSettingsStore.getValue.mockImplementation((settingName): any => settingName === "feature_mjolnir");
        const { container } = render(getComponent({ initialTabId: UserTab.Mjolnir }));
        expect(getActiveTabLabel(container)).toEqual("Ignored users");
        expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Ignored Users");
    });

    it("renders with help tab selected", () => {
        const { container } = render(getComponent({ initialTabId: UserTab.Help }));

        expect(getActiveTabLabel(container)).toEqual("Help & About");
        expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Settings: Help & About");
    });

    it("never renders a labs tab, even when the config asks for one or a feature is in beta", () => {
        SdkConfig.add({
            show_labs_settings: true,
        });
        mockSettingsStore.getFeatureSettingNames.mockReturnValue([
            "feature_beta_setting",
        ] as unknown[] as FeatureSettingKey[]);
        mockSettingsStore.getBetaInfo.mockReturnValue({} as any);
        render(getComponent());
        expect(screen.queryByRole("tab", { name: "Labs" })).not.toBeInTheDocument();
    });

    it("watches settings", async () => {
        const watchSettingCallbacks: Record<string, CallbackFn<any>> = {};

        mockSettingsStore.watchSetting.mockImplementation((settingName, roomId, callback) => {
            watchSettingCallbacks[settingName] = callback;
            return `mock-watcher-id-${settingName}`;
        });
        mockSettingsStore.getValue.mockReturnValue(false);

        const { queryByTestId, findByTestId, unmount } = render(getComponent());
        expect(queryByTestId(`settings-tab-${UserTab.Mjolnir}`)).toBeFalsy();

        expect(mockSettingsStore.watchSetting).toHaveBeenCalledWith("feature_mjolnir", null, expect.anything());

        // call the watch setting callback
        mockSettingsStore.getValue.mockReturnValue(true);
        watchSettingCallbacks["feature_mjolnir"]("feature_mjolnir", "", SettingLevel.ACCOUNT, true, true);

        // tab is rendered now
        await expect(findByTestId(`settings-tab-${UserTab.Mjolnir}`)).resolves.toBeTruthy();

        unmount();

        // unwatches settings on unmount
        expect(mockSettingsStore.unwatchSetting).toHaveBeenCalledWith("mock-watcher-id-feature_mjolnir");
    });

    it("displays an indicator when user needs to set up recovery", async () => {
        // Initially, the user doesn't have secret storage, so it should display
        // an indicator.
        vi.mocked(mockClient.secretStorage.getDefaultKeyId).mockResolvedValue(null);

        const { container } = render(getComponent());

        await waitFor(() => {
            expect(container.querySelector(".mx_SettingsDialog_tabLabelsAlert")).toBeInTheDocument();
        });

        // Test that the handler ignores unknown account data
        mockClient.emit(ClientEvent.AccountData, new MatrixEvent({ type: "bar" }));

        // The user now has secret storage.  Trigger an update and check that
        // the indicator disappears.
        vi.mocked(mockClient.secretStorage.getDefaultKeyId).mockResolvedValue("foo");
        mockClient.emit(ClientEvent.AccountData, new MatrixEvent({ type: "m.secret_storage.default_key" }));

        await waitFor(() => {
            expect(container.querySelector(".mx_SettingsDialog_tabLabelsAlert")).not.toBeInTheDocument();
        });
    });

    describe("in the desktop shell", () => {
        beforeEach(() => {
            mockSettingsStore.getValue.mockImplementation((name): any => name === "feature_desktop_shell");
            mockClient.getThreePids = vi.fn().mockResolvedValue({ threepids: [] });
        });

        it("opens each page with its title and what it is for", () => {
            render(getComponent({ initialTabId: UserTab.Chat }));
            const header = document.querySelector(".mx_TabbedView_pageHeader")!;
            expect(header).toHaveTextContent("Chat");
            expect(header).toHaveTextContent("How messages look and how you write them.");
        });

        it("names the account and privacy pages for what they hold", () => {
            render(getComponent());
            expect(screen.getByRole("tab", { name: "My account" })).toBeInTheDocument();
            expect(screen.getByRole("tab", { name: "Privacy & security" })).toBeInTheDocument();
        });

        it("filters the pages by what is on them and opens the first match on Enter", async () => {
            render(getComponent());
            const search = screen.getByRole("searchbox", { name: "Search settings" });

            await userEvent.type(search, "timezone");
            expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Language & time"]);
            await userEvent.clear(search);
            await userEvent.type(search, "password{Enter}");
            expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["My account"]);
            expect(screen.getByRole("tab", { name: "My account" })).toHaveAttribute("aria-selected", "true");
        });

        it("says when nothing matches the search", async () => {
            render(getComponent());
            await userEvent.type(screen.getByRole("searchbox", { name: "Search settings" }), "zzzz");
            expect(screen.queryAllByRole("tab")).toHaveLength(0);
            expect(screen.getByText("No settings match your search")).toBeInTheDocument();
        });

        it("signs out from the bottom of the sidebar", async () => {
            const dispatch = vi.spyOn(defaultDispatcher, "dispatch");
            render(getComponent());

            await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
            await waitFor(() => expect(dispatch).toHaveBeenCalledWith({ action: "logout" }));
        });
    });
});
