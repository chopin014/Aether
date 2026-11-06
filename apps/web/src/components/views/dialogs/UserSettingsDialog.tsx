/*
Copyright 2024 New Vector Ltd.
Copyright 2019-2024 The Matrix.org Foundation C.I.C.
Copyright 2019 New Vector Ltd

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { ClientEvent, type MatrixEvent } from "matrix-js-sdk/src/matrix";
import { Toast } from "@vector-im/compound-web";
import React, { type JSX, useRef, useState } from "react";
import UserProfileIcon from "@vector-im/compound-design-tokens/assets/web/icons/user-profile";
import EditIcon from "@vector-im/compound-design-tokens/assets/web/icons/edit";
import DevicesIcon from "@vector-im/compound-design-tokens/assets/web/icons/devices";
import VisibilityOnIcon from "@vector-im/compound-design-tokens/assets/web/icons/visibility-on";
import NotificationsIcon from "@vector-im/compound-design-tokens/assets/web/icons/notifications";
import ChatIcon from "@vector-im/compound-design-tokens/assets/web/icons/chat";
import GlobeIcon from "@vector-im/compound-design-tokens/assets/web/icons/public";
import ComputerIcon from "@vector-im/compound-design-tokens/assets/web/icons/computer";
import KeyboardIcon from "@vector-im/compound-design-tokens/assets/web/icons/keyboard";
import KeyIcon from "@vector-im/compound-design-tokens/assets/web/icons/key";
import MicOnIcon from "@vector-im/compound-design-tokens/assets/web/icons/mic-on";
import LockIcon from "@vector-im/compound-design-tokens/assets/web/icons/lock";
import BlockIcon from "@vector-im/compound-design-tokens/assets/web/icons/block";
import HelpIcon from "@vector-im/compound-design-tokens/assets/web/icons/help";
import DownloadIcon from "@vector-im/compound-design-tokens/assets/web/icons/download";
import SignOutIcon from "@vector-im/compound-design-tokens/assets/web/icons/sign-out";
import {
    SettingsSidebarHeaderView,
    ToastContext,
    useActiveToast,
    useCreateAutoDisposedViewModel,
    desktopVoiceVideoSectionId,
    type DesktopVoiceVideoSection,
} from "@element-hq/web-shared-components";

import TabbedView, { Tab, type TabAnchor, useActiveTabWithDefault } from "../../structures/TabbedView";
import { type ScreenName } from "../../../PosthogTrackers";
import { UserSettingsNavigationContext } from "../../../contexts/UserSettingsNavigationContext";
import { _t, _td } from "../../../languageHandler";
import AccountUserSettingsTab from "../settings/tabs/user/AccountUserSettingsTab";
import { DesktopProfileEditorSettings } from "../settings/tabs/user/DesktopProfileEditorSettings";
import AppearanceUserSettingsTab from "../settings/tabs/user/AppearanceUserSettingsTab";
import SecurityUserSettingsTab from "../settings/tabs/user/SecurityUserSettingsTab";
import NotificationUserSettingsTab from "../settings/tabs/user/NotificationUserSettingsTab";
import { ChatUserSettingsTab } from "../settings/tabs/user/ChatUserSettingsTab";
import { LanguageTimeUserSettingsTab } from "../settings/tabs/user/LanguageTimeUserSettingsTab";
import { SystemUserSettingsTab } from "../settings/tabs/user/SystemUserSettingsTab";
import VoiceUserSettingsTab from "../settings/tabs/user/VoiceUserSettingsTab";
import HelpUserSettingsTab from "../settings/tabs/user/HelpUserSettingsTab";
import MjolnirUserSettingsTab from "../settings/tabs/user/MjolnirUserSettingsTab";
import { UIFeature } from "../../../settings/UIFeature";
import BaseDialog from "./BaseDialog";
import KeyboardUserSettingsTab from "../settings/tabs/user/KeyboardUserSettingsTab";
import SessionManagerTab from "../settings/tabs/user/SessionManagerTab";
import { UserTab } from "./UserTab";
import { type NonEmptyArray } from "../../../@types/common";
import { SDKContext } from "../../../contexts/SDKContext";
import { type SDKContextClass } from "../../../contexts/SDKContextClass";
import { useSettingValue } from "../../../hooks/useSettings";
import { NoChange, useEventEmitterAsyncState, type AsyncStateCallbackResult } from "../../../hooks/useEventEmitter";
import { EncryptionUserSettingsTab, type State } from "../settings/tabs/user/EncryptionUserSettingsTab";
import { DesktopUpdatesSettings } from "../settings/tabs/user/DesktopUpdatesSettings";
import { SettingsSidebarHeaderViewModel } from "../../../viewmodels/settings/SettingsSidebarHeaderViewModel";
import { OwnProfileStore } from "../../../stores/OwnProfileStore";
import { useMatrixClientContext } from "../../../contexts/MatrixClientContext";
import Modal from "../../../Modal";
import LogoutDialog, { shouldShowLogoutDialog } from "./LogoutDialog";
import defaultDispatcher from "../../../dispatcher/dispatcher";

interface IProps {
    initialTabId?: UserTab;
    showMsc4108QrCode?: boolean;
    /*
     * If true, the Account tab's status control starts in custom status mode,
     * ready for the user to enter a custom status.
     */
    startCustomStatus?: boolean;
    /*
     * The initial state of the Encryption tab.
     * If undefined, the default state is used ("loading").
     */
    initialEncryptionState?: State;
    sdkContext: SDKContextClass;
    onFinished(this: void): void;
}

