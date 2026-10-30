/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import type { ReactNode } from "react";
import {
    BaseViewModel,
    type DesktopCallStageCallee,
    type DesktopCallStageDeviceOption,
    type DesktopCallStageLayoutMode,
    type DesktopCallStageParticipantTile,
    type DesktopCallStageQualityState,
    type DesktopCallStageScreenShareTile,
    type DesktopCallStageViewModel as DesktopCallStageViewModelInterface,
    type DesktopCallStageViewSnapshot,
} from "@element-hq/web-shared-components";
import { KnownMembership, type MatrixClient } from "matrix-js-sdk/src/matrix";
import { isVideoRoom } from "../../utils/video-rooms";
import { mediaFromMxc } from "../../customisations/Media";

import type {
    AetherCallPresentationBridge,
    AetherMediaVolumeController,
    AetherParticipantMediaItem,
    AetherScreenShareMediaItem,
} from "../../components/views/voip/AetherCallPresentationTypes";
import { getInitialLetter } from "../../Avatar";
import MediaDeviceHandler, { MediaDeviceHandlerEvent, MediaDeviceKindEnum } from "../../MediaDeviceHandler";
import SettingsStore from "../../settings/SettingsStore";
import { SettingLevel } from "../../settings/SettingLevel";
import ActiveWidgetStore, { ActiveWidgetStoreEvent } from "../../stores/ActiveWidgetStore";
import defaultDispatcher from "../../dispatcher/dispatcher";
import { Action } from "../../dispatcher/actions";
import { showRoomInviteDialog } from "../../RoomInvite";
import { DesktopVoicePipeline } from "../../audio/desktop/DesktopVoicePipeline";
import { _t } from "../../languageHandler";
import type { ElementCall } from "../../models/Call";
import { resolveScreenShareQuality } from "../../audio/desktop/ScreenShareQuality";

import { SoundboardViewModel } from "./SoundboardViewModel";
import { DesktopCallRingtone } from "../../audio/DesktopCallRingtone";

/** The existing call engine and Matrix client shown by the desktop stage. */
export interface DesktopCallStageViewModelProps {
    readonly client: MatrixClient;
    readonly call: ElementCall;
    readonly bridge: AetherCallPresentationBridge;
}

const clampVolumePercent = (percent: number): number =>
    Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.round(percent))) : 100;

const mapParticipantTile = (
    client: MatrixClient,
    item: AetherParticipantMediaItem,
): DesktopCallStageParticipantTile => {
    const avatarUrl = item.avatarMxcUrl
        ? (mediaFromMxc(item.avatarMxcUrl, client).getSquareThumbnailHttp(96) ?? undefined)
        : undefined;
    const vol = item.microphoneVolume;
    return {
        id: item.id,
        userId: item.userId,
        displayName: item.displayName,
        avatarUrl,
        initialLetter: getInitialLetter(item.displayName || item.userId) || "?",
        local: item.local,
        speaking: item.speaking,
        audioEnabled: item.audioEnabled,
        videoEnabled: item.videoEnabled,
        deafened: item.deafened,
        mirror: item.mirror,
        waitingForMedia: item.waitingForMedia,
        unencryptedWarning: item.unencryptedWarning,
        encryptionStatus: item.encryptionStatus,
        handRaisedAt: item.handRaisedAt,
        reactionEmoji: item.reactionEmoji,
        video: item.video,
        hasVolumeControl: !item.local && vol !== null,
        microphoneVolumePercent: vol ? clampVolumePercent(vol.volume * 100) : 100,
        microphoneMuted: vol ? vol.muted : false,
    };
};

const mapScreenShareTile = (
    client: MatrixClient,
    item: AetherScreenShareMediaItem,
): DesktopCallStageScreenShareTile => {
    const avatarUrl = item.avatarMxcUrl
        ? (mediaFromMxc(item.avatarMxcUrl, client).getSquareThumbnailHttp(96) ?? undefined)
        : undefined;
    const vol = item.streamAudioVolume;
    return {
        id: item.id,
        userId: item.userId,
        displayName: item.displayName,
        avatarUrl,
        initialLetter: getInitialLetter(item.displayName || item.userId) || "?",
        local: item.local,
        videoEnabled: item.videoEnabled,
        audioEnabled: item.audioEnabled,
        unencryptedWarning: item.unencryptedWarning,
        encryptionStatus: item.encryptionStatus,
        video: item.video,
        hasStreamAudioVolumeControl: !item.local && vol !== null,
        streamAudioVolumePercent: vol ? clampVolumePercent(vol.volume * 100) : 100,
        streamAudioMuted: vol ? vol.muted : false,
    };
};

