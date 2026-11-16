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
import { ClientEvent, KnownMembership, type MatrixClient, type RoomMember } from "matrix-js-sdk/src/matrix";
import { isVideoRoom } from "../../utils/video-rooms";
import { mediaFromMxc } from "../../customisations/Media";

import type {
    AetherCallPresentationBridge,
    AetherMediaVolumeController,
    AetherParticipantMediaItem,
    AetherScreenShareMediaItem,
} from "../../components/views/voip/AetherCallPresentationTypes";
import { getInitialLetter } from "../../Avatar";
import DMRoomMap from "../../utils/DMRoomMap";
import MediaDeviceHandler, { MediaDeviceHandlerEvent, MediaDeviceKindEnum } from "../../MediaDeviceHandler";
import SettingsStore from "../../settings/SettingsStore";
import { SettingLevel } from "../../settings/SettingLevel";
import ActiveWidgetStore, { ActiveWidgetStoreEvent } from "../../stores/ActiveWidgetStore";
import defaultDispatcher from "../../dispatcher/dispatcher";
import { Action } from "../../dispatcher/actions";
import { showRoomInviteDialog } from "../../RoomInvite";
import { DesktopVoicePipeline } from "../../audio/desktop/DesktopVoicePipeline";
import { _t } from "../../languageHandler";
import { CallEvent, type ElementCall } from "../../models/Call";
import { resolveScreenShareQuality } from "../../audio/desktop/ScreenShareQuality";

import { RichProfileStore } from "../../profile/RichProfileStore";
import { appearanceFromRichProfile } from "../../profile/richProfileView";

import { SoundboardViewModel } from "./SoundboardViewModel";
import { VoiceUserMenuViewModel } from "./VoiceUserMenuViewModel";
import {
    MAX_USER_VOLUME,
    VoiceUserPreferences,
    VoiceUserPreferencesEvent,
} from "../../audio/desktop/VoiceUserPreferences";
import { DesktopCallRingtone } from "../../audio/DesktopCallRingtone";

/** The existing call engine and Matrix client shown by the desktop stage. */
export interface DesktopCallStageViewModelProps {
    readonly client: MatrixClient;
    readonly call: ElementCall;
    readonly bridge: AetherCallPresentationBridge;
}

const clampVolumePercent = (percent: number): number =>
    Number.isFinite(percent) ? Math.max(0, Math.min(MAX_USER_VOLUME * 100, Math.round(percent))) : 100;

