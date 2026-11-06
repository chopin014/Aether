/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";

import { _t } from "../../../../../languageHandler";
import { SettingLevel } from "../../../../../settings/SettingLevel";
import SettingsFlag from "../../../elements/SettingsFlag";
import { SettingsSubsection } from "../../shared/SettingsSubsection";

/** What others can see of the user's activity: read receipts, typing, and their time zone. */
export function PresenceSettings(): JSX.Element {
    return (
        <SettingsSubsection
            heading={_t("common|presence")}
            description={_t("settings|preferences|presence_description")}
            formWrap
            card
        >
            <SettingsFlag name="sendReadReceipts" level={SettingLevel.ACCOUNT} />
            <SettingsFlag name="sendTypingNotifications" level={SettingLevel.ACCOUNT} />
            <SettingsFlag name="userTimezonePublish" level={SettingLevel.DEVICE} />
        </SettingsSubsection>
    );
}
