/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Text } from "@vector-im/compound-web";
import {
    ChatSolidIcon,
    ChevronDownIcon,
    CollapseIcon,
    EndCallIcon,
    ErrorIcon,
    ExpandIcon,
    HeadphonesOffSolidIcon,
    LockIcon,
    LockOffIcon,
    MicOffIcon,
    MicOnIcon,
    OverflowHorizontalIcon,
    PopOutIcon,
    RaisedHandSolidIcon,
    ReactionSolidIcon,
    ShareScreenSolidIcon,
    UserAddSolidIcon,
    VideoCallOffSolidIcon,
    VideoCallSolidIcon,
    VolumeOffIcon,
    VolumeOnIcon,
} from "@vector-im/compound-design-tokens/assets/web/icons";

import { useViewModel, type ViewModel } from "../../core/viewmodel";
import { useI18n } from "../../core/i18n/i18nContext";
import styles from "./DesktopCallStageView.module.css";

/** Lifecycle phase displayed by the stage. */
export type DesktopCallStagePhase = "lobby" | "joining" | "in_call" | "reconnecting" | "ended" | "error";

/** Participant grid or a single focused media tile. */
export type DesktopCallStageLayoutMode = "grid" | "spotlight";

/** Decryption state reported by the retained media engine. */
export type DesktopCallStageEncryptionStatus =
    | "connecting"
    | "okay"
    | "key_missing"
    | "key_invalid"
    | "password_invalid";

/** Attaches a video track without owning or stopping the underlying capture. */
export interface DesktopCallStageVideoAttachment {
    attach(element: HTMLVideoElement): void;
    detach(element: HTMLVideoElement): void;
}

/** An available device and its current selection state. */
export interface DesktopCallStageDeviceOption {
    readonly id: string;
    readonly label: string;
    readonly selected: boolean;
}

/** Requested capture and publication limits for a screen share. */
export interface DesktopCallStageQualityState {
    readonly resolutionHeight: number | null;
    readonly frameRate: number;
    readonly maxBitrate: number | null;
    readonly includeSystemAudio: boolean;
}

/** Maximum screen media quality permitted by the deployment. */
export interface DesktopCallStagePolicyLimits {
    readonly maxResolutionHeight: number | null;
    readonly maxFrameRate: number | null;
    readonly maxBitrate: number | null;
}

/** A fatal engine error and whether its recovery action is supported. */
export interface DesktopCallStageFatalError {
    readonly code: string;
    readonly title: string;
    readonly message: string;
    readonly canReconnect: boolean;
}

/** Presentation data for one participant, including independent microphone playback. */
export interface DesktopCallStageParticipantTile {
    readonly id: string;
    readonly userId: string;
    readonly displayName: string;
    readonly avatarUrl?: string;
    readonly initialLetter: string;
    readonly local: boolean;
    readonly speaking: boolean;
    readonly audioEnabled: boolean;
    readonly videoEnabled: boolean;
    readonly deafened: boolean;
    readonly mirror: boolean;
    readonly waitingForMedia: boolean;
    readonly unencryptedWarning: boolean;
    readonly encryptionStatus: DesktopCallStageEncryptionStatus;
    readonly handRaisedAt: Date | null;
    readonly reactionEmoji: string | null;
    readonly video: DesktopCallStageVideoAttachment | null;
    readonly hasVolumeControl: boolean;
    readonly microphoneVolumePercent: number;
    readonly microphoneMuted: boolean;
}

/** Presentation data for one screen stream, including independent stream playback. */
export interface DesktopCallStageScreenShareTile {
    readonly id: string;
    readonly userId: string;
    readonly displayName: string;
    readonly avatarUrl?: string;
    readonly initialLetter: string;
    readonly local: boolean;
    readonly videoEnabled: boolean;
    readonly audioEnabled: boolean;
    readonly unencryptedWarning: boolean;
    readonly encryptionStatus: DesktopCallStageEncryptionStatus;
    readonly video: DesktopCallStageVideoAttachment | null;
    readonly hasStreamAudioVolumeControl: boolean;
    readonly streamAudioVolumePercent: number;
    readonly streamAudioMuted: boolean;
}

/** Complete immutable presentation state consumed by the desktop call view. */
export interface DesktopCallStageViewSnapshot {
    /** Conversation calls share the main column with the timeline; channels use the full stage. */
    readonly presentation: "conversation" | "channel";
    readonly phase: DesktopCallStagePhase;
    readonly roomName: string;
    readonly participantCount: number;
    readonly connected: boolean;
    readonly reconnecting: boolean;
    readonly encrypted: boolean;
    readonly keyRotationSuppressed: boolean;
    readonly localAudioEnabled: boolean;
    readonly localVideoEnabled: boolean;
    readonly localDeafened: boolean;
    readonly sharingScreen: boolean;
    readonly canShareScreen: boolean;
    readonly miniMode: boolean;
    readonly isFullscreen: boolean;
    readonly layoutMode: DesktopCallStageLayoutMode;
    readonly spotlightTileId: string | null;
    readonly activeMenu: "mic" | "camera" | "screenshare" | "reactions" | null;
    readonly openTileMenuId: string | null;
    readonly audioInputDevices: readonly DesktopCallStageDeviceOption[];
    readonly audioOutputDevices: readonly DesktopCallStageDeviceOption[];
    readonly videoInputDevices: readonly DesktopCallStageDeviceOption[];
    readonly participants: readonly DesktopCallStageParticipantTile[];
    readonly screenShares: readonly DesktopCallStageScreenShareTile[];
    readonly lobbyPreviewVideo: DesktopCallStageVideoAttachment | null;
    readonly screenShareQuality: DesktopCallStageQualityState;
    readonly screenSharePolicyLimits: DesktopCallStagePolicyLimits;
    readonly fatalError: DesktopCallStageFatalError | null;
    readonly screenShareError: string | null;
    readonly deviceError: string | null;
    readonly needsDevicePermissions: boolean;
    readonly permissionError: string | null;
    readonly supportsReactions: boolean;
    readonly localHandRaised: boolean;
    readonly ringing: "ringing" | "decline" | "timeout" | null;
    /** Electron's current display-media callback supplies a video track only. */
    readonly canShareSystemAudio: boolean;
}