function titleForTabID(tabId: UserTab): React.ReactNode {
    const subs = {
        strong: (sub: string) => <span className="mx_UserSettingsDialog_title_strong">{sub}</span>,
    };
    switch (tabId) {
        case UserTab.Account:
            return _t("settings|account|dialog_title", undefined, subs);
        case UserTab.Profile:
            return _t("settings|profile_appearance|dialog_title", undefined, subs);
        case UserTab.SessionManager:
            return _t("settings|sessions|dialog_title", undefined, subs);
        case UserTab.Appearance:
            return _t("settings|appearance|dialog_title", undefined, subs);
        case UserTab.Notifications:
            return _t("settings|notifications|dialog_title", undefined, subs);
        case UserTab.Chat:
            return _t("settings|chat|dialog_title", undefined, subs);
        case UserTab.LanguageAndTime:
            return _t("settings|language_time|dialog_title", undefined, subs);
        case UserTab.System:
            return _t("settings|system|dialog_title", undefined, subs);
        case UserTab.Keyboard:
            return _t("settings|keyboard|dialog_title", undefined, subs);
        case UserTab.Voice:
            return _t("settings|voip|dialog_title", undefined, subs);
        case UserTab.Security:
            return _t("settings|security|dialog_title", undefined, subs);
        case UserTab.Encryption:
            return _t("settings|encryption|dialog_title", undefined, subs);
        case UserTab.Mjolnir:
            return _t("settings|labs_mjolnir|dialog_title", undefined, subs);
        case UserTab.Help:
            return _t("setting|help_about|dialog_title", undefined, subs);
        case UserTab.Updates:
            return _t("desktop|updates|nav_title");
    }
}

