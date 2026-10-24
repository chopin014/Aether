/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import SettingsStore from "../../../settings/SettingsStore";
import Modal from "../../../Modal";
import QuestionDialog from "../dialogs/QuestionDialog";
import { _t } from "../../../languageHandler";

/**
 * Asks whether to leave the call the user is in to join another, when they have asked to be warned about it
 * in the voice settings. Resolves true when there is nothing to ask or the user agrees.
 */
export async function confirmVoiceChannelSwitch(): Promise<boolean> {
    if (!SettingsStore.getValue("feature_desktop_shell") || !SettingsStore.getValue("desktopVoiceSwitchWarning")) {
        return true;
    }
    const { finished } = Modal.createDialog(QuestionDialog, {
        title: _t("desktop|voice_settings|switch_warning_title"),
        description: _t("desktop|voice_settings|switch_warning_description"),
        button: _t("desktop|voice_settings|switch_warning_confirm"),
    });
    const [confirmed] = await finished;
    return !!confirmed;
}
