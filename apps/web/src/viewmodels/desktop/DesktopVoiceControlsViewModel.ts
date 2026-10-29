/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    BaseViewModel,
    type DesktopVoiceControlsViewSnapshot,
    type DesktopVoiceControlsViewModel as DesktopVoiceControlsViewModelInterface,
} from "@element-hq/web-shared-components";
import { type MatrixClient, type RoomMember, RoomEvent } from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";

import { CallEvent, ElementCall } from "../../models/Call";
import { type CallStore, CallStoreEvent } from "../../stores/CallStore";
import SettingsStore from "../../settings/SettingsStore";
import { SettingLevel } from "../../settings/SettingLevel";
import defaultDispatcher from "../../dispatcher/dispatcher";
import { Action } from "../../dispatcher/actions";
import { type ViewRoomPayload } from "../../dispatcher/payloads/ViewRoomPayload";
import { _t, _td } from "../../languageHandler";

import { DesktopShortcutManager } from "../../audio/desktop/DesktopShortcutManager";
import { MicrophoneTest, mediaTestError } from "../../audio/desktop/MicrophoneTest";
import { getMicrophoneGateConfig } from "../../audio/desktop/DesktopVoicePipeline";
import { customizeDesktopVoiceProfile } from "../../audio/desktop/DesktopVoiceProfiles";

import { playDesktopVoiceSound } from "../../audio/DesktopVoiceSounds";

interface Props {
    client: MatrixClient;
    callStore: Pick<CallStore, "connectedCalls"> & {
        on: (event: CallStoreEvent.ConnectedCalls, listener: () => void) => unknown;
        off: (event: CallStoreEvent.ConnectedCalls, listener: () => void) => unknown;
    };
}