/** The line under each page's title, and words people might search for to find the page. */
const PAGE_TEXT: Partial<Record<UserTab, { description: TranslationKey; keywords: TranslationKey }>> = {
    [UserTab.Account]: {
        description: _td("settings|pages|account_description"),
        keywords: _td("settings|pages|account_keywords"),
    },
    [UserTab.Profile]: {
        description: _td("settings|pages|profile_description"),
        keywords: _td("settings|pages|profile_keywords"),
    },
    [UserTab.Security]: {
        description: _td("settings|pages|security_description"),
        keywords: _td("settings|pages|security_keywords"),
    },
    [UserTab.Encryption]: {
        description: _td("settings|pages|encryption_description"),
        keywords: _td("settings|pages|encryption_keywords"),
    },
    [UserTab.SessionManager]: {
        description: _td("settings|pages|sessions_description"),
        keywords: _td("settings|pages|sessions_keywords"),
    },
    [UserTab.Appearance]: {
        description: _td("settings|pages|appearance_description"),
        keywords: _td("settings|pages|appearance_keywords"),
    },
    [UserTab.Chat]: {
        description: _td("settings|pages|chat_description"),
        keywords: _td("settings|pages|chat_keywords"),
    },
    [UserTab.Voice]: {
        description: _td("settings|pages|voice_description"),
        keywords: _td("settings|pages|voice_keywords"),
    },
    [UserTab.Notifications]: {
        description: _td("settings|pages|notifications_description"),
        keywords: _td("settings|pages|notifications_keywords"),
    },
    [UserTab.Keyboard]: {
        description: _td("settings|pages|keyboard_description"),
        keywords: _td("settings|pages|keyboard_keywords"),
    },
    [UserTab.LanguageAndTime]: {
        description: _td("settings|pages|language_description"),
        keywords: _td("settings|pages|language_keywords"),
    },
    [UserTab.System]: {
        description: _td("settings|pages|system_description"),
        keywords: _td("settings|pages|system_keywords"),
    },
    [UserTab.Updates]: {
        description: _td("settings|pages|updates_description"),
        keywords: _td("settings|pages|updates_keywords"),
    },
    [UserTab.Help]: {
        description: _td("settings|pages|help_description"),
        keywords: _td("settings|pages|help_keywords"),
    },
};

/** Lower-case text without accents, so "senha" finds "Senha" and "video" finds "vídeo". */
function searchable(text: string): string {
    return text
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .toLowerCase();
}

/** Whether every word of the search appears in the tab's name, group, description or keywords. */
function tabMatches(tab: Tab<UserTab>, query: string): boolean {
    const words = searchable(query).split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    const page = PAGE_TEXT[tab.id];
    const haystack = searchable(
        [tab.label, tab.group, page?.description, page?.keywords]
            .filter((key): key is TranslationKey => !!key)
            .map((key) => _t(key))
            .join(" "),
    );
    return words.every((word) => haystack.includes(word));
}

/** Signs out from the bottom of the settings sidebar, first offering to back up keys when that matters. */
function SignOutItem(): JSX.Element {
    const client = useMatrixClientContext();
    const onClick = async (): Promise<void> => {
        if (await shouldShowLogoutDialog(client)) {
            Modal.createDialog(LogoutDialog);
        } else {
            defaultDispatcher.dispatch({ action: "logout" });
        }
    };
    return (
        <button type="button" className="mx_UserSettingsDialog_signOut" onClick={onClick}>
            <SignOutIcon aria-hidden="true" />
            {_t("settings|sign_out")}
        </button>
    );
}

/** The sections of the desktop Voice & Video page, which the sidebar links to. */
const VOICE_VIDEO_ANCHORS: TabAnchor[] = (
    [
        ["voice", _td("desktop|voice_settings|nav_voice")],
        ["video", _td("desktop|voice_settings|nav_video")],
        ["sounds", _td("desktop|voice_settings|nav_sounds")],
        ["advanced", _td("desktop|voice_settings|nav_advanced")],
    ] as [DesktopVoiceVideoSection, TranslationKey][]
).map(([section, label]) => ({ label, domId: desktopVoiceVideoSectionId(section) }));

