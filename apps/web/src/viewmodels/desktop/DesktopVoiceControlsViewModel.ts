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

    public constructor(props: Props) {
        super(props, {
            microphoneMuted: SettingsStore.getValue("audioInputMuted"),
            deafened: SettingsStore.getValue("desktopDeafened"),
            videoEnabled: false,
            screenShareAvailable: false,
            screenSharing: false,
            busy: false,
        });
        props.callStore.on(CallStoreEvent.ConnectedCalls, this.onCallsChanged);
        this.disposables.track(() => props.callStore.off(CallStoreEvent.ConnectedCalls, this.onCallsChanged));
        this.disposables.trackListener(props.client, RoomEvent.Name, this.refresh);
        for (const setting of ["audioInputMuted", "desktopDeafened"] as const) {
            const ref = SettingsStore.watchSetting(setting, null, this.refresh);
            this.disposables.track(() => SettingsStore.unwatchSetting(ref));
        }
        this.disposables.track(() => this.call?.off(CallEvent.DeviceMute, this.onDeviceMute));
        this.disposables.track(() => this.call?.off(CallEvent.ScreenShare, this.onScreenShare));
        this.disposables.track(() => this.call?.off(CallEvent.Participants, this.onParticipants));
        this.onCallsChanged();
        if (SettingsStore.getValue("feature_desktop_shell")) {
            this.disposables.track(DesktopShortcutManager.instance.start());
            this.disposables.track(
                DesktopShortcutManager.instance.onEvent((event) => {
                    if (!event.pressed || event.reset) return;
                    if (event.id === "toggle_mute") void this.toggleMicrophone();
                    else if (event.id === "toggle_deafen") void this.toggleDeafened();
                    else if (event.id === "toggle_input_mode") {
                        void SettingsStore.setValue(
                            "desktopInputMode",
                            null,
                            SettingLevel.DEVICE,
                            SettingsStore.getValue("desktopInputMode") === "push_to_talk"
                                ? "voice_activity"
                                : "push_to_talk",
                        );
                    }
                }),
            );
        }
    }

    private readonly refresh = (): void => {
        this.snapshot.merge({
            microphoneMuted: this.call?.deviceMuteState
                ? !this.call.deviceMuteState.audio_enabled
                : SettingsStore.getValue("audioInputMuted"),
            deafened: SettingsStore.getValue("desktopDeafened"),
            videoEnabled: this.call?.deviceMuteState?.video_enabled ?? false,
            screenShareAvailable: this.call?.screenShare.available ?? false,
            screenSharing: this.call?.screenShare.sharing ?? false,
            roomName: this.call ? (this.props.client.getRoom(this.call.roomId)?.name ?? this.call.roomId) : undefined,
        });
    };

    /** Plays a cue when somebody other than us joins or leaves the call we are in. */
    private readonly onParticipants = (
        participants: ReadonlyMap<RoomMember, unknown>,
        previous: ReadonlyMap<RoomMember, unknown>,
    ): void => {
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
            if (this.observedCalls) void playDesktopVoiceSound(call ? "join" : "leave");
            this.call?.off(CallEvent.DeviceMute, this.onDeviceMute);
            this.call?.off(CallEvent.ScreenShare, this.onScreenShare);
            this.call?.off(CallEvent.Participants, this.onParticipants);
            this.call = call;
            this.wasVideoEnabled = call?.deviceMuteState?.video_enabled ?? false;
            this.wasSharingScreen = call?.screenShare.sharing ?? false;
            call?.on(CallEvent.DeviceMute, this.onDeviceMute);
            call?.on(CallEvent.ScreenShare, this.onScreenShare);
            call?.on(CallEvent.Participants, this.onParticipants);
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
        await this.perform(async () => {
            if (this.snapshot.current.deafened) await this.setDeafened(false, true);
            else await this.setMicrophoneMuted(!this.snapshot.current.microphoneMuted);
            void playDesktopVoiceSound(SettingsStore.getValue("audioInputMuted") ? "mute" : "unmute");
        });
    };
    public toggleDeafened = async (): Promise<void> => {
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
        await this.perform(async () => {
            await this.call?.disconnect();
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