/** User actions delegated to the existing call engine and desktop host. */
export interface DesktopCallStageViewActions {
    joinCall(): void;
    returnToLobby(): void;
    requestDevicePermissions(): void;
    toggleRaisedHand(): void;
    sendReaction(emoji: string): void;
    dismissDeviceError(): void;
    leaveCall(): void;
    reconnect(): void;
    toggleLocalAudio(): void;
    toggleLocalVideo(): void;
    toggleScreenShare(): void;
    startScreenShareWithQuality(quality: Partial<DesktopCallStageQualityState>): void;
    updateScreenShareQuality(quality: Partial<DesktopCallStageQualityState>): void;
    dismissScreenShareError(): void;
    selectAudioInput(deviceId: string): void;
    selectAudioOutput(deviceId: string): void;
    selectVideoInput(deviceId: string): void;
    setActiveMenu(menu: "mic" | "camera" | "screenshare" | "reactions" | null): void;
    setOpenTileMenuId(tileId: string | null): void;
    setSpotlightTileId(tileId: string | null): void;
    setLayoutMode(mode: DesktopCallStageLayoutMode): void;
    setParticipantMicrophoneVolume(tileId: string, volumePercent: number): void;
    toggleParticipantMicrophoneMuted(tileId: string): void;
    setScreenShareAudioVolume(tileId: string, volumePercent: number): void;
    toggleScreenShareAudioMuted(tileId: string): void;
    openInviteDialog(): void;
    showRoomChat(): void;
    popoutCall(): void;
    toggleFullscreen(stageElement?: HTMLElement | null): void;
    renderAudioElement(): ReactNode;
}

/** Observable desktop call presentation and its supported user actions. */
export type DesktopCallStageViewModel = ViewModel<DesktopCallStageViewSnapshot, DesktopCallStageViewActions>;

function AttachedVideo({
    attachment,
    mirror,
    testId,
}: {
    attachment: DesktopCallStageVideoAttachment;
    mirror?: boolean;
    testId: string;
}): JSX.Element {
    const videoRef = useRef<HTMLVideoElement | null>(null);
    useEffect(() => {
        const el = videoRef.current;
        if (!el) return;
        attachment.attach(el);
        return () => {
            attachment.detach(el);
        };
    }, [attachment]);
    return (
        <video
            ref={videoRef}
            className={styles.videoElement}
            data-mirror={mirror ? "true" : undefined}
            data-testid={testId}
            autoPlay
            playsInline
            muted
        />
    );
}

interface StagePopoverProps {
    anchor: RefObject<HTMLElement | null>;
    placement: "above" | "below-end";
    ariaLabel: string;
    testId?: string;
    className: string;
    onClose: () => void;
    children: ReactNode;
}

function StagePopover({
    anchor,
    placement,
    ariaLabel,
    testId,
    className,
    onClose,
    children,
}: StagePopoverProps): JSX.Element {
    const panelRef = useRef<HTMLDivElement | null>(null);
    const closeRef = useRef(onClose);
    closeRef.current = onClose;
    const [position, setPosition] = useState<{ left: number; top: number }>({ left: 12, top: 12 });

    useLayoutEffect(() => {
        const trigger = anchor.current;
        const updatePosition = (): void => {
            const panel = panelRef.current;
            if (!trigger || !panel) return;
            const rect = trigger.getBoundingClientRect();
            const { width, height } = panel.getBoundingClientRect();
            const gutter = 12;
            const rawLeft = placement === "above" ? rect.left + rect.width / 2 - width / 2 : rect.right - width;
            const rawTop = placement === "above" ? rect.top - height - 10 : rect.bottom + 8;
            setPosition({
                left: Math.max(gutter, Math.min(rawLeft, window.innerWidth - width - gutter)),
                top: Math.max(gutter, Math.min(rawTop, window.innerHeight - height - gutter)),
            });
        };
        updatePosition();
        const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(updatePosition);
        if (panelRef.current) observer?.observe(panelRef.current);
        window.addEventListener("resize", updatePosition);
        window.addEventListener("scroll", updatePosition, true);
        const element = panelRef.current;
        let returnFocus = true;
        element?.focus();

        const onPointerDown = (event: PointerEvent): void => {
            const target = event.target;
            if (target instanceof Node && !panelRef.current?.contains(target) && !trigger?.contains(target)) {
                returnFocus = false;
                closeRef.current();
            }
        };
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            closeRef.current();
            trigger?.focus();
        };
        document.addEventListener("pointerdown", onPointerDown);
        document.addEventListener("keydown", onKeyDown, true);
        return () => {
            observer?.disconnect();
            window.removeEventListener("resize", updatePosition);
            window.removeEventListener("scroll", updatePosition, true);
            document.removeEventListener("pointerdown", onPointerDown);
            document.removeEventListener("keydown", onKeyDown, true);
            if (returnFocus && element?.contains(document.activeElement)) {
                trigger?.focus();
            }
        };
    }, [anchor, placement]);

    const portalRoot =
        typeof document !== "undefined" && document.fullscreenElement instanceof HTMLElement
            ? document.fullscreenElement
            : typeof document !== "undefined"
              ? document.body
              : null;

    const content = (
        <div
            ref={panelRef}
            role="dialog"
            aria-label={ariaLabel}
            data-testid={testId}
            tabIndex={-1}
            className={className}
            style={{ position: "fixed", left: position.left, top: position.top }}
        >
            {children}
        </div>
    );

    return portalRoot ? createPortal(content, portalRoot) : content;
}

const FPS_OPTIONS: readonly number[] = [15, 30, 60];

interface DesktopCallStageViewProps {
    /** Observes the retained call and executes its actions. */
    vm: DesktopCallStageViewModel;
}

