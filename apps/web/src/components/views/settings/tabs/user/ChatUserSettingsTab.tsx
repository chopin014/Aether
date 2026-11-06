/*
Copyright 2026 Gabriel
Copyright 2024, 2025 New Vector Ltd.
Copyright 2019-2023 The Matrix.org Foundation C.I.C.
Copyright 2019 Michael Telatynski <7t3chguy@gmail.com>

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { type JSX } from "react";

import { _t } from "../../../../../languageHandler";
import SettingsStore from "../../../../../settings/SettingsStore";
import { SettingLevel } from "../../../../../settings/SettingLevel";
import { type BooleanSettingKey } from "../../../../../settings/Settings.tsx";
import SettingsFlag from "../../../elements/SettingsFlag";
import SettingsTab from "../SettingsTab";
import { SettingsSection } from "../../shared/SettingsSection";
import { SettingsSubsection } from "../../shared/SettingsSubsection";
import { SidebarSettings } from "./SidebarSettings";

/** What the timeline shows besides messages. */
const TIMELINE_SETTINGS: BooleanSettingKey[] = [
    "showTypingNotifications",
    "showReadReceipts",
    "showRedactions",
    "showJoinLeaves",
    "showDisplaynameChanges",
    "showAvatarChanges",
    "showChatEffects",
    "Pill.shouldShowPillAvatar",
    "TextualBody.enableBigEmoji",
    "scrollToBottomOnMessageSent",
    "useOnlyCurrentProfiles",
];

const COMPOSER_SETTINGS: BooleanSettingKey[] = [
    "MessageComposerInput.ctrlEnterToSend",
    "MessageComposerInput.useMarkdown",
    "MessageComposerInput.suggestEmoji",
    "MessageComposerInput.autoReplaceEmoji",
    "MessageComposerInput.surroundWith",
    "MessageComposerInput.insertTrailingColon",
    "MessageComposerInput.showStickersButton",
    "promptBeforeInviteUnknownUsers",
];

const MEDIA_SETTINGS: BooleanSettingKey[] = ["autoplayGifs", "autoplayVideo"];

const CODE_BLOCK_SETTINGS: BooleanSettingKey[] = [
    "enableSyntaxHighlightLanguageDetection",
    "expandCodeByDefault",
    "showCodeLineNumbers",
];

function flags(names: BooleanSettingKey[], level = SettingLevel.ACCOUNT): JSX.Element[] {
    return names.map((name) => <SettingsFlag key={name} name={name} level={level} />);
}

/** The Chat settings page: how messages are shown and written, media, and the room list. */
export function ChatUserSettingsTab(): JSX.Element {
    return (
        <SettingsTab data-testid="mx_ChatUserSettingsTab">
            <SettingsSection>
                <SettingsSubsection heading={_t("common|timeline")} formWrap card>
                    {flags(TIMELINE_SETTINGS)}
                </SettingsSubsection>

                <SettingsSubsection heading={_t("settings|preferences|composer_heading")} formWrap card>
                    {flags(COMPOSER_SETTINGS)}
                </SettingsSubsection>

                <SettingsSubsection heading={_t("settings|preferences|media_heading")} formWrap card>
                    {flags(MEDIA_SETTINGS)}
                </SettingsSubsection>

                <SettingsSubsection
                    heading={_t("settings|preferences|link_previews_heading")}
                    description={_t("settings|preferences|link_previews_description")}
                    formWrap
                    card
                >
                    <SettingsFlag name="urlPreviewsEnabled" level={SettingLevel.DEVICE} />
                    <SettingsFlag
                        name="urlPreviewsEnabled_e2ee"
                        level={SettingLevel.DEVICE}
                        requires={["urlPreviewsEnabled"]}
                    />
                    {SettingsStore.getValue("feature_msc4095_url_preview_bundle") && (
                        <SettingsFlag
                            name="urlPreviewsEnabled_e2ee_bundled_only"
                            level={SettingLevel.DEVICE}
                            requires={["urlPreviewsEnabled", "urlPreviewsEnabled_e2ee"]}
                        />
                    )}
                </SettingsSubsection>

                <SettingsSubsection heading={_t("settings|preferences|code_blocks_heading")} formWrap card>
                    {flags(CODE_BLOCK_SETTINGS)}
                </SettingsSubsection>

                <SettingsSubsection heading={_t("settings|preferences|room_list_heading")} formWrap card>
                    <SettingsFlag name="RoomList.showMessagePreview" level={SettingLevel.DEVICE} />
                    <SettingsFlag name="RoomList.showSections" level={SettingLevel.ACCOUNT} />
                    <SettingsFlag
                        name="RoomList.showPeopleSection"
                        level={SettingLevel.ACCOUNT}
                        requires={["RoomList.showSections"]}
                    />
                </SettingsSubsection>

                <SettingsSubsection heading={_t("common|spaces")} formWrap card>
                    <SettingsFlag name="Spaces.joinAllChannels" level={SettingLevel.ACCOUNT} />
                </SettingsSubsection>

                <SidebarSettings />
            </SettingsSection>
        </SettingsTab>
    );
}