export default function UserSettingsDialog(props: IProps): JSX.Element {
    const voipEnabled = useSettingValue(UIFeature.Voip);
    const mjolnirEnabled = useSettingValue("feature_mjolnir");
    const desktopShell = useSettingValue("feature_desktop_shell");
    // store these props in state as changing tabs back and forth should clear them
    const [showMsc4108QrCode, setShowMsc4108QrCode] = useState(props.showMsc4108QrCode);
    const [initialEncryptionState, setInitialEncryptionState] = useState(props.initialEncryptionState);
    const [startCustomStatus, setStartCustomStatus] = useState(props.startCustomStatus);

    // If the user doesn't have Recovery set up (no default Secret Storage key),
    // we show an indicator on the Encryption tab.
    const showSetupRecoveryIndicator = useEventEmitterAsyncState(
        props.sdkContext.client,
        ClientEvent.AccountData,
        async (event?: MatrixEvent): AsyncStateCallbackResult<boolean> => {
            if (event === undefined || event.getType() === "m.secret_storage.default_key") {
                const client = props.sdkContext.client;
                if (!client) {
                    return false;
                }

                return !(await client.secretStorage.getDefaultKeyId());
            }
            return new NoChange();
        },
        [],
        false,
    );

    const getTabs = (): NonEmptyArray<Tab<UserTab>> => {
        const tabs: Tab<UserTab>[] = [];
        // Tabs are grouped by what people come to change: their account, how the app behaves, and the app itself.
        const add = (
            id: UserTab,
            label: TranslationKey,
            icon: JSX.Element,
            body: JSX.Element,
            group: TranslationKey,
            screenName?: ScreenName,
            labelClassName?: string,
            anchors?: TabAnchor[],
        ): void => {
            tabs.push(
                new Tab(id, label, icon, body, screenName, labelClassName, anchors, group, PAGE_TEXT[id]?.description),
            );
        };

        const accountGroup = _td("settings|groups|account");
        add(
            UserTab.Account,
            desktopShell ? _td("settings|account|nav_title") : _td("settings|account|title"),
            <UserProfileIcon />,
            <AccountUserSettingsTab closeSettingsFn={props.onFinished} startCustomStatus={startCustomStatus} />,
            accountGroup,
            "UserSettingsGeneral",
        );
        if (desktopShell) {
            add(
                UserTab.Profile,
                _td("settings|profile_appearance|title"),
                <EditIcon />,
                <DesktopProfileEditorSettings />,
                accountGroup,
            );
        }
        add(
            UserTab.Security,
            desktopShell ? _td("settings|security|nav_title") : _td("room_settings|security|title"),
            <LockIcon />,
            <SecurityUserSettingsTab />,
            accountGroup,
            "UserSettingsSecurityPrivacy",
        );
        add(
            UserTab.Encryption,
            _td("settings|encryption|title"),
            <KeyIcon />,
            <EncryptionUserSettingsTab initialState={initialEncryptionState} />,
            accountGroup,
            "UserSettingsEncryption",
            showSetupRecoveryIndicator ? "mx_SettingsDialog_tabLabelsAlert" : undefined,
        );
        add(
            UserTab.SessionManager,
            _td("settings|sessions|title"),
            <DevicesIcon />,
            <SessionManagerTab showMsc4108QrCode={showMsc4108QrCode} />,
            accountGroup,
        );
        if (mjolnirEnabled) {
            add(
                UserTab.Mjolnir,
                _td("labs_mjolnir|title"),
                <BlockIcon />,
                <MjolnirUserSettingsTab />,
                accountGroup,
                "UserSettingMjolnir",
            );
        }

        const appGroup = _td("settings|groups|app");
        add(
            UserTab.Appearance,
            _td("common|appearance"),
            <VisibilityOnIcon />,
            <AppearanceUserSettingsTab />,
            appGroup,
            "UserSettingsAppearance",
        );
        add(UserTab.Chat, _td("settings|chat|title"), <ChatIcon />, <ChatUserSettingsTab />, appGroup);
        if (voipEnabled) {
            add(
                UserTab.Voice,
                _td("settings|voip|title"),
                <MicOnIcon />,
                <VoiceUserSettingsTab />,
                appGroup,
                "UserSettingsVoiceVideo",
                undefined,
                desktopShell ? VOICE_VIDEO_ANCHORS : undefined,
            );
        }
        add(
            UserTab.Notifications,
            _td("notifications|enable_prompt_toast_title"),
            <NotificationsIcon />,
            <NotificationUserSettingsTab />,
            appGroup,
            "UserSettingsNotifications",
        );
        add(
            UserTab.Keyboard,
            _td("settings|keyboard|title"),
            <KeyboardIcon />,
            <KeyboardUserSettingsTab />,
            appGroup,
            "UserSettingsKeyboard",
        );
        add(
            UserTab.LanguageAndTime,
            _td("settings|language_time|title"),
            <GlobeIcon />,
            <LanguageTimeUserSettingsTab />,
            appGroup,
        );
        add(
            UserTab.System,
            window.electron ? _td("settings|system|desktop_title") : _td("settings|system|title"),
            <ComputerIcon />,
            <SystemUserSettingsTab />,
            appGroup,
        );

        const aboutGroup = _td("settings|groups|about");
        if (window.electron) {
            add(
                UserTab.Updates,
                _td("desktop|updates|nav_title"),
                <DownloadIcon />,
                <DesktopUpdatesSettings />,
                aboutGroup,
                "UserSettings",
            );
        }
        add(
            UserTab.Help,
            _td("setting|help_about|title"),
            <HelpIcon />,
            <HelpUserSettingsTab />,
            aboutGroup,
            "UserSettingsHelpAbout",
        );

        return tabs as NonEmptyArray<Tab<UserTab>>;
    };

    const [activeTabId, _setActiveTabId] = useActiveTabWithDefault(getTabs(), UserTab.Account, props.initialTabId);
    const setActiveTabId = (tabId: UserTab): void => {
        _setActiveTabId(tabId);
        // Clear these so switching away from the tab and back to it will not show the QR code again
        setShowMsc4108QrCode(false);
        setInitialEncryptionState(undefined);
        setStartCustomStatus(false);
    };

    const [activeToast, toastRack] = useActiveToast();
    const openTab = useRef(setActiveTabId);
    openTab.current = setActiveTabId;
    const navigate = React.useCallback((tab: UserTab) => openTab.current(tab), []);

    // The desktop shell's sidebar searches the pages by their name, group and a few words for what is on them.
    const [query, setQuery] = useState("");
    const tabs = getTabs();
    const isTabListed = (tab: Tab<UserTab>): boolean => tabMatches(tab, query);
    const listedTabs = tabs.filter(isTabListed);
    const latestListed = useRef(listedTabs);
    latestListed.current = listedTabs;
    const sidebarVm = useCreateAutoDisposedViewModel(
        () =>
            new SettingsSidebarHeaderViewModel({
                client: props.sdkContext.client!,
                ownProfileStore: OwnProfileStore.instance,
                onQueryChange: setQuery,
                onOpenFirstMatch: () => {
                    const first = latestListed.current[0];
                    if (first) openTab.current(first.id);
                },
                onEditProfile: () => openTab.current(UserTab.Profile),
            }),
    );

    return (
        // XXX: SDKContext is provided within the LoggedInView subtree.
        // Modals function outside the MatrixChat React tree, so sdkContext is reprovided here to simulate that.
        // The longer term solution is to move our ModalManager into the React tree to inherit contexts properly.
        <SDKContext.Provider value={props.sdkContext}>
            <ToastContext.Provider value={toastRack}>
                <UserSettingsNavigationContext.Provider value={navigate}>
                    <BaseDialog
                        className="mx_UserSettingsDialog"
                        hasCancel={true}
                        onFinished={props.onFinished}
                        title={titleForTabID(activeTabId)}
                        titleClass="mx_UserSettingsDialog_title"
                    >
                        <div className="mx_SettingsDialog_content">
                            {desktopShell ? (
                                <TabbedView
                                    tabs={tabs}
                                    activeTabId={activeTabId}
                                    screenName="UserSettings"
                                    onChange={setActiveTabId}
                                    responsive={true}
                                    pageHeaders
                                    isTabListed={isTabListed}
                                    sidebarHeader={<SettingsSidebarHeaderView vm={sidebarVm} />}
                                    sidebarFooter={
                                        <>
                                            {listedTabs.length === 0 && (
                                                <p className="mx_UserSettingsDialog_searchEmpty">
                                                    {_t("settings|search_empty")}
                                                </p>
                                            )}
                                            <SignOutItem />
                                        </>
                                    }
                                />
                            ) : (
                                <TabbedView
                                    tabs={tabs}
                                    activeTabId={activeTabId}
                                    screenName="UserSettings"
                                    onChange={setActiveTabId}
                                    responsive={true}
                                />
                            )}
                        </div>
                        <div className="mx_SettingsDialog_toastContainer">
                            {activeToast && <Toast>{activeToast}</Toast>}
                        </div>
                    </BaseDialog>
                </UserSettingsNavigationContext.Provider>
            </ToastContext.Provider>
        </SDKContext.Provider>
    );
}