/** Aether call presentation. Media capture, publication and playback remain owned by the call engine. */
export function DesktopCallStageView({ vm }: DesktopCallStageViewProps): JSX.Element {
    const { translate: _t } = useI18n();
    const snapshot = useViewModel(vm);
    const stageRef = useRef<HTMLDivElement | null>(null);
    const cameraMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
    const screenShareMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
    const reactionsMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
    const micMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
    const tileMenuTriggerRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
    const tileMenuAnchors = useRef<Map<string, RefObject<HTMLElement | null>>>(new Map());
    const [hoveredTileId, setHoveredTileId] = useState<string | null>(null);

    const validValues = (values: readonly (number | null)[]): number[] =>
        [
            ...new Set(
                values.filter(
                    (value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0,
                ),
            ),
        ].sort((a, b) => a - b);
    const resolutionOptions = [
        ...validValues([
            720,
            1080,
            1440,
            snapshot.screenShareQuality.resolutionHeight,
            snapshot.screenSharePolicyLimits.maxResolutionHeight,
        ]).map((height) => ({ key: `${height}p`, label: `${height}p`, value: height as number | null })),
        { key: "Source", label: _t("desktop|call_stage|resolution_source"), value: null },
    ];
    const frameRateOptions = validValues([
        ...FPS_OPTIONS,
        snapshot.screenShareQuality.frameRate,
        snapshot.screenSharePolicyLimits.maxFrameRate,
    ]);
    const bitrateOptions = [
        { key: "Auto", label: _t("desktop|call_stage|bitrate_auto"), value: null as number | null },
        ...validValues([
            1_500_000,
            3_500_000,
            6_000_000,
            snapshot.screenShareQuality.maxBitrate,
            snapshot.screenSharePolicyLimits.maxBitrate,
        ]).map((bitrate) => ({
            key: String(bitrate),
            label: bitrate >= 1_000_000 ? `${bitrate / 1_000_000} Mbps` : `${bitrate / 1000} kbps`,
            value: bitrate as number | null,
        })),
    ];

    const renderEncryptionStatusBadge = (
        userId: string,
        unencryptedWarning: boolean,
        encryptionStatus: DesktopCallStageEncryptionStatus,
    ): JSX.Element | null => {
        if (unencryptedWarning) {
            const label = _t("desktop|call_stage|unencrypted_media_warning");
            return (
                <span
                    className={styles.statusIconBadge}
                    data-tone="warning"
                    data-testid={`encryption-badge-${userId}`}
                    title={label}
                    aria-label={label}
                >
                    <LockOffIcon />
                </span>
            );
        }
        if (encryptionStatus === "key_missing") {
            const label = _t("desktop|call_stage|encryption_key_missing");
            return (
                <span
                    className={styles.statusIconBadge}
                    data-tone="warning"
                    data-testid={`encryption-badge-${userId}`}
                    title={label}
                    aria-label={label}
                >
                    <LockOffIcon />
                </span>
            );
        }
        if (encryptionStatus === "key_invalid" || encryptionStatus === "password_invalid") {
            const label = _t("desktop|call_stage|encryption_key_invalid");
            return (
                <span
                    className={styles.statusIconBadge}
                    data-tone="critical"
                    data-testid={`encryption-badge-${userId}`}
                    title={label}
                    aria-label={label}
                >
                    <ErrorIcon />
                </span>
            );
        }
        if (encryptionStatus === "connecting") {
            const label = _t("desktop|call_stage|encryption_connecting");
            return (
                <span
                    className={styles.statusIconBadge}
                    data-tone="neutral"
                    data-testid={`encryption-badge-${userId}`}
                    title={label}
                    aria-label={label}
                >
                    <LockIcon />
                </span>
            );
        }
        return null;
    };

    const getTileTriggerRef = (tileId: string): RefObject<HTMLElement | null> => {
        let anchor = tileMenuAnchors.current.get(tileId);
        if (!anchor) {
            // Keep the popover effect mounted while playback volume snapshots change.
            anchor = {
                get current(): HTMLElement | null {
                    return tileMenuTriggerRefs.current.get(tileId) ?? stageRef.current;
                },
            };
            tileMenuAnchors.current.set(tileId, anchor);
        }
        return anchor;
    };

    const renderScreenShareTile = (tile: DesktopCallStageScreenShareTile, isSpotlight: boolean): JSX.Element => {
        const isMenuOpen = snapshot.openTileMenuId === tile.id;
        const qualityLabel = snapshot.screenShareQuality.resolutionHeight
            ? `${snapshot.screenShareQuality.resolutionHeight}p ${snapshot.screenShareQuality.frameRate}fps`
            : `${snapshot.screenShareQuality.frameRate}fps`;
        return (
            <div
                key={tile.id}
                className={styles.tile}
                data-kind="screen_share"
                data-screenshare-id={tile.userId}
                data-testid={`call-tile-screenshare-${tile.userId}`}
                onMouseEnter={() => setHoveredTileId(tile.id)}
                onMouseLeave={() => setHoveredTileId((prev) => (prev === tile.id ? null : prev))}
            >
                <button
                    type="button"
                    className={styles.tileClickSurface}
                    aria-label={_t("desktop|call_stage|stream_tile_aria", { name: tile.displayName })}
                    onClick={() => vm.setSpotlightTileId(isSpotlight ? null : tile.id)}
                    onContextMenu={(e) => {
                        if (tile.hasStreamAudioVolumeControl) {
                            e.preventDefault();
                            vm.setOpenTileMenuId(isMenuOpen ? null : tile.id);
                        }
                    }}
                />
                {tile.video && tile.videoEnabled ? (
                    <AttachedVideo attachment={tile.video} testId={`screenshare-video-${tile.userId}`} />
                ) : (
                    <div className={styles.avatarFallback}>
                        <div className={styles.avatarCircle}>
                            <ShareScreenSolidIcon />
                        </div>
                        <Text size="sm" weight="medium">
                            {tile.local
                                ? _t("desktop|call_stage|your_stream_watching")
                                : _t("desktop|call_stage|stream_of_user", { name: tile.displayName })}
                        </Text>
                    </div>
                )}
                <div className={styles.tileTopBar}>
                    <div className={styles.tileBadgeGroup}>
                        <span className={styles.liveBadge}>{_t("desktop|call_stage|live_badge")}</span>
                        {tile.local && <span className={styles.qualityBadge}>{qualityLabel}</span>}
                    </div>
                    <div className={styles.tileActions}>
                        {tile.hasStreamAudioVolumeControl && (
                            <>
                                <button
                                    type="button"
                                    className={styles.tileActionBtn}
                                    aria-label={
                                        tile.streamAudioMuted
                                            ? _t("desktop|call_stage|unmute_stream_audio", { name: tile.displayName })
                                            : _t("desktop|call_stage|mute_stream_audio", { name: tile.displayName })
                                    }
                                    data-testid={`screenshare-audio-mute-${tile.userId}`}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        vm.toggleScreenShareAudioMuted(tile.id);
                                    }}
                                >
                                    {tile.streamAudioMuted || tile.streamAudioVolumePercent === 0 ? (
                                        <VolumeOffIcon />
                                    ) : (
                                        <VolumeOnIcon />
                                    )}
                                </button>
                                <button
                                    ref={(el) => {
                                        if (el) tileMenuTriggerRefs.current.set(tile.id, el);
                                        else tileMenuTriggerRefs.current.delete(tile.id);
                                    }}
                                    type="button"
                                    className={styles.tileActionBtn}
                                    aria-label={_t("desktop|call_stage|stream_volume_options", {
                                        name: tile.displayName,
                                    })}
                                    aria-expanded={isMenuOpen}
                                    data-testid={`screenshare-volume-menu-btn-${tile.userId}`}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        vm.setOpenTileMenuId(isMenuOpen ? null : tile.id);
                                    }}
                                >
                                    <OverflowHorizontalIcon />
                                </button>
                            </>
                        )}
                        <button
                            type="button"
                            className={styles.tileActionBtn}
                            aria-label={
                                isSpotlight
                                    ? _t("desktop|call_stage|restore_grid")
                                    : _t("desktop|call_stage|expand_stream")
                            }
                            onClick={(e) => {
                                e.stopPropagation();
                                vm.setSpotlightTileId(isSpotlight ? null : tile.id);
                            }}
                        >
                            {isSpotlight ? <CollapseIcon /> : <ExpandIcon />}
                        </button>
                    </div>
                </div>
                {isMenuOpen && tile.hasStreamAudioVolumeControl && (
                    <StagePopover
                        anchor={getTileTriggerRef(tile.id)}
                        placement="below-end"
                        ariaLabel={_t("desktop|call_stage|stream_volume_options", { name: tile.displayName })}
                        testId={`screenshare-volume-popover-${tile.userId}`}
                        className={styles.tileVolumePopover}
                        onClose={() => vm.setOpenTileMenuId(null)}
                    >
                        <div className={styles.volumeRow}>
                            <Text size="xs" weight="semibold">
                                {_t("desktop|call_stage|stream_volume_title")}
                            </Text>
                            <Text size="xs">{tile.streamAudioMuted ? "0%" : `${tile.streamAudioVolumePercent}%`}</Text>
                        </div>
                        <div className={styles.volumeSliderRow}>
                            <button
                                type="button"
                                className={styles.tileActionBtn}
                                aria-label={
                                    tile.streamAudioMuted
                                        ? _t("desktop|call_stage|unmute_stream_audio", { name: tile.displayName })
                                        : _t("desktop|call_stage|mute_stream_audio", { name: tile.displayName })
                                }
                                onClick={() => vm.toggleScreenShareAudioMuted(tile.id)}
                            >
                                {tile.streamAudioMuted || tile.streamAudioVolumePercent === 0 ? (
                                    <VolumeOffIcon />
                                ) : (
                                    <VolumeOnIcon />
                                )}
                            </button>
                            <input
                                type="range"
                                min={0}
                                max={100}
                                step={1}
                                value={tile.streamAudioMuted ? 0 : tile.streamAudioVolumePercent}
                                aria-label={_t("desktop|call_stage|stream_volume_slider_aria", {
                                    name: tile.displayName,
                                })}
                                data-testid={`screenshare-volume-slider-${tile.userId}`}
                                className={styles.volumeSlider}
                                onChange={(e) => vm.setScreenShareAudioVolume(tile.id, Number(e.target.value))}
                            />
                        </div>
                    </StagePopover>
                )}
                <div className={styles.tileBottomBar}>
                    <div className={styles.nameBadge}>
                        <ShareScreenSolidIcon width={14} height={14} />
                        <span className={styles.nameBadgeText}>
                            {tile.local
                                ? _t("desktop|call_stage|your_stream_suffix", { name: tile.displayName })
                                : tile.displayName}
                        </span>
                    </div>
                    <div className={styles.statusIcons}>
                        {renderEncryptionStatusBadge(tile.userId, tile.unencryptedWarning, tile.encryptionStatus)}
                    </div>
                </div>
            </div>
        );
    };

    const renderParticipantTile = (tile: DesktopCallStageParticipantTile, isSpotlight: boolean): JSX.Element => {
        const isMenuOpen = snapshot.openTileMenuId === tile.id;
        return (
            <div
                key={tile.id}
                className={styles.tile}
                data-kind="participant"
                data-video={tile.videoEnabled ? "true" : undefined}
                data-participant-id={tile.userId}
                data-speaking={tile.speaking ? "true" : undefined}
                data-testid="videoTile"
                onMouseEnter={() => setHoveredTileId(tile.id)}
                onMouseLeave={() => setHoveredTileId((prev) => (prev === tile.id ? null : prev))}
            >
                <button
                    type="button"
                    className={styles.tileClickSurface}
                    aria-label={_t("desktop|call_stage|participant_tile_aria", { name: tile.displayName })}
                    onClick={() => vm.setSpotlightTileId(isSpotlight ? null : tile.id)}
                    onContextMenu={(e) => {
                        if (tile.hasVolumeControl) {
                            e.preventDefault();
                            vm.setOpenTileMenuId(isMenuOpen ? null : tile.id);
                        }
                    }}
                />
                {tile.video && tile.videoEnabled ? (
                    <AttachedVideo
                        attachment={tile.video}
                        mirror={tile.mirror}
                        testId={`participant-video-${tile.userId}`}
                    />
                ) : (
                    <div className={styles.avatarFallback}>
                        <div className={styles.avatarCircle}>
                            {tile.avatarUrl ? (
                                <img src={tile.avatarUrl} alt={tile.displayName} className={styles.avatarImage} />
                            ) : (
                                <span>{tile.initialLetter}</span>
                            )}
                        </div>
                        {tile.waitingForMedia && (
                            <Text size="xs" className={styles.waitingLabel}>
                                {_t("desktop|call_stage|waiting_for_media")}
                            </Text>
                        )}
                    </div>
                )}
                <div className={styles.tileTopBar}>
                    <div />
                    <div className={styles.tileActions}>
                        {tile.hasVolumeControl && (
                            <button
                                ref={(el) => {
                                    if (el) tileMenuTriggerRefs.current.set(tile.id, el);
                                    else tileMenuTriggerRefs.current.delete(tile.id);
                                }}
                                type="button"
                                className={styles.tileActionBtn}
                                aria-label={_t("desktop|call_stage|participant_audio_options", {
                                    name: tile.displayName,
                                })}
                                aria-expanded={isMenuOpen}
                                data-testid={`participant-volume-menu-btn-${tile.userId}`}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    vm.setOpenTileMenuId(isMenuOpen ? null : tile.id);
                                }}
                            >
                                <OverflowHorizontalIcon />
                            </button>
                        )}
                    </div>
                </div>
                {isMenuOpen && tile.hasVolumeControl && (
                    <StagePopover
                        anchor={getTileTriggerRef(tile.id)}
                        placement="below-end"
                        ariaLabel={_t("desktop|call_stage|participant_audio_options", { name: tile.displayName })}
                        testId={`participant-volume-popover-${tile.userId}`}
                        className={styles.tileVolumePopover}
                        onClose={() => vm.setOpenTileMenuId(null)}
                    >
                        <div className={styles.volumeRow}>
                            <Text size="xs" weight="semibold">
                                {_t("desktop|call_stage|user_volume_title")}
                            </Text>
                            <Text size="xs">{tile.microphoneMuted ? "0%" : `${tile.microphoneVolumePercent}%`}</Text>
                        </div>
                        <div className={styles.volumeSliderRow}>
                            <button
                                type="button"
                                className={styles.tileActionBtn}
                                aria-label={
                                    tile.microphoneMuted
                                        ? _t("desktop|call_stage|unmute_participant", { name: tile.displayName })
                                        : _t("desktop|call_stage|mute_participant", { name: tile.displayName })
                                }
                                data-testid={`participant-audio-mute-${tile.userId}`}
                                onClick={() => vm.toggleParticipantMicrophoneMuted(tile.id)}
                            >
                                {tile.microphoneMuted || tile.microphoneVolumePercent === 0 ? (
                                    <VolumeOffIcon />
                                ) : (
                                    <VolumeOnIcon />
                                )}
                            </button>
                            <input
                                type="range"
                                min={0}
                                max={100}
                                step={1}
                                value={tile.microphoneMuted ? 0 : tile.microphoneVolumePercent}
                                aria-label={_t("desktop|call_stage|participant_volume_slider_aria", {
                                    name: tile.displayName,
                                })}
                                data-testid={`participant-volume-slider-${tile.userId}`}
                                className={styles.volumeSlider}
                                onChange={(e) => vm.setParticipantMicrophoneVolume(tile.id, Number(e.target.value))}
                            />
                        </div>
                    </StagePopover>
                )}
                <div className={styles.tileBottomBar}>
                    <div className={styles.nameBadge} data-testid="name_tag">
                        <span className={styles.nameBadgeText}>{tile.displayName}</span>
                        {tile.reactionEmoji && <span>{tile.reactionEmoji}</span>}
                        {tile.handRaisedAt && (
                            <span
                                title={_t("desktop|call_stage|hand_raised")}
                                aria-label={_t("desktop|call_stage|hand_raised")}
                            >
                                🖐️
                            </span>
                        )}
                    </div>
                    <div className={styles.statusIcons}>
                        {!tile.audioEnabled && (
                            <span
                                className={styles.statusIconBadge}
                                title={_t("desktop|call_stage|mic_muted_badge")}
                                aria-label={_t("desktop|call_stage|mic_muted_badge")}
                            >
                                <MicOffIcon />
                            </span>
                        )}
                        {tile.deafened && (
                            <span
                                className={styles.statusIconBadge}
                                title={_t("desktop|call_stage|deafened_badge")}
                                aria-label={_t("desktop|call_stage|deafened_badge")}
                            >
                                <HeadphonesOffSolidIcon />
                            </span>
                        )}
                        {renderEncryptionStatusBadge(tile.userId, tile.unencryptedWarning, tile.encryptionStatus)}
                    </div>
                </div>
            </div>
        );
    };

    const allScreenShares = snapshot.screenShares;
    const allParticipants = snapshot.participants;
    const effectiveSpotlightId =
        snapshot.spotlightTileId ?? (allScreenShares.length > 0 ? allScreenShares[0].id : null);
    const spotlightShare = allScreenShares.find((s) => s.id === effectiveSpotlightId) ?? null;
    const spotlightParticipant =
        spotlightShare === null ? (allParticipants.find((p) => p.id === effectiveSpotlightId) ?? null) : null;
    const hasSpotlight =
        snapshot.layoutMode === "spotlight" && (spotlightShare !== null || spotlightParticipant !== null);

    return (
        <div
            ref={stageRef}
            className={styles.stage}
            data-presentation={snapshot.presentation}
            data-audio-only={
                allScreenShares.length === 0 && !allParticipants.some((p) => p.videoEnabled) ? "true" : undefined
            }
            data-mini={snapshot.miniMode ? "true" : undefined}
            data-phase={snapshot.phase}
            data-hovered-tile={hoveredTileId ?? undefined}
            data-testid="aether-call-stage"
        >
            {/* Preserve MatrixAudioRenderer + Ringing audio (validIdentities filtering, multiple rooms, global deafen/output) */}
            {vm.renderAudioElement()}

            {/* Top Header */}
            <header className={styles.header}>
                <div className={styles.headerIdentity}>
                    <div className={styles.headerBadges}>
                        {snapshot.reconnecting ? (
                            <span className={styles.statusPill} data-tone="warning" role="status">
                                {_t("desktop|call_stage|reconnecting")}
                            </span>
                        ) : snapshot.connected ? (
                            <span className={styles.statusPill} data-tone="success" role="status">
                                {_t("desktop|call_stage|voice_connected")}
                            </span>
                        ) : (
                            <span className={styles.statusPill} role="status">
                                {snapshot.phase === "lobby"
                                    ? _t("desktop|call_stage|ready_to_join")
                                    : _t("desktop|call_stage|connecting")}
                            </span>
                        )}
                        {snapshot.encrypted && (
                            <span className={styles.statusPill} title={_t("desktop|call_stage|e2ee_tooltip")}>
                                <LockIcon width={12} height={12} /> {_t("desktop|call_stage|e2ee_badge")}
                            </span>
                        )}
                        {snapshot.keyRotationSuppressed && (
                            <span
                                className={styles.statusPill}
                                data-tone="warning"
                                data-testid="call-key-rotation-suppressed"
                                title={_t("desktop|call_stage|key_rotation_paused_tooltip")}
                            >
                                {_t("desktop|call_stage|key_rotation_paused")}
                            </span>
                        )}
                    </div>
                </div>
                <div className={styles.headerActions}>
                    {(allScreenShares.length > 0 || effectiveSpotlightId !== null) && (
                        <button
                            type="button"
                            className={styles.headerButton}
                            onClick={() => vm.setLayoutMode(snapshot.layoutMode === "spotlight" ? "grid" : "spotlight")}
                        >
                            {snapshot.layoutMode === "spotlight"
                                ? _t("desktop|call_stage|grid_view")
                                : _t("desktop|call_stage|focus_view")}
                        </button>
                    )}
                    <button
                        type="button"
                        className={styles.headerButton}
                        aria-label={_t("desktop|call_stage|invite_aria")}
                        onClick={vm.openInviteDialog}
                    >
                        <UserAddSolidIcon />
                        <span>{_t("desktop|call_stage|invite")}</span>
                    </button>
                    <button
                        type="button"
                        className={styles.headerButton}
                        aria-label={_t("desktop|call_stage|show_chat")}
                        onClick={vm.showRoomChat}
                    >
                        <ChatSolidIcon />
                        <span>{_t("desktop|call_stage|show_chat")}</span>
                    </button>
                </div>
            </header>

            {snapshot.deviceError && (
                <div className={styles.banner} role="alert">
                    <Text size="sm">
                        {_t("desktop|call_stage|device_change_error", { message: snapshot.deviceError })}
                    </Text>
                    <button type="button" className={styles.bannerDismiss} onClick={vm.dismissDeviceError}>
                        {_t("desktop|call_stage|dismiss")}
                    </button>
                </div>
            )}
            {snapshot.permissionError && (
                <div className={styles.banner} role="alert">
                    <Text size="sm">
                        {_t("desktop|call_stage|device_permission_error", { message: snapshot.permissionError })}
                    </Text>
                </div>
            )}
            {snapshot.ringing && (
                <div className={styles.callingStatus} role="status">
                    <Text size="sm">{_t("desktop|call_stage|calling")}</Text>
                </div>
            )}
            {/* Screen Share Error Banner */}
            {snapshot.screenShareError && (
                <div className={styles.banner} role="alert" data-testid="call-screenshare-error-banner">
                    <div className={styles.bannerContent}>
                        <ErrorIcon width={18} height={18} />
                        <Text size="sm">
                            {_t("desktop|call_stage|screenshare_error", { error: snapshot.screenShareError })}
                        </Text>
                    </div>
                    <button type="button" className={styles.bannerDismiss} onClick={vm.dismissScreenShareError}>
                        {_t("desktop|call_stage|dismiss")}
                    </button>
                </div>
            )}

            {/* Main Stage Canvas */}
            <div className={styles.canvas}>
                {snapshot.fatalError ? (
                    <div className={styles.errorCard} role="alert" data-testid="call-fatal-error-card">
                        <ErrorIcon width={36} height={36} />
                        <Text as="h3" size="lg" weight="semibold">
                            {snapshot.fatalError.title || _t("desktop|call_stage|call_error")}
                        </Text>
                        <Text size="sm">{snapshot.fatalError.message}</Text>
                        <div className={styles.errorActionRow}>
                            {snapshot.fatalError.canReconnect && (
                                <button type="button" className={styles.primaryActionBtn} onClick={vm.reconnect}>
                                    {_t("desktop|call_stage|retry")}
                                </button>
                            )}
                            <button type="button" className={styles.headerButton} onClick={vm.leaveCall}>
                                {_t("desktop|call_stage|leave_call")}
                            </button>
                        </div>
                    </div>
                ) : snapshot.phase === "ended" ? (
                    <div className={styles.lobbyCard}>
                        <Text as="h3" size="lg">
                            {_t("desktop|call_stage|call_ended")}
                        </Text>
                        <button type="button" className={styles.primaryActionBtn} onClick={vm.returnToLobby}>
                            {_t("desktop|call_stage|return_to_lobby")}
                        </button>
                    </div>
                ) : snapshot.phase === "lobby" ? (
                    <div className={styles.lobbyCard} data-testid="call-lobby-card">
                        {snapshot.localVideoEnabled && (
                            <div className={styles.lobbyPreviewBox}>
                                {snapshot.lobbyPreviewVideo && snapshot.localVideoEnabled ? (
                                    <AttachedVideo
                                        attachment={snapshot.lobbyPreviewVideo}
                                        mirror={true}
                                        testId="lobby-preview-video"
                                    />
                                ) : (
                                    <div className={styles.avatarFallback}>
                                        <div className={styles.avatarCircle}>
                                            <VolumeOnIcon />
                                        </div>
                                        <Text size="sm">{_t("desktop|call_stage|camera_off")}</Text>
                                    </div>
                                )}
                            </div>
                        )}
                        <Text as="h3" size="lg" weight="semibold">
                            {snapshot.roomName}
                        </Text>
                        <Text size="sm">
                            {snapshot.participantCount > 0
                                ? _t("desktop|call_stage|lobby_participants", { count: snapshot.participantCount })
                                : _t("desktop|call_stage|lobby_empty")}
                        </Text>
                        {snapshot.needsDevicePermissions && (
                            <button type="button" className={styles.headerButton} onClick={vm.requestDevicePermissions}>
                                {_t("desktop|call_stage|allow_devices")}
                            </button>
                        )}
                        <button
                            type="button"
                            className={styles.primaryActionBtn}
                            data-testid="lobby_joinCall"
                            onClick={vm.joinCall}
                        >
                            {_t("desktop|call_stage|join_voice_call")}
                        </button>
                    </div>
                ) : hasSpotlight ? (
                    <>
                        <div className={styles.spotlightArea}>
                            {spotlightShare
                                ? renderScreenShareTile(spotlightShare, true)
                                : spotlightParticipant
                                  ? renderParticipantTile(spotlightParticipant, true)
                                  : null}
                        </div>
                        {allScreenShares.length + allParticipants.length > 1 && (
                            <div className={styles.filmstrip}>
                                {allScreenShares
                                    .filter((s) => s.id !== effectiveSpotlightId)
                                    .map((s) => renderScreenShareTile(s, false))}
                                {allParticipants
                                    .filter((p) => p.id !== effectiveSpotlightId)
                                    .map((p) => renderParticipantTile(p, false))}
                            </div>
                        )}
                    </>
                ) : (
                    <div
                        className={styles.grid}
                        data-count={String(Math.min(4, allScreenShares.length + allParticipants.length))}
                        data-solo-channel={
                            snapshot.presentation === "channel" &&
                            allParticipants.length === 1 &&
                            allScreenShares.length === 0
                                ? "true"
                                : undefined
                        }
                    >
                        {allScreenShares.map((s) => renderScreenShareTile(s, false))}
                        {allParticipants.map((p) => renderParticipantTile(p, false))}
                        {snapshot.presentation === "channel" &&
                            allParticipants.length === 1 &&
                            allScreenShares.length === 0 && (
                                <div className={styles.inviteTile}>
                                    <UserAddSolidIcon width={56} height={56} aria-hidden="true" />
                                    <Text size="lg" weight="semibold">
                                        {_t("desktop|call_stage|lobby_empty")}
                                    </Text>
                                    <button type="button" className={styles.headerButton} onClick={vm.openInviteDialog}>
                                        <UserAddSolidIcon />
                                        {_t("desktop|call_stage|invite_friends_chip")}
                                    </button>
                                </div>
                            )}
                    </div>
                )}
            </div>

            {/* Bottom Control Bar */}
            {snapshot.phase !== "lobby" && snapshot.phase !== "ended" && (
                <div className={styles.bottomBar}>
                    <div className={styles.centerControls}>
                        {/* Microphone control + audio input/output device picker */}
                        <div className={styles.controlPillGroup}>
                            <button
                                type="button"
                                className={styles.controlButton}
                                aria-label={
                                    snapshot.localAudioEnabled
                                        ? _t("desktop|call_stage|mute_microphone")
                                        : _t("desktop|call_stage|unmute_microphone")
                                }
                                aria-pressed={!snapshot.localAudioEnabled}
                                data-muted={!snapshot.localAudioEnabled ? "true" : undefined}
                                data-testid="call-control-mic"
                                onClick={vm.toggleLocalAudio}
                            >
                                {snapshot.localAudioEnabled ? <MicOnIcon /> : <MicOffIcon />}
                            </button>
                            <button
                                ref={micMenuTriggerRef}
                                type="button"
                                className={styles.chevronButton}
                                aria-label={_t("desktop|call_stage|more_microphone_options")}
                                aria-expanded={snapshot.activeMenu === "mic"}
                                data-testid="call-control-mic-menu"
                                onClick={() => vm.setActiveMenu(snapshot.activeMenu === "mic" ? null : "mic")}
                            >
                                <ChevronDownIcon />
                            </button>
                            {snapshot.activeMenu === "mic" && (
                                <StagePopover
                                    anchor={micMenuTriggerRef}
                                    placement="above"
                                    ariaLabel={_t("desktop|call_stage|input_device_title")}
                                    testId="call-audio-devices-popover"
                                    className={styles.menuPopover}
                                    onClose={() => vm.setActiveMenu(null)}
                                >
                                    <p className={styles.menuSectionTitle}>
                                        {_t("desktop|call_stage|input_device_title")}
                                    </p>
                                    <div className={styles.menuList}>
                                        {snapshot.audioInputDevices.map((device) => (
                                            <button
                                                key={device.id}
                                                type="button"
                                                role="menuitemradio"
                                                aria-checked={device.selected}
                                                className={styles.menuItem}
                                                onClick={() => {
                                                    vm.selectAudioInput(device.id);
                                                    vm.setActiveMenu(null);
                                                }}
                                            >
                                                <span>{device.label}</span>
                                                {device.selected && <span>✓</span>}
                                            </button>
                                        ))}
                                    </div>
                                    {snapshot.audioOutputDevices.length > 0 && (
                                        <>
                                            <p className={styles.menuSectionTitle}>
                                                {_t("desktop|call_stage|output_device_title")}
                                            </p>
                                            <div className={styles.menuList}>
                                                {snapshot.audioOutputDevices.map((device) => (
                                                    <button
                                                        key={device.id}
                                                        type="button"
                                                        role="menuitemradio"
                                                        aria-checked={device.selected}
                                                        className={styles.menuItem}
                                                        onClick={() => {
                                                            vm.selectAudioOutput(device.id);
                                                            vm.setActiveMenu(null);
                                                        }}
                                                    >
                                                        <span>{device.label}</span>
                                                        {device.selected && <span>✓</span>}
                                                    </button>
                                                ))}
                                            </div>
                                        </>
                                    )}
                                </StagePopover>
                            )}
                        </div>

                        {/* Camera control + device picker */}
                        <div className={styles.controlPillGroup}>
                            <button
                                type="button"
                                className={styles.controlButton}
                                aria-label={
                                    snapshot.localVideoEnabled
                                        ? _t("desktop|call_stage|turn_off_camera")
                                        : _t("desktop|call_stage|turn_on_camera")
                                }
                                aria-pressed={snapshot.localVideoEnabled}
                                data-active={snapshot.localVideoEnabled ? "true" : undefined}
                                data-testid="call-control-camera"
                                onClick={vm.toggleLocalVideo}
                            >
                                {snapshot.localVideoEnabled ? <VideoCallSolidIcon /> : <VideoCallOffSolidIcon />}
                            </button>
                            <button
                                ref={cameraMenuTriggerRef}
                                type="button"
                                className={styles.chevronButton}
                                aria-label={_t("desktop|call_stage|more_camera_options")}
                                aria-expanded={snapshot.activeMenu === "camera"}
                                data-testid="call-control-camera-menu"
                                onClick={() => vm.setActiveMenu(snapshot.activeMenu === "camera" ? null : "camera")}
                            >
                                <ChevronDownIcon />
                            </button>
                            {snapshot.activeMenu === "camera" && (
                                <StagePopover
                                    anchor={cameraMenuTriggerRef}
                                    placement="above"
                                    ariaLabel={_t("desktop|call_stage|camera_devices_title")}
                                    testId="call-camera-devices-popover"
                                    className={styles.menuPopover}
                                    onClose={() => vm.setActiveMenu(null)}
                                >
                                    <p className={styles.menuSectionTitle}>
                                        {_t("desktop|call_stage|camera_devices_title")}
                                    </p>
                                    <div className={styles.menuList}>
                                        {snapshot.videoInputDevices.length === 0 ? (
                                            <Text size="xs">{_t("desktop|call_stage|no_camera_found")}</Text>
                                        ) : (
                                            snapshot.videoInputDevices.map((device) => (
                                                <button
                                                    key={device.id}
                                                    type="button"
                                                    role="menuitemradio"
                                                    aria-checked={device.selected}
                                                    className={styles.menuItem}
                                                    onClick={() => {
                                                        vm.selectVideoInput(device.id);
                                                        vm.setActiveMenu(null);
                                                    }}
                                                >
                                                    <span>{device.label}</span>
                                                    {device.selected && <span>✓</span>}
                                                </button>
                                            ))
                                        )}
                                    </div>
                                </StagePopover>
                            )}
                        </div>

                        {/* Screen Share control + quality/audio settings */}
                        {snapshot.canShareScreen && (
                            <div className={styles.controlPillGroup}>
                                <button
                                    type="button"
                                    className={styles.controlButton}
                                    aria-label={
                                        snapshot.sharingScreen
                                            ? _t("desktop|call_stage|stop_sharing")
                                            : _t("desktop|call_stage|share_your_screen")
                                    }
                                    aria-pressed={snapshot.sharingScreen}
                                    data-active={snapshot.sharingScreen ? "true" : undefined}
                                    data-testid="call-control-screenshare"
                                    onClick={vm.toggleScreenShare}
                                >
                                    <ShareScreenSolidIcon />
                                </button>
                                <button
                                    ref={screenShareMenuTriggerRef}
                                    type="button"
                                    className={styles.chevronButton}
                                    aria-label={_t("desktop|call_stage|stream_quality_settings")}
                                    aria-expanded={snapshot.activeMenu === "screenshare"}
                                    data-testid="call-control-screenshare-menu"
                                    onClick={() =>
                                        vm.setActiveMenu(snapshot.activeMenu === "screenshare" ? null : "screenshare")
                                    }
                                >
                                    <ChevronDownIcon />
                                </button>
                                {snapshot.activeMenu === "screenshare" && (
                                    <StagePopover
                                        anchor={screenShareMenuTriggerRef}
                                        placement="above"
                                        ariaLabel={_t("desktop|call_stage|stream_quality_settings")}
                                        testId="call-screenshare-quality-popover"
                                        className={styles.menuPopover}
                                        onClose={() => vm.setActiveMenu(null)}
                                    >
                                        <p className={styles.menuSectionTitle}>
                                            {_t("desktop|call_stage|resolution_label")}
                                        </p>
                                        <div className={styles.pillSelector}>
                                            {resolutionOptions.map((opt) => {
                                                const disabled =
                                                    opt.value !== null &&
                                                    snapshot.screenSharePolicyLimits.maxResolutionHeight !== null &&
                                                    opt.value > snapshot.screenSharePolicyLimits.maxResolutionHeight;
                                                return (
                                                    <button
                                                        key={opt.key}
                                                        type="button"
                                                        className={styles.pillOption}
                                                        disabled={disabled}
                                                        aria-pressed={
                                                            snapshot.screenShareQuality.resolutionHeight === opt.value
                                                        }
                                                        data-testid={`screenshare-res-${opt.key}`}
                                                        onClick={() =>
                                                            vm.updateScreenShareQuality({ resolutionHeight: opt.value })
                                                        }
                                                    >
                                                        {opt.label}
                                                    </button>
                                                );
                                            })}
                                        </div>

                                        <p className={styles.menuSectionTitle}>
                                            {_t("desktop|call_stage|frame_rate_label")}
                                        </p>
                                        <div className={styles.pillSelector}>
                                            {frameRateOptions.map((fps) => {
                                                const disabled =
                                                    snapshot.screenSharePolicyLimits.maxFrameRate !== null &&
                                                    fps > snapshot.screenSharePolicyLimits.maxFrameRate;
                                                return (
                                                    <button
                                                        key={fps}
                                                        type="button"
                                                        className={styles.pillOption}
                                                        disabled={disabled}
                                                        aria-pressed={snapshot.screenShareQuality.frameRate === fps}
                                                        data-testid={`screenshare-fps-${fps}`}
                                                        onClick={() => vm.updateScreenShareQuality({ frameRate: fps })}
                                                    >
                                                        {fps} FPS
                                                    </button>
                                                );
                                            })}
                                        </div>

                                        <p className={styles.menuSectionTitle}>
                                            {_t("desktop|call_stage|max_bandwidth_label")}
                                        </p>
                                        <div className={styles.pillSelector}>
                                            {bitrateOptions.map((opt) => {
                                                const disabled =
                                                    opt.value !== null &&
                                                    snapshot.screenSharePolicyLimits.maxBitrate !== null &&
                                                    opt.value > snapshot.screenSharePolicyLimits.maxBitrate;
                                                return (
                                                    <button
                                                        key={opt.key}
                                                        type="button"
                                                        className={styles.pillOption}
                                                        disabled={disabled}
                                                        aria-pressed={
                                                            snapshot.screenShareQuality.maxBitrate === opt.value
                                                        }
                                                        data-testid={`screenshare-bitrate-${opt.key}`}
                                                        onClick={() =>
                                                            vm.updateScreenShareQuality({ maxBitrate: opt.value })
                                                        }
                                                    >
                                                        {opt.label}
                                                    </button>
                                                );
                                            })}
                                        </div>

                                        <label className={styles.checkboxRow}>
                                            <span>{_t("desktop|call_stage|share_system_audio")}</span>
                                            <input
                                                type="checkbox"
                                                disabled={!snapshot.canShareSystemAudio}
                                                checked={
                                                    snapshot.canShareSystemAudio &&
                                                    snapshot.screenShareQuality.includeSystemAudio
                                                }
                                                data-testid="screenshare-system-audio-toggle"
                                                onChange={(e) =>
                                                    vm.updateScreenShareQuality({
                                                        includeSystemAudio: e.target.checked,
                                                    })
                                                }
                                            />
                                        </label>

                                        {!snapshot.canShareSystemAudio && (
                                            <Text size="xs">{_t("desktop|call_stage|video_only_capture")}</Text>
                                        )}
                                        <button
                                            type="button"
                                            className={styles.primaryActionBtn}
                                            data-testid="screenshare-menu-action-btn"
                                            onClick={() => {
                                                vm.setActiveMenu(null);
                                                if (snapshot.sharingScreen) {
                                                    vm.toggleScreenShare();
                                                } else {
                                                    vm.startScreenShareWithQuality(snapshot.screenShareQuality);
                                                }
                                            }}
                                        >
                                            {snapshot.sharingScreen
                                                ? _t("desktop|call_stage|stop_stream_btn")
                                                : _t("desktop|call_stage|start_stream_btn")}
                                        </button>
                                    </StagePopover>
                                )}
                            </div>
                        )}

                        {snapshot.phase === "in_call" && (
                            <div className={styles.controlPillGroup}>
                                <button
                                    ref={reactionsMenuTriggerRef}
                                    type="button"
                                    className={styles.controlButton}
                                    aria-label={_t("desktop|call_stage|reactions")}
                                    aria-expanded={snapshot.activeMenu === "reactions"}
                                    onClick={() =>
                                        vm.setActiveMenu(snapshot.activeMenu === "reactions" ? null : "reactions")
                                    }
                                >
                                    <ReactionSolidIcon />
                                </button>
                                {snapshot.activeMenu === "reactions" && (
                                    <StagePopover
                                        anchor={reactionsMenuTriggerRef}
                                        placement="above"
                                        className={styles.menuPopover}
                                        ariaLabel={_t("desktop|call_stage|reactions")}
                                        onClose={() => vm.setActiveMenu(null)}
                                    >
                                        <button
                                            type="button"
                                            className={styles.menuItem}
                                            onClick={vm.toggleRaisedHand}
                                            aria-pressed={snapshot.localHandRaised}
                                        >
                                            <RaisedHandSolidIcon />
                                            {snapshot.localHandRaised
                                                ? _t("desktop|call_stage|lower_hand")
                                                : _t("desktop|call_stage|raise_hand")}
                                        </button>
                                        {snapshot.supportsReactions && (
                                            <div className={styles.pillSelector}>
                                                {["👍", "🎉", "❤️"].map((emoji) => (
                                                    <button
                                                        key={emoji}
                                                        type="button"
                                                        className={styles.controlButton}
                                                        aria-label={_t("desktop|call_stage|send_reaction", { emoji })}
                                                        onClick={() => {
                                                            vm.sendReaction(emoji);
                                                            vm.setActiveMenu(null);
                                                        }}
                                                    >
                                                        {emoji}
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                    </StagePopover>
                                )}
                            </div>
                        )}
                        {/* Disconnect button */}
                        <button
                            type="button"
                            className={styles.controlButton}
                            data-danger="true"
                            aria-label={_t("desktop|call_stage|disconnect")}
                            data-testid="incall_leave"
                            onClick={vm.leaveCall}
                        >
                            <EndCallIcon />
                        </button>
                    </div>

                    {/* Bottom-right floating/fullscreen controls */}
                    <div className={styles.rightControls}>
                        <button
                            type="button"
                            className={styles.utilityButton}
                            aria-label={_t("desktop|call_stage|popout_call")}
                            title={_t("desktop|call_stage|popout_call")}
                            onClick={vm.popoutCall}
                        >
                            <PopOutIcon />
                        </button>
                        <button
                            type="button"
                            className={styles.utilityButton}
                            aria-label={
                                snapshot.isFullscreen
                                    ? _t("desktop|call_stage|exit_fullscreen")
                                    : _t("desktop|call_stage|fullscreen")
                            }
                            title={
                                snapshot.isFullscreen
                                    ? _t("desktop|call_stage|exit_fullscreen")
                                    : _t("desktop|call_stage|fullscreen")
                            }
                            onClick={() => vm.toggleFullscreen(stageRef.current)}
                        >
                            {snapshot.isFullscreen ? <CollapseIcon /> : <ExpandIcon />}
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