/** Persistent desktop voice controls, using Element Call's device and audio-output host APIs. */
export class DesktopVoiceControlsViewModel
    extends BaseViewModel<DesktopVoiceControlsViewSnapshot, Props>
    implements DesktopVoiceControlsViewModelInterface
{
    private call?: ElementCall;
    private observedCalls = false;
    private wasVideoEnabled = false;
    private wasSharingScreen = false;
    private pendingAction?: Promise<void>;
    private stopShortcuts?: () => void;
    private testGeneration = 0;
    private restoreAfterTest?: { call: ElementCall; microphoneMuted: boolean };
    private readonly microphoneTest = new MicrophoneTest(
        (level, open) => {
            if (!this.isDisposed && this.snapshot.current.microphoneTest.active) {
                this.snapshot.merge({ microphoneTest: { active: true, level, open } });
            }
        },
        (status) => {
            if (!this.isDisposed) {
                this.snapshot.merge({
                    noiseSuppressionProblem: status === "active" ? undefined : status,
                });
            }
        },
    );

    public constructor(props: Props) {
        super(props, {
            microphoneMuted: SettingsStore.getValue("audioInputMuted"),
            deafened: SettingsStore.getValue("desktopDeafened"),
            videoEnabled: false,
            screenShareAvailable: false,
            screenSharing: false,
            busy: false,
            panel: null,
            noiseSuppression: false,
            noiseSuppressionStrength: 100,
            microphoneTest: { active: false, level: null, open: false },
            connection: {
                state: "disconnected",
                quality: "unknown",
                rttMs: null,
                averageRttMs: null,
                outboundPacketLossPercent: null,
                history: [],
            },
        });
        props.callStore.on(CallStoreEvent.ConnectedCalls, this.onCallsChanged);
        this.disposables.track(() => props.callStore.off(CallStoreEvent.ConnectedCalls, this.onCallsChanged));
        this.disposables.trackListener(props.client, RoomEvent.Name, this.refresh);
        for (const setting of [
            "audioInputMuted",
            "desktopDeafened",
            "desktopInputProfile",
            "desktopNoiseSuppression",
            "desktopNoiseSuppressionStrength",
            "desktopVoiceDetection",
            "desktopInputSensitivityAuto",
            "desktopInputSensitivity",
            "desktopMicrophoneVolume",
            "desktopSpeakerVolume",
        ] as const) {
            const ref = SettingsStore.watchSetting(setting, null, this.onSettingsChanged);
            this.disposables.track(() => SettingsStore.unwatchSetting(ref));
        }
        this.disposables.track(() => this.call?.off(CallEvent.DeviceMute, this.onDeviceMute));
        this.disposables.track(() => this.call?.off(CallEvent.ScreenShare, this.onScreenShare));
        this.disposables.track(() => this.call?.off(CallEvent.Participants, this.onParticipants));
        this.disposables.track(() => this.call?.off(CallEvent.ConnectionStats, this.refresh));
        this.onCallsChanged();
    }

    public override dispose(): void {
        this.testGeneration++;
        this.microphoneTest.stop();
        // Let an in-flight deafen finish before restoring it, so its completion cannot mute the call again.
        const restore = (): Promise<void> => this.restoreTestAudio();
        void (this.pendingAction ? this.pendingAction.then(restore, restore) : restore()).catch((error) =>
            logger.warn("Could not restore audio after microphone test", error),
        );
        super.dispose();
    }

    private readonly onSettingsChanged = (): void => {
        this.refresh();
        this.microphoneTest.update();
    };

    /** Starts session shortcuts after the dock commits, so discarded StrictMode renders cannot register actions. */
    public startShortcuts = (): (() => void) => {
        if (this.isDisposed || !SettingsStore.getValue("feature_desktop_shell")) return () => {};
        if (this.stopShortcuts) return this.stopShortcuts;
        const stop = DesktopShortcutManager.instance.start();
        const unsubscribe = DesktopShortcutManager.instance.onEvent((event) => {
            if (this.isDisposed || !event.pressed || event.reset) return;
            if (event.id === "toggle_mute") void this.toggleMicrophone();
            else if (event.id === "toggle_deafen") void this.toggleDeafened();
            else if (event.id === "toggle_input_mode") {
                void SettingsStore.setValue(
                    "desktopInputMode",
                    null,
                    SettingLevel.DEVICE,
                    SettingsStore.getValue("desktopInputMode") === "push_to_talk" ? "voice_activity" : "push_to_talk",
                );
            }
        });
        let stopped = false;
        const cleanup = (): void => {
            if (stopped) return;
            stopped = true;
            unsubscribe();
            stop();
            if (this.stopShortcuts === cleanup) this.stopShortcuts = undefined;
        };
        this.stopShortcuts = cleanup;
        this.disposables.track(cleanup);
        return cleanup;
    };

    private readonly refresh = (): void => {
        if (this.isDisposed) return;
        const call = this.call?.locallyLeaving ? undefined : this.call;
        const processing = getMicrophoneGateConfig();
        this.snapshot.merge({
            ...(this.call?.locallyLeaving ? { error: undefined, panel: null } : {}),
            microphoneMuted: call?.deviceMuteState
                ? !call.deviceMuteState.audio_enabled
                : SettingsStore.getValue("audioInputMuted"),
            deafened: SettingsStore.getValue("desktopDeafened"),
            videoEnabled: call?.deviceMuteState?.video_enabled ?? false,
            screenShareAvailable: call?.screenShare.available ?? false,
            screenSharing: call?.screenShare.sharing ?? false,
            roomName: call ? (this.props.client.getRoom(call.roomId)?.name ?? call.roomId) : undefined,
            noiseSuppression: processing.noiseSuppression !== null,
            noiseSuppressionStrength:
                processing.noiseSuppression ?? SettingsStore.getValue("desktopNoiseSuppressionStrength"),
            connection: call?.connectionStats ?? {
                state: call ? "connecting" : "disconnected",
                quality: "unknown",
                rttMs: null,
                averageRttMs: null,
                outboundPacketLossPercent: null,
                history: [],
            },
        });
    };

    /** Only the quick microphone test owns capture; closing its panel releases it immediately. */
    public setPanel = (panel: DesktopVoiceControlsViewSnapshot["panel"]): void => {
        if (this.isDisposed) return;
        this.snapshot.merge({ panel });
        if (panel !== "noise") void this.stopMicrophoneTest();
    };

    public setNoiseSuppression = async (enabled: boolean): Promise<void> => {
        await this.perform(async () => {
            await customizeDesktopVoiceProfile();
            await SettingsStore.setValue(
                "desktopNoiseSuppression",
                null,
                SettingLevel.DEVICE,
                enabled ? "enhanced" : "none",
            );
            this.microphoneTest.update();
            this.snapshot.merge({ noiseSuppressionProblem: undefined });
        });
    };

    public setNoiseSuppressionStrength = async (percent: number): Promise<void> => {
        if (!Number.isFinite(percent)) return;
        await this.perform(async () => {
            await customizeDesktopVoiceProfile();
            await SettingsStore.setValue(
                "desktopNoiseSuppressionStrength",
                null,
                SettingLevel.DEVICE,
                Math.max(0, Math.min(100, Math.round(percent))),
            );
            this.microphoneTest.update();
        });
    };

    private async restoreTestAudio(): Promise<void> {
        const restore = this.restoreAfterTest;
        this.restoreAfterTest = undefined;
        if (!restore) return;
        try {
            if (this.call === restore.call && this.props.callStore.connectedCalls.has(restore.call)) {
                restore.call.setAudioOutputEnabled(true);
                await restore.call.setDeviceMute({ audio_enabled: !restore.microphoneMuted });
            }
        } finally {
            // Restore preferences even if the call ended or its media controls are already unavailable.
            await SettingsStore.setValue("audioInputMuted", null, SettingLevel.DEVICE, restore.microphoneMuted);
            await SettingsStore.setValue("desktopDeafened", null, SettingLevel.DEVICE, false);
        }
    }

    private stopMicrophoneTest = async (): Promise<void> => {
        if (!this.snapshot.current.microphoneTest.active && !this.restoreAfterTest) return;
        this.testGeneration++;
        this.microphoneTest.stop();
        if (!this.isDisposed) this.snapshot.merge({ microphoneTest: { active: false, level: null, open: false } });
        await this.perform(() => this.restoreTestAudio());
    };

    /** Tests the processed microphone locally, deafening the call only for the duration of playback. */
    public toggleMicrophoneTest = async (): Promise<void> => {
        if (this.snapshot.current.microphoneTest.active) return this.stopMicrophoneTest();
        if (this.isDisposed || this.snapshot.current.panel !== "noise") return;
        const generation = ++this.testGeneration;
        this.snapshot.merge({
            microphoneTest: { active: true, level: null, open: false },
            noiseSuppressionProblem: undefined,
        });
        const failed = (error: unknown): void => {
            if (this.isDisposed || generation !== this.testGeneration) return;
            logger.warn("Could not test the microphone", error);
            this.microphoneTest.stop();
            this.snapshot.merge({
                microphoneTest: {
                    active: false,
                    level: null,
                    open: false,
                    error: mediaTestError(error),
                },
            });
        };
        try {
            // Do not hold the call controls busy while a microphone permission prompt is pending.
            await this.microphoneTest.start({ playback: false });
        } catch (error) {
            failed(error);
            return;
        }
        if (this.isDisposed || generation !== this.testGeneration) return;
        await this.perform(async () => {
            if (generation !== this.testGeneration) return;
            try {
                if (this.call && !SettingsStore.getValue("desktopDeafened")) {
                    this.restoreAfterTest = { call: this.call, microphoneMuted: this.snapshot.current.microphoneMuted };
                    await this.setDeafened(true);
                }
                if (generation !== this.testGeneration || this.isDisposed) return;
                await this.microphoneTest.setPlayback(true);
            } catch (error) {
                failed(error);
                await this.restoreTestAudio();
            }
        });
    };

    /** Plays a cue when somebody other than us joins or leaves the call we are in. */
    private readonly onParticipants = (
        participants: ReadonlyMap<RoomMember, unknown>,
        previous: ReadonlyMap<RoomMember, unknown>,
    ): void => {
        this.refresh();
        const ids = (members: ReadonlyMap<RoomMember, unknown>): Set<string> =>
            new Set(
                [...members.keys()].map((member) => member.userId).filter((id) => id !== this.props.client.getUserId()),
            );
        const now = ids(participants);
        const before = ids(previous);
        if ([...now].some((id) => !before.has(id))) void playDesktopVoiceSound("userJoined");
        else if ([...before].some((id) => !now.has(id))) void playDesktopVoiceSound("userLeft");
    };

    private readonly onScreenShare = (): void => {
        this.refresh();
        const sharing = this.call?.screenShare.sharing ?? false;
        if (sharing !== this.wasSharingScreen) {
            this.wasSharingScreen = sharing;
            void playDesktopVoiceSound(sharing ? "screenShareStart" : "screenShareStop");
        }
    };

    private readonly onDeviceMute = (): void => {
        const wasMuted = this.snapshot.current.microphoneMuted;
        this.refresh();
        const { microphoneMuted, busy, videoEnabled } = this.snapshot.current;
        if (videoEnabled !== this.wasVideoEnabled) {
            this.wasVideoEnabled = videoEnabled;
            void playDesktopVoiceSound(videoEnabled ? "cameraOn" : "cameraOff");
        }
        // Dock actions play their own single cue after success; include changes from the call-stage controls.
        if (!busy && wasMuted !== microphoneMuted) void playDesktopVoiceSound(microphoneMuted ? "mute" : "unmute");
        if (this.call?.deviceMuteState) {
            void SettingsStore.setValue(
                "audioInputMuted",
                null,
                SettingLevel.DEVICE,
                !this.call.deviceMuteState.audio_enabled,
            ).catch((error) => logger.warn("Could not save microphone preference", error));
        }
    };

    private readonly onCallsChanged = (): void => {
        const call = [...this.props.callStore.connectedCalls].find(
            (call): call is ElementCall => call instanceof ElementCall,
        );
        if (call !== this.call) {
            void this.stopMicrophoneTest();
            this.snapshot.merge({ panel: null });
            if (this.observedCalls) void playDesktopVoiceSound(call ? "join" : "leave");
            this.call?.off(CallEvent.DeviceMute, this.onDeviceMute);
            this.call?.off(CallEvent.ScreenShare, this.onScreenShare);
            this.call?.off(CallEvent.Participants, this.onParticipants);
            this.call?.off(CallEvent.ConnectionStats, this.refresh);
            this.call = call;
            this.wasVideoEnabled = call?.deviceMuteState?.video_enabled ?? false;
            this.wasSharingScreen = call?.screenShare.sharing ?? false;
            call?.on(CallEvent.DeviceMute, this.onDeviceMute);
            call?.on(CallEvent.ScreenShare, this.onScreenShare);
            call?.on(CallEvent.Participants, this.onParticipants);
            call?.on(CallEvent.ConnectionStats, this.refresh);
            if (call) {
                void this.perform(async () => {
                    if (this.call !== call || this.isDisposed) return;
                    const deafened = SettingsStore.getValue("desktopDeafened");
                    if (deafened) await call.setDeviceMute({ audio_enabled: false });
                    if (this.call === call && !this.isDisposed) call.setAudioOutputEnabled(!deafened);
                });
            }
        }
        this.observedCalls = true;
        this.refresh();
    };

    private perform = (
        action: () => Promise<void>,
        failure: TranslationKey = _td("desktop|voice|action_failed"),
    ): Promise<void> => {
        const run = async (): Promise<void> => {
            if (this.isDisposed) return;
            this.snapshot.merge({ busy: true, error: undefined });
            try {
                await action();
            } catch (error) {
                logger.warn("Desktop voice control failed", error);
                if (!this.isDisposed) this.snapshot.merge({ error: _t(failure) });
            } finally {
                if (!this.isDisposed) {
                    this.snapshot.merge({ busy: false });
                    this.refresh();
                }
            }
        };
        // Native events can arrive while an earlier device update is still awaiting the call host.
        const result = this.pendingAction ? this.pendingAction.then(run) : run();
        this.pendingAction = result;
        void result.then(() => {
            if (this.pendingAction === result) this.pendingAction = undefined;
        });
        return result;
    };

    private setMicrophoneMuted = async (muted: boolean): Promise<void> => {
        if (this.call) await this.call.setDeviceMute({ audio_enabled: !muted });
        await SettingsStore.setValue("audioInputMuted", null, SettingLevel.DEVICE, muted);
    };

    private setDeafened = async (deafened: boolean, forceUnmute = false): Promise<void> => {
        const wasMuted = this.snapshot.current.microphoneMuted;
        const restoreMuted = forceUnmute ? false : SettingsStore.getValue("desktopMicMutedBeforeDeafen");
        if (deafened) {
            await this.setMicrophoneMuted(true);
            try {
                this.call?.setAudioOutputEnabled(false);
            } catch (error) {
                await this.setMicrophoneMuted(wasMuted);
                throw error;
            }
            await SettingsStore.setValue("desktopMicMutedBeforeDeafen", null, SettingLevel.DEVICE, wasMuted);
        } else {
            this.call?.setAudioOutputEnabled(true);
            try {
                await this.setMicrophoneMuted(restoreMuted);
            } catch (error) {
                this.call?.setAudioOutputEnabled(false);
                throw error;
            }
        }
        await SettingsStore.setValue("desktopDeafened", null, SettingLevel.DEVICE, deafened);
    };

    public toggleMicrophone = async (): Promise<void> => {
        await this.stopMicrophoneTest();
        await this.perform(async () => {
            if (this.snapshot.current.deafened) await this.setDeafened(false, true);
            else await this.setMicrophoneMuted(!this.snapshot.current.microphoneMuted);
            void playDesktopVoiceSound(SettingsStore.getValue("audioInputMuted") ? "mute" : "unmute");
        });
    };
    public toggleDeafened = async (): Promise<void> => {
        await this.stopMicrophoneTest();
        await this.perform(async () => {
            await this.setDeafened(!this.snapshot.current.deafened);
            void playDesktopVoiceSound(SettingsStore.getValue("desktopDeafened") ? "deafen" : "undeafen");
        });
    };
    public toggleVideo = async (): Promise<void> => {
        await this.perform(async () => {
            await this.call?.setDeviceMute({ video_enabled: !this.snapshot.current.videoEnabled });
        }, _td("desktop|voice|camera_failed"));
    };
    public toggleScreenShare = async (): Promise<void> => {
        await this.perform(async () => {
            await this.call?.toggleScreenShare();
        }, _td("desktop|voice|screen_share_failed"));
    };
    public disconnect = async (): Promise<void> => {
        const call = this.call;
        call?.setLocalLeavePending(true);
        await this.stopMicrophoneTest();
        await this.perform(async () => {
            try {
                await call?.disconnect();
            } catch (error) {
                call?.setLocalLeavePending(false);
                throw error;
            }
        });
    };
    public showCall = (): void => {
        if (this.call)
            defaultDispatcher.dispatch<ViewRoomPayload>({
                action: Action.ViewRoom,
                room_id: this.call.roomId,
                metricsTrigger: undefined,
            });
    };
}
