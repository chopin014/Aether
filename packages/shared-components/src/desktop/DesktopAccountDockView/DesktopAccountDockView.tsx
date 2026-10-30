/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { IconButton } from "@vector-im/compound-web";
import { SettingsIcon } from "@vector-im/compound-design-tokens/assets/web/icons";

import { UserMenuView, type UserMenuViewProps } from "../../menus/UserMenu/UserMenu";
import { useViewModel } from "../../core/viewmodel";
import { useI18n } from "../../core/i18n/i18nContext";
import {
    DesktopVoiceControlsView,
    DesktopVoiceConnectionView,
    type DesktopVoiceControlsViewModel,
} from "../DesktopVoiceControlsView";
import styles from "./DesktopAccountDockView.module.css";

/** Uses the existing account model, including verification, devices and guest actions. */
export interface DesktopAccountDockViewProps {
    vm: UserMenuViewProps["vm"];
    /** The real Element Call controls, when the host provides them. */
    voice?: DesktopVoiceControlsViewModel;
}

/** Account identity and settings remain reachable while the room list scrolls. */
export function DesktopAccountDockView({ vm, voice }: DesktopAccountDockViewProps): JSX.Element {
    const { actions } = useViewModel(vm);
    const { translate: _t } = useI18n();

    return (
        <div className={styles.dock} role="group" aria-label={_t("menus|user_menu|title")}>
            {voice && <DesktopVoiceConnectionView vm={voice} />}
            <div className={styles.identityRow}>
                {voice ? <VoiceIdentity vm={vm} voice={voice} /> : <UserMenuView vm={vm} presentation="dock" />}
                {voice && <DesktopVoiceControlsView vm={voice} />}
                {actions.openSettings && (
                    <IconButton
                        className={styles.settings}
                        tooltip={_t("user_menu|open_settings")}
                        onClick={vm.openSettings}
                    >
                        <SettingsIcon />
                    </IconButton>
                )}
            </div>
        </div>
    );
}

/** Keep the account avatar subscribed to the same activity as the channel participants. */
function VoiceIdentity({ vm, voice }: Required<DesktopAccountDockViewProps>): JSX.Element {
    const { speaking, soundboardPlaying } = useViewModel(voice);
    return (
        <UserMenuView
            vm={vm}
            presentation="dock"
            voiceActivity={soundboardPlaying ? "soundboard" : speaking ? "speaking" : undefined}
        />
    );
}
