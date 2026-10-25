/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import type { ReactNode } from "react";

/** Call lifecycle phase emitted by the retained engine. */
export type AetherCallStagePhase = "lobby" | "joining" | "in_call" | "reconnecting" | "ended" | "error";

/** Media decryption state, including recoverable and critical key errors. */
export type AetherEncryptionStatus = "connecting" | "okay" | "key_missing" | "key_invalid" | "password_invalid";

/** Validated screen capture preferences and publication limits. */
export interface AetherScreenShareQualitySettings {
    /** Target vertical resolution in pixels (e.g. 720, 1080, 1440) or null for source/native resolution. */
    resolutionHeight: number | null;
    /** Target frame rate in fps (e.g. 15, 30, 60). */
    frameRate: number;
    /** Maximum encoding bitrate in bits/sec (e.g. 1_500_000, 3_000_000, 6_000_000), or null for policy default. */
    maxBitrate: number | null;
    /** Whether system/tab audio should be requested when starting screen share. */
    includeSystemAudio: boolean;
}

/** Deployment limits applied before capture is published. */
export interface AetherScreenSharePolicyLimits {
    maxResolutionHeight: number | null;
    maxFrameRate: number | null;
    maxBitrate: number | null;
}

/** Independent playback gain for one participant and one media source. */
export interface AetherMediaVolumeController {
    /** Current scalar playback volume (0..2, default 1). */
    readonly volume: number;
    /** Whether playback is muted for this specific media source. */
    readonly muted: boolean;
    /** Adjusts playback volume for this specific media source only. */
    setVolume(volume: number): void;
    /** Toggles mute for this specific media source only. */
    toggleMuted(): void;
}

/** Stable attachment operations for one engine track; consumers own only their DOM element. */
export interface AetherVideoAttachmentHandle {
    /** Attaches the underlying LiveKit / MediaStream video track to a DOM `<video>` element. */
    attach(element: HTMLVideoElement): void;
    /** Detaches the underlying video track from a DOM `<video>` element. */
    detach(element: HTMLVideoElement): void;
}

/** One call participant and their live microphone, camera and reaction state. */
export interface AetherParticipantMediaItem {
    readonly id: string;
    readonly userId: string;
    readonly displayName: string;
    readonly avatarMxcUrl?: string;
    readonly local: boolean;
    readonly speaking: boolean;
    readonly audioEnabled: boolean;
    readonly videoEnabled: boolean;
    readonly deafened: boolean;
    readonly mirror: boolean;
    readonly waitingForMedia: boolean;
    readonly unencryptedWarning: boolean;
    readonly encryptionStatus: AetherEncryptionStatus;
    readonly handRaisedAt: Date | null;
    readonly reactionEmoji: string | null;
    readonly video: AetherVideoAttachmentHandle | null;
    /**
     * Independent volume controls for this participant's microphone audio.
     * Null for the local user.
     */
    readonly microphoneVolume: AetherMediaVolumeController | null;
}

/** One screen publication and its independently controlled audio playback. */
export interface AetherScreenShareMediaItem {
    readonly id: string;
    readonly userId: string;
    readonly displayName: string;
    readonly avatarMxcUrl?: string;
    readonly local: boolean;
    readonly videoEnabled: boolean;
    readonly audioEnabled: boolean;
    readonly unencryptedWarning: boolean;
    readonly encryptionStatus: AetherEncryptionStatus;
    readonly video: AetherVideoAttachmentHandle | null;
    /**
     * Independent volume controls for this screen share's audio (`Track.Source.ScreenShareAudio`).
     * Separate from the sharer's microphone volume (`AetherParticipantMediaItem.microphoneVolume`)
     * and separate from global output/deafen. Null for the local user's own screen share.
     */
    readonly streamAudioVolume: AetherMediaVolumeController | null;
}

/** An engine error with its supported recovery action. */
export interface AetherCallFatalErrorInfo {
    readonly code: string;
    readonly title: string;
    readonly message: string;
    readonly canReconnect: boolean;
}

/** Engine state needed by the host presentation without exposing upstream UI. */
export interface AetherCallPresentationState {
    readonly phase: AetherCallStagePhase;
    readonly roomId: string;
    readonly roomName: string;
    readonly connected: boolean;
    readonly reconnecting: boolean;
    readonly participantCount: number;
    readonly localAudioEnabled: boolean;
    readonly localVideoEnabled: boolean;
    readonly sharingScreen: boolean;
    readonly canShareScreen: boolean;
    readonly keyRotationSuppressed: boolean;
    readonly encrypted: boolean;
    readonly fatalError: AetherCallFatalErrorInfo | null;
    readonly screenShareError: string | null;
    /** Device access is requested explicitly from the lobby. */
    readonly needsDevicePermissions: boolean;
    readonly permissionError: string | null;
    readonly supportsReactions: boolean;
    readonly ringing: "ringing" | "decline" | "timeout" | null;
    readonly participants: readonly AetherParticipantMediaItem[];
    readonly screenShares: readonly AetherScreenShareMediaItem[];
    readonly lobbyPreviewVideo: AetherVideoAttachmentHandle | null;
    readonly screenShareQuality: AetherScreenShareQualitySettings;
    readonly screenSharePolicyLimits: AetherScreenSharePolicyLimits;
    /**
     * Renders Element Call's existing `MatrixAudioRenderer` / `LivekitRoomAudioRenderer` instances,
     * preserving `validIdentities` membership filtering across multiple LiveKit rooms and global output/deafen.
     */
    readonly renderAudioElement: () => ReactNode;
}

/** Actions on the existing engine instance, including Matrix reactions and media controls. */
export interface AetherCallPresentationActions {
    joinCall(): void;
    returnToLobby(): void;
    requestDevicePermissions(): void;
    toggleRaisedHand(): Promise<void> | void;
    sendReaction(reaction: { emoji: string; name: string }): Promise<void> | void;
    leaveCall(): void;
    reconnect(): void;
    toggleLocalAudio(): void;
    toggleLocalVideo(): void;
    startScreenShare(quality?: Partial<AetherScreenShareQualitySettings>): Promise<void> | void;
    stopScreenShare(): Promise<void> | void;
    updateScreenShareQuality(quality: Partial<AetherScreenShareQualitySettings>): Promise<void> | void;
    dismissScreenShareError(): void;
}

/** State and actions passed from the engine into Aether presentation. */
export interface AetherCallPresentationBridge {
    readonly state: AetherCallPresentationState;
    readonly actions: AetherCallPresentationActions;
}