const mapParticipantTile = (
    client: MatrixClient,
    item: AetherParticipantMediaItem,
    soundboardUsers?: ReadonlySet<string>,
): DesktopCallStageParticipantTile => {
    const avatarUrl = item.avatarMxcUrl
        ? (mediaFromMxc(item.avatarMxcUrl, client).getSquareThumbnailHttp(96) ?? undefined)
        : undefined;
    const profile =
        SettingsStore.getValue("showProfileAppearance") && !client.isUserIgnored(item.userId)
            ? RichProfileStore.forClient(client).get(item.userId)
            : undefined;
    // What this user chose for the person on this device: their volume, a mute and a hidden camera.
    const preference = item.local ? undefined : VoiceUserPreferences.instance.get(item.userId);
    const videoHidden = preference?.videoDisabled ?? false;
    return {
        id: item.id,
        userId: item.userId,
        displayName: item.displayName,
        avatarUrl,
        initialLetter: getInitialLetter(item.displayName || item.userId) || "?",
        appearance: profile ? appearanceFromRichProfile(profile, item.avatarMxcUrl) : undefined,
        local: item.local,
        speaking: item.speaking,
        soundboardPlaying: soundboardUsers?.has(item.userId) || undefined,
        audioEnabled: item.audioEnabled,
        videoEnabled: item.videoEnabled && !videoHidden,
        deafened: item.deafened,
        mirror: item.mirror,
        waitingForMedia: item.waitingForMedia,
        unencryptedWarning: item.unencryptedWarning,
        encryptionStatus: item.encryptionStatus,
        handRaisedAt: item.handRaisedAt,
        reactionEmoji: item.reactionEmoji,
        video: videoHidden ? null : item.video,
        locallyMuted: preference?.muted ?? false,
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

/** A tile for someone the call has not reported media for yet: the user while joining, or a person already in it. */
const pendingParticipant = (
    client: MatrixClient,
    person: { userId: string; name: string; mxc?: string | null },
    local: boolean,
    id = `pending:${person.userId}`,
): AetherParticipantMediaItem => ({
    id,
    userId: person.userId,
    displayName: person.name,
    avatarMxcUrl: person.mxc ?? undefined,
    local,
    speaking: false,
    audioEnabled: local ? !SettingsStore.getValue("audioInputMuted") : true,
    videoEnabled: false,
    deafened: local ? SettingsStore.getValue("desktopDeafened") : false,
    mirror: false,
    waitingForMedia: true,
    unencryptedWarning: false,
    encryptionStatus: "connecting",
    handRaisedAt: null,
    reactionEmoji: null,
    video: null,
    microphoneVolume: null,
});

/**
 * The participants with the user among them. Element Call reports nobody for a moment as it goes from joining to in
 * the call, which made the user's own tile vanish and come back while a conversation rang.
 *
 * @param localTileId - The ID Element Call last gave the user's tile, so that the stand-in is the same tile.
 */
const withLocalUser = (
    client: MatrixClient,
    call: ElementCall,
    participants: readonly AetherParticipantMediaItem[],
    localTileId?: string,
): readonly AetherParticipantMediaItem[] => {
    const me = client.getUserId();
    if (!me || participants.some((participant) => participant.local)) return participants;
    const member = client.getRoom(call.roomId)?.getMember(me);
    const person = { userId: me, name: member?.name ?? me, mxc: member?.getMxcAvatarUrl() };
    return [pendingParticipant(client, person, true, localTileId), ...participants];
};

/**
 * What the stage shows for the engine's state. A call the user asked to join is shown as joining straight away,
 * even while Element Call still sits in its lobby for a moment before joining by itself, and until the engine reports
 * media, the stage shows who it already knows about: the user, the people already in the call, and, in a direct
 * conversation that nobody else is in yet, the person being called. Element Call replaces them as it connects.
 *
 * @param localTileId - The ID Element Call last gave the user's tile, see {@link withLocalUser}.
 */
const presentedState = (
    client: MatrixClient,
    call: ElementCall,
    state: AetherCallPresentationBridge["state"],
    ringPending = false,
    localTileId?: string,
): {
    phase: AetherCallPresentationBridge["state"]["phase"];
    participants: readonly AetherParticipantMediaItem[];
    ringing: AetherCallPresentationBridge["state"]["ringing"];
} => {
    const joining = state.phase === "joining" || (state.phase === "lobby" && call.joinRequested && !state.fatalError);
    const alone = state.participants.every((participant) => participant.local);
    const isConversation = !!DMRoomMap.shared()?.getUserIdForRoomId(call.roomId);
    if (!joining || !alone) {
        // Element Call reports being in the call a moment before it reports ringing; keep showing who is called.
        const ringing =
            state.ringing ?? (ringPending && isConversation && alone && state.phase === "in_call" ? "ringing" : null);
        // In the call, Element Call reports nobody for a moment while it moves from joining to its media.
        const participants =
            joining || (state.phase === "in_call" && state.participants.length === 0)
                ? withLocalUser(client, call, state.participants, localTileId)
                : state.participants;
        return { phase: joining ? "joining" : state.phase, participants, ringing };
    }
    const me = client.getUserId();
    const participants = [...withLocalUser(client, call, state.participants, localTileId)];
    for (const member of call.participants.keys()) {
        if (member.userId === me || participants.some((participant) => participant.userId === member.userId)) continue;
        participants.push(
            pendingParticipant(
                client,
                { userId: member.userId, name: member.name, mxc: member.getMxcAvatarUrl() },
                false,
            ),
        );
    }
    // A direct conversation nobody else is in rings the other person once joined; show them as called already.
    const ringsSomeone = isConversation && participants.every((p) => p.local);
    return { phase: "joining", participants, ringing: state.ringing ?? (ringsSomeone ? "ringing" : null) };
};

/** Everyone already in the call, shown in the lobby before the user joins. */
const lobbyParticipants = (client: MatrixClient, members: Iterable<RoomMember>): DesktopCallStageCallee[] =>
    [...members]
        .map((member) => {
            const mxc = member.getMxcAvatarUrl();
            return {
                userId: member.userId,
                displayName: member.name,
                avatarUrl: mxc ? (mediaFromMxc(mxc, client).getSquareThumbnailHttp(96) ?? undefined) : undefined,
                initialLetter: getInitialLetter(member.name || member.userId) || "?",
            };
        })
        .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.userId.localeCompare(b.userId));

/** Adapts the retained call engine to Aether's stage, device controls, and independent audio gains. */
export class DesktopCallStageViewModel
    extends BaseViewModel<DesktopCallStageViewSnapshot, DesktopCallStageViewModelProps>
    implements DesktopCallStageViewModelInterface
{
    private bridge: AetherCallPresentationBridge;
    /**
     * Whether this call's ringing has yet to be reported: until Element Call says how ringing went, or somebody else
     * joins, a conversation call shows the person being called.
     */
    private ringPending = true;
    /** The ID Element Call last gave the user's own tile, see {@link withLocalUser}. */
    private localTileId?: string;
    /** Microphone playback of each remote person, by user ID; someone in the call twice has two. */
    private readonly participantVolumes = new Map<string, AetherMediaVolumeController[]>();
    private readonly screenShareVolumes = new Map<string, AetherMediaVolumeController>();
    private readonly profileSubscriptions = new Map<string, () => void>();
    private deviceChangeGeneration = 0;
    private deviceEnumerationGeneration = 0;
    private readonly ringtone = new DesktopCallRingtone();
    private ringtoneStarted = false;

    private qualityUpdate: Promise<void> = Promise.resolve();

    public constructor(props: DesktopCallStageViewModelProps) {
        const { state } = props.bridge;
        const docked = ActiveWidgetStore.instance.isDocked(props.call.widget.id, props.call.widget.roomId);
        const room = props.client.getRoom(props.call.roomId);
        const presented = presentedState(props.client, props.call, state, true);
        super(props, {
            presentation: room && isVideoRoom(room) ? "channel" : "conversation",
            phase: presented.phase,
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
            participants: presented.participants.map((p) =>
                mapParticipantTile(props.client, p, props.call.soundboardUserIds),
            ),
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
            ringing: presented.ringing,
            callees: ringingCallees(props.client, props.call.roomId, presented.ringing, presented.participants),
            lobbyParticipants: lobbyParticipants(props.client, props.call.participants.keys()),
            participantMenu: null,
            canShareSystemAudio: !window.electron || !!window.electron.desktopAudio,
        });
        const soundboard = SoundboardViewModel.acquire({ client: props.client, call: props.call });
        this.disposables.track(soundboard.release);
        this.snapshot.merge({ soundboard: soundboard.vm });
        this.bridge = props.bridge;
        this.syncVolumeMaps(state.participants, state.screenShares);
        this.applyUserPreferences();
        this.syncProfiles();
        this.disposables.track(() => {
            for (const unsubscribe of this.profileSubscriptions.values()) unsubscribe();
            this.profileSubscriptions.clear();
        });
        const appearanceRef = SettingsStore.watchSetting("showProfileAppearance", null, this.refreshProfiles);
        this.disposables.track(() => SettingsStore.unwatchSetting(appearanceRef));
        this.disposables.trackListener(props.client, ClientEvent.AccountData, this.refreshProfiles);

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

        this.disposables.trackListener(
            VoiceUserPreferences.instance,
            VoiceUserPreferencesEvent.Changed,
            this.onUserPreferencesChanged,
        );
        this.disposables.trackListener(props.call, CallEvent.Participants, this.onCallParticipantsChanged);
        this.disposables.track(() => this.closeParticipantMenu());

        this.disposables.trackListener(props.call, CallEvent.SoundboardUsers, () => {
            this.snapshot.merge({ participants: this.participantTiles() });
        });
        // Asking to join, or leaving, changes whether the lobby is shown as joining.
        this.disposables.trackListener(props.call, CallEvent.JoinRequested, () => this.setBridge(this.bridge));
        this.disposables.track(() => this.ringtone.setRinging(false));

        void this.refreshDevices();
    }

    /** Starts audio after React commits, so discarded renders cannot leave a second ringback playing. */
    public startRingtone = (): (() => void) => {
        if (this.isDisposed) return () => {};
        this.ringtoneStarted = true;
        this.updateRingtone();
        return () => {
            this.ringtoneStarted = false;
            this.ringtone.setRinging(false);
        };
    };

    /**
     * The ringback plays while the stage shows the call ringing someone: from the click that starts it, as the call
     * area says "Calling…", not from when Element Call reports the ringing a second or more later.
     */
    private updateRingtone = (): void => {
        if (!this.ringtoneStarted) return;
        const presented = this.present();
        this.ringtone.setRinging(
            !this.props.call.locallyLeaving &&
                (presented.phase === "in_call" || presented.phase === "joining") &&
                presented.ringing === "ringing",
        );
    };

    /** Refresh engine-owned state without replacing local layout and open-menu preferences. */
    public setBridge = (bridge: AetherCallPresentationBridge): void => {
        if (this.isDisposed) return;
        const previousShareCount = this.bridge.state.screenShares.length;
        this.bridge = bridge;
        const { state } = bridge;
        this.syncProfiles();
        this.syncVolumeMaps(state.participants, state.screenShares);
        this.applyUserPreferences();

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

        if (state.ringing !== null || state.participants.some((participant) => !participant.local)) {
            this.ringPending = false;
        }
        const presented = this.present();
        this.updateRingtone();
        this.snapshot.merge({
            phase: presented.phase,
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
            participants: presented.participants.map((p) =>
                mapParticipantTile(this.props.client, p, this.props.call.soundboardUserIds),
            ),
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
            ringing: presented.ringing,
            callees: ringingCallees(
                this.props.client,
                this.props.call.roomId,
                presented.ringing,
                presented.participants,
            ),
        });
    };

    /** What the stage shows for the current engine state, see {@link presentedState}. */
    private present(): ReturnType<typeof presentedState> {
        const local = this.bridge.state.participants.find((participant) => participant.local);
        if (local) this.localTileId = local.id;
        return presentedState(
            this.props.client,
            this.props.call,
            this.bridge.state,
            this.ringPending,
            this.localTileId,
        );
    }

    /** The participant tiles for the current engine state, see {@link presentedState}. */
    private participantTiles(): DesktopCallStageParticipantTile[] {
        return this.present().participants.map((p) =>
            mapParticipantTile(this.props.client, p, this.props.call.soundboardUserIds),
        );
    }

    private readonly refreshProfiles = (): void => {
        if (this.isDisposed) return;
        this.syncProfiles();
        this.snapshot.merge({ participants: this.participantTiles() });
    };

    private syncProfiles(): void {
        const store = RichProfileStore.forClient(this.props.client);
        const users = new Set(
            this.bridge.state.participants
                .filter(
                    (p) =>
                        SettingsStore.getValue("showProfileAppearance") && !this.props.client.isUserIgnored(p.userId),
                )
                .map((p) => p.userId),
        );
        for (const [userId, unsubscribe] of this.profileSubscriptions) {
            if (!users.has(userId)) {
                unsubscribe();
                this.profileSubscriptions.delete(userId);
            }
        }
        for (const userId of users) {
            if (this.profileSubscriptions.has(userId)) continue;
            this.profileSubscriptions.set(userId, store.subscribe(userId, this.refreshProfiles));
            void store.request(userId);
        }
    }

    private syncVolumeMaps(
        participants: readonly AetherParticipantMediaItem[],
        screenShares: readonly AetherScreenShareMediaItem[],
    ): void {
        this.participantVolumes.clear();
        for (const p of participants) {
            if (p.microphoneVolume)
                this.participantVolumes.set(p.userId, [
                    ...(this.participantVolumes.get(p.userId) ?? []),
                    p.microphoneVolume,
                ]);
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

    public leaveCall = async (): Promise<void> => {
        if (this.isDisposed || this.props.call.locallyLeaving) return;
        this.ringtone.setRinging(false);
        try {
            // Use the same model-owned disconnect as the dock, which also shows the leave at once. The engine's
            // stage action can return to its lobby without notifying the host after its subscriptions have been
            // disposed.
            await this.props.call.disconnect();
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
                const confirmed = await this.bridge.actions.updateScreenShareQuality(merged);
                if (this.isDisposed) return;
                const applied = confirmed ?? merged;
                DesktopVoicePipeline.instance.setScreenShareQuality(applied);
                this.snapshot.merge({ screenShareQuality: applied });
            } catch (error) {
                if (!(error instanceof Error && error.name === "ScreenShareCancelledError"))
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
        this.closeParticipantMenu();
        this.snapshot.merge({ activeMenu: menu, openTileMenuId: null, participantMenu: null });
    };

    /** Opens a tile's menu: a person's full menu, or the volume of a screen share's audio. */
    public setOpenTileMenuId = (tileId: string | null): void => {
        this.closeParticipantMenu();
        const participant = this.snapshot.current.participants.find((p) => p.id === tileId);
        if (participant) {
            this.participantMenu = new VoiceUserMenuViewModel({
                client: this.props.client,
                userId: participant.userId,
                room: this.props.client.getRoom(this.props.call.roomId) ?? undefined,
            });
        }
        this.snapshot.merge({ openTileMenuId: tileId, activeMenu: null, participantMenu: this.participantMenu });
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

    /**
     * Plays each remote person as this user chose on this device. The engine rebuilds its controllers on every
     * change, so this only touches one whose volume differs, and settles once they match.
     */
    private applyUserPreferences(): void {
        for (const [userId, controllers] of this.participantVolumes) {
            const volume = VoiceUserPreferences.instance.effectiveVolume(userId);
            for (const controller of controllers) {
                if (Math.abs(controller.volume - volume) > 0.001) controller.setVolume(volume);
            }
        }
    }

    private readonly onUserPreferencesChanged = (): void => {
        if (this.isDisposed) return;
        this.applyUserPreferences();
        this.snapshot.merge({ participants: this.participantTiles() });
    };

    private readonly onCallParticipantsChanged = (): void => {
        if (this.isDisposed) return;
        this.snapshot.merge({
            lobbyParticipants: lobbyParticipants(this.props.client, this.props.call.participants.keys()),
        });
        // While joining, the people the call already lists stand in for the tiles Element Call has not reported.
        if (this.snapshot.current.phase === "joining") this.setBridge(this.bridge);
    };

    private participantMenu: VoiceUserMenuViewModel | null = null;

    private closeParticipantMenu(): void {
        this.participantMenu?.dispose();
        this.participantMenu = null;
    }

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

    public toggleFullscreen = (stageElement?: HTMLElement | null): void => {
        if (typeof document === "undefined") return;
        const ownerDocument = stageElement?.ownerDocument ?? document;
        if (ownerDocument.fullscreenElement) {
            void ownerDocument.exitFullscreen().catch(() => {});
        } else if (stageElement?.requestFullscreen) {
            void stageElement.requestFullscreen().catch(() => {});
        }
    };

    public renderAudioElement = (): ReactNode => {
        return this.bridge.state.renderAudioElement();
    };
}
