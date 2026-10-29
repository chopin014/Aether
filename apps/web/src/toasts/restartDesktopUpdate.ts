/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { _t } from "../languageHandler";
import Modal from "../Modal";
import PlatformPeg from "../PlatformPeg";
import QuestionDialog from "../components/views/dialogs/QuestionDialog";
import { CallStore } from "../stores/CallStore";

/** Restarts into the downloaded update, asking first if the user is in a call. */
export function restartDesktopUpdate(): void {
    const restart = (): void => PlatformPeg.get()?.installUpdate();
    if (CallStore.instance.connectedCalls.size === 0) {
        restart();
        return;
    }

    const { finished } = Modal.createDialog(QuestionDialog, {
        title: _t("desktop|updates|call_confirmation_title"),
        description: _t("desktop|updates|call_confirmation_description"),
        button: _t("desktop|updates|call_confirmation_restart"),
        danger: true,
    });
    void finished.then(([confirmed]) => {
        if (confirmed) restart();
    });
}
