/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { IconButton, Text } from "@vector-im/compound-web";
import {
    EndCallIcon,
    HeadphonesSolidIcon,
    HeadphonesOffSolidIcon,
    MicOnIcon,
    MicOffIcon,
    VolumeOnIcon,
} from "@vector-im/compound-design-tokens/assets/web/icons";

import { useViewModel, type ViewModel } from "../../core/viewmodel";
import { useI18n } from "../../core/i18n/i18nContext";
import styles from "./DesktopVoiceControlsView.module.css";

/** Device state and the connected Element Call, if any. */
export interface DesktopVoiceControlsViewSnapshot {
    microphoneMuted: boolean;
    deafened: boolean;
    busy: boolean;
    roomName?: string;
    error?: string;
}
/** All controls affect the existing Element Call and host media preferences. */
export interface DesktopVoiceControlsViewActions {
    toggleMicrophone: () => Promise<void>;
    toggleDeafened: () => Promise<void>;
    disconnect: () => Promise<void>;
    showCall: () => void;
    openAudioSettings: () => void;
}
/** Presentation contract for the persistent desktop voice controls. */
export type DesktopVoiceControlsViewModel = ViewModel<
    DesktopVoiceControlsViewSnapshot,
    DesktopVoiceControlsViewActions
>;

/** Microphone and playback controls remain available when navigating away from a call. */
export function DesktopVoiceControlsView({ vm }: { vm: DesktopVoiceControlsViewModel }): JSX.Element {
    const { microphoneMuted, deafened, busy } = useViewModel(vm);
    const { translate: _t } = useI18n();
    return (
        <div className={styles.buttons}>
            <IconButton
                tooltip={microphoneMuted ? _t("desktop|voice|unmute") : _t("desktop|voice|mute")}
                aria-pressed={microphoneMuted}
                disabled={busy}
                onClick={() => void vm.toggleMicrophone()}
                data-muted={microphoneMuted}
            >
                {microphoneMuted ? <MicOffIcon /> : <MicOnIcon />}
            </IconButton>
            <IconButton
                tooltip={deafened ? _t("desktop|voice|undeafen") : _t("desktop|voice|deafen")}
                aria-pressed={deafened}
                disabled={busy}
                onClick={() => void vm.toggleDeafened()}
                data-muted={deafened}
            >
                {deafened ? <HeadphonesOffSolidIcon /> : <HeadphonesSolidIcon />}
            </IconButton>
        </div>
    );
}

/** Connection status and hang-up use the actual connected call, including its room name. */
export function DesktopVoiceConnectionView({ vm }: { vm: DesktopVoiceControlsViewModel }): JSX.Element | null {
    const { roomName, busy, error } = useViewModel(vm);
    const { translate: _t } = useI18n();
    if (!roomName && !error) return null;
    return (
        <div className={styles.connection} data-voice-connected={roomName ? true : undefined}>
            {roomName && (
                <div className={styles.connectionRow}>
                    <button className={styles.callIdentity} type="button" onClick={vm.showCall}>
                        <Text className={styles.connectedLabel} size="sm" weight="semibold">
                            <VolumeOnIcon />
                            {_t("desktop|voice|connected")}
                        </Text>
                        <Text size="xs">{roomName}</Text>
                    </button>
                    <IconButton tooltip={_t("desktop|voice|audio_settings")} onClick={vm.openAudioSettings}>
                        <HeadphonesSolidIcon />
                    </IconButton>
                    <IconButton
                        tooltip={_t("desktop|voice|disconnect")}
                        disabled={busy}
                        onClick={() => void vm.disconnect()}
                    >
                        <EndCallIcon />
                    </IconButton>
                </div>
            )}
            {error && (
                <Text size="sm" role="alert" className={styles.error}>
                    {error}
                </Text>
            )}
        </div>
    );
}
