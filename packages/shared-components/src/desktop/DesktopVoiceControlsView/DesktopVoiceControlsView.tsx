/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, useCallback, useRef } from "react";
import { IconButton, Text } from "@vector-im/compound-web";
import {
    AudioIcon,
    EndCallIcon,
    HeadphonesSolidIcon,
    HeadphonesOffSolidIcon,
    MicOnIcon,
    MicOffIcon,
    ShareScreenSolidIcon,
    VideoCallSolidIcon,
    VolumeOnIcon,
} from "@vector-im/compound-design-tokens/assets/web/icons";

import { useViewModel, type ViewModel } from "../../core/viewmodel";
import { useI18n } from "../../core/i18n/i18nContext";
import { VoicePopover } from "./VoicePopover";
import { VoiceNoisePanel } from "./VoiceNoisePanel";
import { VoiceConnectionPanel } from "./VoiceConnectionPanel";
import styles from "./DesktopVoiceControlsView.module.css";

/** Device state and the connected Element Call, if any. */
export interface DesktopVoiceControlsViewSnapshot {
    microphoneMuted: boolean;
    deafened: boolean;
    /** Whether our camera is on in the connected call. */
    videoEnabled: boolean;
    /** Whether the connected call lets us share our screen. */
    screenShareAvailable: boolean;
    /** Whether we are sharing our screen in the connected call. */
    screenSharing: boolean;
    busy: boolean;
    /** The quick panel currently open above the call dock. */
    panel: "noise" | "connection" | null;
    /** Whether the call currently uses Aether's enhanced noise suppression. */
    noiseSuppression: boolean;
    noiseSuppressionStrength: number;
    microphoneTest: { active: boolean; level: number | null; open: boolean; error?: "denied" | "unavailable" };
    noiseSuppressionProblem?: "failed" | "overloaded";
    /** Real media transport status; null measurements have not been supplied by the call. */
    connection: {
        state: "connecting" | "connected" | "reconnecting" | "disconnected";
        quality: "unknown" | "good" | "poor" | "bad" | "lost";
        rttMs: number | null;
        averageRttMs: number | null;
        outboundPacketLossPercent: number | null;
        history: readonly (number | null)[];
    };
    roomName?: string;
    error?: string;
}
/** All controls affect the existing Element Call and host media preferences. */
export interface DesktopVoiceControlsViewActions {
    toggleMicrophone: () => Promise<void>;
    toggleDeafened: () => Promise<void>;
    toggleVideo: () => Promise<void>;
    toggleScreenShare: () => Promise<void>;
    disconnect: () => Promise<void>;
    showCall: () => void;
    setPanel: (panel: "noise" | "connection" | null) => void;
    setNoiseSuppression: (enabled: boolean) => Promise<void>;
    setNoiseSuppressionStrength: (percent: number) => Promise<void>;
    toggleMicrophoneTest: () => Promise<void>;
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

/**
 * The connected call above the account row: status and hang-up, then camera and screen sharing, so the
 * floating call window is only needed to watch a screen share.
 */
export function DesktopVoiceConnectionView({ vm }: { vm: DesktopVoiceControlsViewModel }): JSX.Element | null {
    const {
        roomName,
        busy,
        error,
        videoEnabled,
        screenShareAvailable,
        screenSharing,
        panel,
        connection,
        noiseSuppression,
    } = useViewModel(vm);
    const noiseButton = useRef<HTMLButtonElement>(null);
    const connectionButton = useRef<HTMLButtonElement>(null);
    const closePanel = useCallback(() => vm.setPanel(null), [vm]);
    const { translate: _t } = useI18n();
    if (!roomName && !error) return null;
    const tone =
        connection.state === "connecting" || connection.state === "reconnecting"
            ? "warning"
            : connection.state === "disconnected" || connection.quality === "bad" || connection.quality === "lost"
              ? "critical"
              : connection.quality === "poor"
                ? "warning"
                : connection.quality === "good"
                  ? "success"
                  : "neutral";
    const status =
        connection.state === "connecting"
            ? _t("desktop|voice|connecting")
            : connection.state === "reconnecting"
              ? _t("desktop|voice|reconnecting")
              : connection.state === "disconnected"
                ? _t("desktop|voice|disconnected")
                : connection.quality === "bad" || connection.quality === "lost"
                  ? _t("desktop|voice|connection_bad")
                  : connection.quality === "poor"
                    ? _t("desktop|voice|connection_poor")
                    : _t("desktop|voice|connected");
    return (
        <div className={styles.connection} data-voice-connected={roomName ? true : undefined} data-tone={tone}>
            {roomName && (
                <>
                    <div className={styles.connectionRow}>
                        <button
                            ref={connectionButton}
                            className={styles.signalButton}
                            type="button"
                            aria-label={_t("desktop|voice|connection_details")}
                            aria-haspopup="dialog"
                            aria-expanded={panel === "connection"}
                            onClick={() => vm.setPanel(panel === "connection" ? null : "connection")}
                        >
                            <svg viewBox="0 0 24 24" aria-hidden="true" className={styles.signalIcon}>
                                <rect x="3" y="15" width="4" height="6" rx="1" />
                                <rect x="10" y="9" width="4" height="12" rx="1" />
                                <rect x="17" y="3" width="4" height="18" rx="1" />
                            </svg>
                        </button>
                        <button className={styles.callIdentity} type="button" onClick={vm.showCall}>
                            <Text className={styles.connectedLabel} size="sm" weight="semibold">
                                <VolumeOnIcon />
                                <span role="status">{status}</span>
                            </Text>
                            <Text size="xs">{roomName}</Text>
                        </button>
                        <IconButton
                            ref={noiseButton}
                            className={styles.noiseButton}
                            tooltip={_t("desktop|voice|noise_suppression_title")}
                            aria-haspopup="dialog"
                            aria-expanded={panel === "noise"}
                            data-enabled={noiseSuppression}
                            onClick={() => vm.setPanel(panel === "noise" ? null : "noise")}
                        >
                            <AudioIcon />
                        </IconButton>
                        <IconButton
                            className={styles.hangUp}
                            tooltip={_t("desktop|voice|disconnect")}
                            disabled={busy}
                            onClick={() => void vm.disconnect()}
                        >
                            <EndCallIcon />
                        </IconButton>
                    </div>
                    <div className={styles.mediaRow}>
                        <IconButton
                            tooltip={videoEnabled ? _t("desktop|voice|camera_off") : _t("desktop|voice|camera_on")}
                            aria-pressed={videoEnabled}
                            disabled={busy}
                            onClick={() => void vm.toggleVideo()}
                        >
                            <VideoCallSolidIcon />
                        </IconButton>
                        {screenShareAvailable && (
                            <IconButton
                                tooltip={
                                    screenSharing
                                        ? _t("desktop|voice|stop_screen_share")
                                        : _t("desktop|voice|start_screen_share")
                                }
                                aria-pressed={screenSharing}
                                disabled={busy}
                                onClick={() => void vm.toggleScreenShare()}
                            >
                                <ShareScreenSolidIcon />
                            </IconButton>
                        )}
                    </div>
                </>
            )}
            {roomName && panel && (
                <VoicePopover
                    anchor={panel === "noise" ? noiseButton : connectionButton}
                    title={_t(
                        panel === "noise"
                            ? "desktop|voice|noise_suppression_title"
                            : "desktop|voice|connection_details",
                    )}
                    onClose={closePanel}
                >
                    {panel === "noise" ? <VoiceNoisePanel vm={vm} /> : <VoiceConnectionPanel vm={vm} />}
                </VoicePopover>
            )}
            {error && (
                <Text size="sm" role="alert" className={styles.error}>
                    {error}
                </Text>
            )}
        </div>
    );
}