/**
 * The people a conversation call is ringing: everyone else in the room who has not joined yet, while the call still
 * rings. They join as participants, or drop out when the ringing is declined or times out.
 */
const ringingCallees = (
    client: MatrixClient,
    roomId: string,
    ringing: AetherCallPresentationBridge["state"]["ringing"],
    participants: readonly AetherParticipantMediaItem[],
): DesktopCallStageCallee[] => {
    const room = client.getRoom(roomId);
    if (ringing !== "ringing" || !room || isVideoRoom(room)) return [];
    const inCall = new Set(participants.map((participant) => participant.userId));
    return room
        .getMembers()
        .filter(
            (member) =>
                (member.membership === KnownMembership.Join || member.membership === KnownMembership.Invite) &&
                member.userId !== client.getUserId() &&
                !inCall.has(member.userId),
        )
        .map((member) => {
            const mxc = member.getMxcAvatarUrl();
            return {
                userId: member.userId,
                displayName: member.name,
                avatarUrl: mxc ? (mediaFromMxc(mxc, client).getSquareThumbnailHttp(96) ?? undefined) : undefined,
                initialLetter: getInitialLetter(member.name || member.userId) || "?",
            };
        });
};

/** Adapts the retained call engine to Aether's stage, device controls, and independent audio gains. */
export class DesktopCallStageViewModel
    extends BaseViewModel<DesktopCallStageViewSnapshot, DesktopCallStageViewModelProps>
    implements DesktopCallStageViewModelInterface
{
    private bridge: AetherCallPresentationBridge;
    private readonly participantVolumes = new Map<string, AetherMediaVolumeController>();
    private readonly screenShareVolumes = new Map<string, AetherMediaVolumeController>();
    private deviceChangeGeneration = 0;
    private deviceEnumerationGeneration = 0;
    private readonly ringtone = new DesktopCallRingtone();

    private qualityUpdate: Promise<void> = Promise.resolve();

    public constructor(props: DesktopCallStageViewModelProps) {
        const { state } = props.bridge;
        const docked = ActiveWidgetStore.instance.isDocked(props.call.widget.id, props.call.widget.roomId);
        const room = props.client.getRoom(props.call.roomId);
        super(props, {
            presentation: room && isVideoRoom(room) ? "channel" : "conversation",
            phase: state.phase,
            roomName: state.roomName,
            participantCount: state.participantCount,
            connected: state.connected,
            reconnecting: state.reconnecting,
            encrypted: state.encrypted,
            keyRotationSuppressed: state.keyRotationSuppressed,
            localAudioEnabled: state.localAudioEnabled,
            localVideoEnabled: state.localVideoEnabled,
            localDeafened: SettingsStore.getValue("desktopDeafened"),
            sharingScreen: state.sharingScreen,
            canShareScreen: state.canShareScreen,
            miniMode:
                !docked &&
                ActiveWidgetStore.instance.getWidgetPersistence(props.call.widget.id, props.call.widget.roomId),
            isFullscreen: typeof document !== "undefined" && Boolean(document.fullscreenElement),
            layoutMode: state.screenShares.length > 0 ? "spotlight" : "grid",
            spotlightTileId: state.screenShares[0]?.id ?? null,
            activeMenu: null,
            openTileMenuId: null,
            audioInputDevices: [],
            audioOutputDevices: [],
            videoInputDevices: [],
            participants: state.participants.map((p) => mapParticipantTile(props.client, p)),
            screenShares: state.screenShares.map((s) => mapScreenShareTile(props.client, s)),
            lobbyPreviewVideo: state.lobbyPreviewVideo,
            screenShareQuality: state.screenShareQuality,
            screenSharePolicyLimits: state.screenSharePolicyLimits,
            fatalError: state.fatalError,
            screenShareError: state.screenShareError,
            deviceError: null,
            needsDevicePermissions: state.needsDevicePermissions,
            permissionError: state.permissionError,
            supportsReactions: state.supportsReactions,
            localHandRaised: state.participants.some(
                (participant) => participant.local && participant.handRaisedAt !== null,
            ),
            ringing: state.ringing,
            callees: ringingCallees(props.client, props.call.roomId, state.ringing, state.participants),
            canShareSystemAudio: !window.electron,
        });
        const soundboard = SoundboardViewModel.acquire({ client: props.client, call: props.call });
        this.disposables.track(soundboard.release);
        this.snapshot.merge({ soundboard: soundboard.vm });
        this.bridge = props.bridge;
        this.syncVolumeMaps(state.participants, state.screenShares);

        const deafenRef = SettingsStore.watchSetting("desktopDeafened", null, this.onDeafenChanged);
        this.disposables.track(() => SettingsStore.unwatchSetting(deafenRef));
        for (const setting of ["webrtc_audioinput", "webrtc_audiooutput", "webrtc_videoinput"] as const) {
            const ref = SettingsStore.watchSetting(setting, null, this.refreshDevices);
            this.disposables.track(() => SettingsStore.unwatchSetting(ref));
        }

        if (navigator.mediaDevices?.addEventListener) {
            navigator.mediaDevices.addEventListener("devicechange", this.refreshDevices);
            this.disposables.track(() =>
                navigator.mediaDevices.removeEventListener("devicechange", this.refreshDevices),
            );
        }

        this.disposables.trackListener(ActiveWidgetStore.instance, ActiveWidgetStoreEvent.Dock, this.onDockChanged);
        this.disposables.trackListener(ActiveWidgetStore.instance, ActiveWidgetStoreEvent.Undock, this.onDockChanged);
        this.disposables.trackListener(
            MediaDeviceHandler.instance,
            MediaDeviceHandlerEvent.AudioOutputChanged,
            this.refreshDevices,
        );

        if (typeof document !== "undefined") {
            const onFullscreenChange = (): void => {
                if (!this.isDisposed) {
                    this.snapshot.merge({ isFullscreen: Boolean(document.fullscreenElement) });
                }
            };
            document.addEventListener("fullscreenchange", onFullscreenChange);
            this.disposables.track(() => document.removeEventListener("fullscreenchange", onFullscreenChange));
        }

        this.disposables.track(() => this.ringtone.setRinging(false));
        this.ringtone.setRinging(
            !this.props.call.locallyLeaving && state.phase === "in_call" && state.ringing === "ringing",
        );
        void this.refreshDevices();
    }

    /** Refresh engine-owned state without replacing local layout and open-menu preferences. */
    public setBridge = (bridge: AetherCallPresentationBridge): void => {
        if (this.isDisposed) return;
        const previousShareCount = this.bridge.state.screenShares.length;
        this.bridge = bridge;
        const { state } = bridge;
        this.ringtone.setRinging(
            !this.props.call.locallyLeaving && state.phase === "in_call" && state.ringing === "ringing",
        );
        this.syncVolumeMaps(state.participants, state.screenShares);

        let { layoutMode, spotlightTileId } = this.snapshot.current;
        if (previousShareCount === 0 && state.screenShares.length > 0) {
            layoutMode = "spotlight";
            spotlightTileId = state.screenShares[0].id;
        } else if (
            spotlightTileId !== null &&
            !state.screenShares.some((s) => s.id === spotlightTileId) &&
            !state.participants.some((p) => p.id === spotlightTileId)
        ) {
            spotlightTileId = state.screenShares[0]?.id ?? null;
            if (spotlightTileId === null) layoutMode = "grid";
        }

        this.snapshot.merge({
            phase: state.phase,
            roomName: state.roomName,
            participantCount: state.participantCount,
            connected: state.connected,
            reconnecting: state.reconnecting,
            encrypted: state.encrypted,
            keyRotationSuppressed: state.keyRotationSuppressed,
            localAudioEnabled: state.localAudioEnabled,
            localVideoEnabled: state.localVideoEnabled,
            sharingScreen: state.sharingScreen,
            canShareScreen: state.canShareScreen,
            layoutMode,
            spotlightTileId,
            participants: state.participants.map((p) => mapParticipantTile(this.props.client, p)),
            screenShares: state.screenShares.map((s) => mapScreenShareTile(this.props.client, s)),
            lobbyPreviewVideo: state.lobbyPreviewVideo,
            screenShareQuality: state.screenShareQuality,
            screenSharePolicyLimits: state.screenSharePolicyLimits,
            fatalError: state.fatalError,
            screenShareError: state.screenShareError,
            needsDevicePermissions: state.needsDevicePermissions,
            permissionError: state.permissionError,
            supportsReactions: state.supportsReactions,
            localHandRaised: state.participants.some(
                (participant) => participant.local && participant.handRaisedAt !== null,
            ),
            ringing: state.ringing,
            callees: ringingCallees(this.props.client, this.props.call.roomId, state.ringing, state.participants),
        });
    };

    private syncVolumeMaps(
        participants: readonly AetherParticipantMediaItem[],
        screenShares: readonly AetherScreenShareMediaItem[],
    ): void {
        this.participantVolumes.clear();
        for (const p of participants) {
            if (p.microphoneVolume) this.participantVolumes.set(p.id, p.microphoneVolume);
        }
        this.screenShareVolumes.clear();
        for (const s of screenShares) {
            if (s.streamAudioVolume) this.screenShareVolumes.set(s.id, s.streamAudioVolume);
        }
    }

    private readonly onDeafenChanged = (): void => {
        if (!this.isDisposed) {
            this.snapshot.merge({ localDeafened: SettingsStore.getValue("desktopDeafened") });
        }
    };

    private readonly onDockChanged = (): void => {
        if (this.isDisposed) return;
        const { id, roomId } = this.props.call.widget;
        const docked = ActiveWidgetStore.instance.isDocked(id, roomId);
        const persistent = ActiveWidgetStore.instance.getWidgetPersistence(id, roomId);
        this.snapshot.merge({ miniMode: !docked && persistent });
    };

    public readonly refreshDevices = async (): Promise<void> => {
        if (this.isDisposed) return;
        const generation = ++this.deviceEnumerationGeneration;
        try {
            const devices = await MediaDeviceHandler.getDevices();
            if (this.isDisposed || generation !== this.deviceEnumerationGeneration || !devices) return;
            const currentAudioIn = MediaDeviceHandler.getAudioInput();
            const currentAudioOut = MediaDeviceHandler.getAudioOutput();
            const currentVideoIn = MediaDeviceHandler.getVideoInput();
            const mapList = (
                list: MediaDeviceInfo[],
                selectedId: string,
                fallbackLabel: (index: number) => string,
            ): DesktopCallStageDeviceOption[] =>
                list.map((d, idx) => ({
                    id: d.deviceId,
                    label: d.label || fallbackLabel(idx + 1),
                    selected: d.deviceId === selectedId || (!selectedId && idx === 0),
                }));
            this.snapshot.merge({
                audioInputDevices: mapList(devices[MediaDeviceKindEnum.AudioInput] ?? [], currentAudioIn, (index) =>
                    _t("desktop|call_stage|fallback_microphone", { index }),
                ),
                audioOutputDevices: mapList(devices[MediaDeviceKindEnum.AudioOutput] ?? [], currentAudioOut, (index) =>
                    _t("desktop|call_stage|fallback_speaker", { index }),
                ),
                videoInputDevices: mapList(devices[MediaDeviceKindEnum.VideoInput] ?? [], currentVideoIn, (index) =>
                    _t("desktop|call_stage|fallback_camera", { index }),
                ),
            });
        } catch {
            // Ignore device enumeration errors in restricted environments
        }
    };

    public returnToLobby = (): void => this.bridge.actions.returnToLobby();

    public joinCall = (): void => {
        this.bridge.actions.joinCall();
    };

    public leaveCall = (): void => {
        this.ringtone.setRinging(false);
        this.props.call.setLocalLeavePending(true);
        try {
            this.bridge.actions.leaveCall();
        } catch (error) {
            this.props.call.setLocalLeavePending(false);
            this.reportActionError(error);
        }
    };

    public requestDevicePermissions = (): void => this.bridge.actions.requestDevicePermissions();

    public toggleRaisedHand = (): void => {
        void Promise.resolve(this.bridge.actions.toggleRaisedHand()).catch(this.reportActionError);
    };

    public sendReaction = (emoji: string): void => {
        void Promise.resolve(this.bridge.actions.sendReaction({ emoji, name: emoji })).catch(this.reportActionError);
    };

    private reportActionError = (error: unknown): void => {
        if (!this.isDisposed)
            this.snapshot.merge({ deviceError: error instanceof Error ? error.message : String(error) });
    };

    public reconnect = (): void => {
        this.bridge.actions.reconnect();
    };

    public toggleLocalAudio = (): void => {
        if (this.snapshot.current.localDeafened && !this.snapshot.current.localAudioEnabled) {
            void SettingsStore.setValue("desktopDeafened", null, SettingLevel.DEVICE, false);
        }
        this.bridge.actions.toggleLocalAudio();
    };

    public toggleLocalVideo = (): void => {
        this.bridge.actions.toggleLocalVideo();
    };

    public toggleScreenShare = (): void => {
        if (this.snapshot.current.sharingScreen) {
            void Promise.resolve(this.bridge.actions.stopScreenShare()).catch(this.reportActionError);
        } else {
            const quality = this.snapshot.current.screenShareQuality;
            DesktopVoicePipeline.instance.setScreenShareQuality(quality);
            void Promise.resolve(this.bridge.actions.startScreenShare(quality)).catch(this.reportActionError);
        }
    };

    public startScreenShareWithQuality = (quality: Partial<DesktopCallStageQualityState>): void => {
        const resolved = resolveScreenShareQuality(
            { ...this.snapshot.current.screenShareQuality, ...quality },
            this.snapshot.current.screenSharePolicyLimits,
        );
        const merged = {
            ...resolved,
            includeSystemAudio: this.snapshot.current.canShareSystemAudio && resolved.includeSystemAudio,
        };
        DesktopVoicePipeline.instance.setScreenShareQuality(merged);
        void Promise.resolve(this.bridge.actions.startScreenShare(merged)).catch(this.reportActionError);
    };

    public updateScreenShareQuality = (quality: Partial<DesktopCallStageQualityState>): Promise<void> => {
        // Each partial choice builds on the previous engine-confirmed quality, including rapid successive clicks.
        this.qualityUpdate = this.qualityUpdate.then(async () => {
            if (this.isDisposed) return;
            const resolved = resolveScreenShareQuality(
                { ...this.snapshot.current.screenShareQuality, ...quality },
                this.snapshot.current.screenSharePolicyLimits,
            );
            const merged = {
                ...resolved,
                includeSystemAudio: this.snapshot.current.canShareSystemAudio && resolved.includeSystemAudio,
            };
            try {
                await this.bridge.actions.updateScreenShareQuality(merged);
                if (this.isDisposed) return;
                DesktopVoicePipeline.instance.setScreenShareQuality(merged);
                this.snapshot.merge({ screenShareQuality: merged });
            } catch (error) {
                this.reportActionError(error);
            }
        });
        return this.qualityUpdate;
    };

    public dismissScreenShareError = (): void => {
        this.bridge.actions.dismissScreenShareError();
    };

    public selectAudioInput = async (deviceId: string): Promise<void> => {
        await this.changeDevice(() => MediaDeviceHandler.instance.setAudioInput(deviceId));
    };

    public selectAudioOutput = async (deviceId: string): Promise<void> => {
        await this.changeDevice(() => MediaDeviceHandler.instance.setAudioOutput(deviceId));
    };

    public selectVideoInput = async (deviceId: string): Promise<void> => {
        await this.changeDevice(() => MediaDeviceHandler.instance.setVideoInput(deviceId));
    };

    private async changeDevice(change: () => void | Promise<void>): Promise<void> {
        const generation = ++this.deviceChangeGeneration;
        try {
            await change();
            if (this.isDisposed || generation !== this.deviceChangeGeneration) return;
            this.snapshot.merge({ deviceError: null });
            await this.refreshDevices();
        } catch (error) {
            if (this.isDisposed || generation !== this.deviceChangeGeneration) return;
            this.snapshot.merge({ deviceError: error instanceof Error ? error.message : String(error) });
        }
    }

    public dismissDeviceError = (): void => {
        this.snapshot.merge({ deviceError: null });
    };

    public setActiveMenu = (menu: DesktopCallStageViewSnapshot["activeMenu"]): void => {
        if (menu !== null) void this.refreshDevices();
        this.snapshot.merge({ activeMenu: menu, openTileMenuId: null });
    };

    public setOpenTileMenuId = (tileId: string | null): void => {
        this.snapshot.merge({ openTileMenuId: tileId, activeMenu: null });
    };

    public setSpotlightTileId = (tileId: string | null): void => {
        this.snapshot.merge({
            spotlightTileId: tileId,
            layoutMode: tileId !== null ? "spotlight" : "grid",
        });
    };

    public setLayoutMode = (mode: DesktopCallStageLayoutMode): void => {
        const nextSpotlight =
            mode === "spotlight"
                ? (this.snapshot.current.spotlightTileId ??
                  this.snapshot.current.screenShares[0]?.id ??
                  this.snapshot.current.participants[0]?.id ??
                  null)
                : null;
        this.snapshot.merge({ layoutMode: mode, spotlightTileId: nextSpotlight });
    };

    public setParticipantMicrophoneVolume = (tileId: string, volumePercent: number): void => {
        const ctrl = this.participantVolumes.get(tileId);
        if (!ctrl) return;
        const clamped = clampVolumePercent(volumePercent);
        ctrl.setVolume(clamped / 100);
        this.snapshot.merge({
            participants: this.snapshot.current.participants.map((p) =>
                p.id === tileId ? { ...p, microphoneVolumePercent: clamped, microphoneMuted: clamped === 0 } : p,
            ),
        });
    };

    public toggleParticipantMicrophoneMuted = (tileId: string): void => {
        const ctrl = this.participantVolumes.get(tileId);
        if (!ctrl) return;
        ctrl.toggleMuted();
        this.snapshot.merge({
            participants: this.snapshot.current.participants.map((p) =>
                p.id === tileId ? { ...p, microphoneMuted: !p.microphoneMuted } : p,
            ),
        });
    };

    public setScreenShareAudioVolume = (tileId: string, volumePercent: number): void => {
        const ctrl = this.screenShareVolumes.get(tileId);
        if (!ctrl) return;
        const clamped = clampVolumePercent(volumePercent);
        ctrl.setVolume(clamped / 100);
        this.snapshot.merge({
            screenShares: this.snapshot.current.screenShares.map((s) =>
                s.id === tileId ? { ...s, streamAudioVolumePercent: clamped, streamAudioMuted: clamped === 0 } : s,
            ),
        });
    };

    public toggleScreenShareAudioMuted = (tileId: string): void => {
        const ctrl = this.screenShareVolumes.get(tileId);
        if (!ctrl) return;
        ctrl.toggleMuted();
        this.snapshot.merge({
            screenShares: this.snapshot.current.screenShares.map((s) =>
                s.id === tileId ? { ...s, streamAudioMuted: !s.streamAudioMuted } : s,
            ),
        });
    };

    public openInviteDialog = (): void => {
        showRoomInviteDialog(this.props.call.roomId);
    };

    public showRoomChat = (): void => {
        defaultDispatcher.dispatch({
            action: Action.ViewRoom,
            room_id: this.props.call.roomId,
            view_call: false,
            metricsTrigger: undefined,
        });
    };

    public popoutCall = (): void => {
        defaultDispatcher.dispatch({
            action: Action.ViewRoom,
            room_id: this.props.call.roomId,
            view_call: false,
            metricsTrigger: undefined,
        });
    };

    public toggleFullscreen = (stageElement?: HTMLElement | null): void => {
        if (typeof document === "undefined") return;
        if (document.fullscreenElement) {
            void document.exitFullscreen().catch(() => {});
        } else if (stageElement?.requestFullscreen) {
            void stageElement.requestFullscreen().catch(() => {});
        }
    };

    public renderAudioElement = (): ReactNode => {
        return this.bridge.state.renderAudioElement();
    };
}
