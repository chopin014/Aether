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
import { type MatrixClient, RoomEvent } from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";

import { CallEvent, ElementCall } from "../../models/Call";
import { type CallStore, CallStoreEvent } from "../../stores/CallStore";
import SettingsStore from "../../settings/SettingsStore";
import { SettingLevel } from "../../settings/SettingLevel";
import defaultDispatcher from "../../dispatcher/dispatcher";
import { Action } from "../../dispatcher/actions";
import { type ViewRoomPayload } from "../../dispatcher/payloads/ViewRoomPayload";
import { UserTab } from "../../components/views/dialogs/UserTab";
import { _t } from "../../languageHandler";

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

    public constructor(props: Props) {
        super(props, {
            microphoneMuted: SettingsStore.getValue("audioInputMuted"),
            deafened: SettingsStore.getValue("desktopDeafened"),
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
        this.onCallsChanged();
    }

    private readonly refresh = (): void => {
        this.snapshot.merge({
            microphoneMuted: this.call?.deviceMuteState
                ? !this.call.deviceMuteState.audio_enabled
                : SettingsStore.getValue("audioInputMuted"),
            deafened: SettingsStore.getValue("desktopDeafened"),
            roomName: this.call ? (this.props.client.getRoom(this.call.roomId)?.name ?? this.call.roomId) : undefined,
        });
    };

    private readonly onDeviceMute = (): void => {
        this.refresh();
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
            this.call = call;
            call?.on(CallEvent.DeviceMute, this.onDeviceMute);
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

    private perform = async (action: () => Promise<void>): Promise<void> => {
        if (this.snapshot.current.busy) return;
        this.snapshot.merge({ busy: true, error: undefined });
        try {
            await action();
        } catch (error) {
            logger.warn("Desktop voice control failed", error);
            if (!this.isDisposed) this.snapshot.merge({ error: _t("desktop|voice|action_failed") });
        } finally {
            if (!this.isDisposed) {
                this.snapshot.merge({ busy: false });
                this.refresh();
            }
        }
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
    public openAudioSettings = (): void => {
        defaultDispatcher.dispatch({ action: Action.ViewUserSettings, initialTabId: UserTab.Voice });
    };
}
