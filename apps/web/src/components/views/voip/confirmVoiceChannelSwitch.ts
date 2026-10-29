/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { createElement, type ChangeEvent } from "react";

import SettingsStore from "../../../settings/SettingsStore";
import { SettingLevel } from "../../../settings/SettingLevel";
import Modal from "../../../Modal";
import QuestionDialog from "../dialogs/QuestionDialog";
import StyledCheckbox from "../elements/StyledCheckbox";
import { _t } from "../../../languageHandler";

/**
 * Asks whether to leave the call the user is in to join another, when they have asked to be warned about it
 * in the voice settings. Resolves true when there is nothing to ask or the user agrees.
 */
export async function confirmVoiceChannelSwitch(roomName?: string): Promise<boolean> {
    if (!SettingsStore.getValue("feature_desktop_shell") || !SettingsStore.getValue("desktopVoiceSwitchWarning")) {
        return true;
    }
    let doNotAskAgain = false;
    const { finished } = Modal.createDialog(QuestionDialog, {
        title: _t("desktop|voice_settings|switch_warning_title"),
        description: roomName
            ? _t(
                  "desktop|voice_settings|switch_warning_destination",
                  { roomName },
                  {
                      b: (name) => createElement("strong", null, name),
                  },
              )
            : _t("desktop|voice_settings|switch_warning_description"),
        button: _t("desktop|voice_settings|switch_warning_confirm"),
        additive: createElement(
            StyledCheckbox,
            {
                defaultChecked: false,
                onChange: (event: ChangeEvent<HTMLInputElement>) => {
                    doNotAskAgain = event.target.checked;
                },
            },
            _t("desktop|voice_settings|switch_warning_do_not_ask"),
        ),
    });
    const [confirmed] = await finished;
    if (confirmed && doNotAskAgain) {
        await SettingsStore.setValue("desktopVoiceSwitchWarning", null, SettingLevel.DEVICE, false);
    }
    return !!confirmed;
}
