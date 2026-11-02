/*
 * Copyright 2026 Gabriel
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE in the repository root for full details.
 */

import React, {
    type CSSProperties,
    type JSX,
    type KeyboardEvent,
    type ReactEventHandler,
    type Ref,
    useCallback,
    useEffect,
    useRef,
    useState,
} from "react";
import classNames from "classnames";
import { useMergeRefs } from "react-merge-refs";
import {
    CollapseIcon,
    FullScreenIcon,
    PauseSolidIcon,
    PlaySolidIcon,
    VolumeOffSolidIcon,
    VolumeOnSolidIcon,
} from "@vector-im/compound-design-tokens/assets/web/icons";

import { useI18n } from "../../../../../core/i18n/i18nContext";
import { Clock } from "../../../../../audio/Clock";
import styles from "./VideoPlayer.module.css";

/** How long the pointer may rest on a playing video before its controls fade. */
const IDLE_DELAY_MS = 2000;
/** How far the arrow keys move playback, in seconds. */
const SEEK_STEP_SECONDS = 5;
/** How far the up and down arrows move the volume. */
const VOLUME_STEP = 0.1;

/** Props for {@link VideoPlayer}. */
export interface VideoPlayerProps {
    /** Video source URL. */
    src?: string;
    /** Poster image URL, shown until playback starts. */
    poster?: string;
    /** Accessible label for the video element. */
    label?: string;
    /** Title for the video element. */
    title?: string;
    /** Preload mode for the video. */
    preload?: "none" | "metadata" | "auto";
    /** Whether the video starts muted. */
    muted?: boolean;
    /** Whether the video plays on its own. */
    autoPlay?: boolean;
    /** Class applied to the video element. */
    videoClassName?: string;
    /** Ref to the video element. */
    videoRef?: Ref<HTMLVideoElement>;
    /** Called when playback starts. */
    onPlay?: ReactEventHandler<HTMLVideoElement>;
}

function fraction(value: number, total: number): number {
    return total > 0 && Number.isFinite(total) ? Math.min(1, Math.max(0, value / total)) : 0;
}

/**
 * A video with Aether's own controls in place of the browser's: a large play button over the poster, and a bar
 * that fades in on hover with play, the time, a seek bar that shows what has loaded, volume and full screen.
 *
 * The keyboard works while the player has focus: Space or K plays and pauses, the left and right arrows seek, the
 * up and down arrows change the volume, M mutes and F toggles full screen.
 */
export function VideoPlayer({
    src,
    poster,
    label,
    title,
    preload,
    muted,
    autoPlay,
    videoClassName,
    videoRef,
    onPlay,
}: Readonly<VideoPlayerProps>): JSX.Element {
    const { translate: _t } = useI18n();
    const rootRef = useRef<HTMLDivElement>(null);
    // The element is kept in state so the listeners below attach once it mounts, and in a ref for the controls
    // that change it, since a value held in state must not be modified.
    const [video, setVideo] = useState<HTMLVideoElement | null>(null);
    const videoElement = useRef<HTMLVideoElement | null>(null);
    const mergedVideoRef = useMergeRefs([videoRef, setVideo, videoElement]);

    const [playing, setPlaying] = useState(false);
    const [started, setStarted] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [buffered, setBuffered] = useState(0);
    const [volume, setVolume] = useState(1);
    const [isMuted, setIsMuted] = useState(!!muted);
    const [fullScreen, setFullScreen] = useState(false);
    const [idle, setIdle] = useState(false);
    const idleTimer = useRef<number | undefined>(undefined);

    // Mirror the element's own state, so controls stay right however playback changes.
    useEffect(() => {
        if (!video) return;
        const sync = (): void => {
            setPlaying(!video.paused && !video.ended);
            setCurrentTime(video.currentTime);
            setDuration(Number.isFinite(video.duration) ? video.duration : 0);
            setVolume(video.volume);
            setIsMuted(video.muted);
            const ranges = video.buffered;
            setBuffered(ranges.length > 0 ? ranges.end(ranges.length - 1) : 0);
        };
        const onStart = (): void => setStarted(true);
        const events = [
            "play",
            "pause",
            "ended",
            "timeupdate",
            "durationchange",
            "loadedmetadata",
            "progress",
            "volumechange",
        ];
        for (const name of events) video.addEventListener(name, sync);
        video.addEventListener("play", onStart);
        sync();
        return () => {
            for (const name of events) video.removeEventListener(name, sync);
            video.removeEventListener("play", onStart);
        };
    }, [video]);

    useEffect(() => {
        const onChange = (): void => setFullScreen(!!rootRef.current && document.fullscreenElement === rootRef.current);
        document.addEventListener("fullscreenchange", onChange);
        return () => document.removeEventListener("fullscreenchange", onChange);
    }, []);

    useEffect(() => () => window.clearTimeout(idleTimer.current), []);

    const wake = useCallback((): void => {
        setIdle(false);
        window.clearTimeout(idleTimer.current);
        idleTimer.current = window.setTimeout(() => setIdle(true), IDLE_DELAY_MS);
    }, []);

    const togglePlay = useCallback((): void => {
        const video = videoElement.current;
        if (!video) return;
        if (video.paused || video.ended) {
            // A rejected play() (for example, no source yet) leaves the controls showing it paused.
            void video.play()?.catch(() => {});
        } else {
            video.pause();
        }
    }, []);

    const toggleMute = useCallback((): void => {
        const video = videoElement.current;
        if (!video) return;
        video.muted = !video.muted;
        // Unmuting at zero volume would still be silent.
        if (!video.muted && video.volume === 0) video.volume = 0.5;
    }, []);

    const toggleFullScreen = useCallback((): void => {
        const root = rootRef.current;
        if (!root) return;
        if (document.fullscreenElement === root) {
            void document.exitFullscreen?.().catch(() => {});
        } else {
            void root.requestFullscreen?.().catch(() => {});
        }
    }, []);

    const seekTo = (time: number): void => {
        const video = videoElement.current;
        if (!video) return;
        video.currentTime = Math.min(Math.max(0, time), duration || 0);
        setCurrentTime(video.currentTime);
    };

    const setVolumeTo = (value: number): void => {
        const video = videoElement.current;
        if (!video) return;
        video.volume = Math.min(1, Math.max(0, value));
        video.muted = video.volume === 0;
    };

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
        // Leave the sliders their own arrow keys, and a focused button its own Space and Enter.
        const tag = (event.target as HTMLElement).tagName;
        if (tag === "INPUT" || (tag === "BUTTON" && (event.key === " " || event.key === "Enter"))) return;
        let handled = true;
        switch (event.key) {
            case " ":
            case "k":
            case "K":
                togglePlay();
                break;
            case "ArrowLeft":
                seekTo(currentTime - SEEK_STEP_SECONDS);
                break;
            case "ArrowRight":
                seekTo(currentTime + SEEK_STEP_SECONDS);
                break;
            case "ArrowUp":
                setVolumeTo(volume + VOLUME_STEP);
                break;
            case "ArrowDown":
                setVolumeTo(volume - VOLUME_STEP);
                break;
            case "m":
            case "M":
                toggleMute();
                break;
            case "f":
            case "F":
                toggleFullScreen();
                break;
            default:
                handled = false;
        }
        if (handled) {
            event.preventDefault();
            event.stopPropagation();
            wake();
        }
    };

    const shownVolume = isMuted ? 0 : volume;
    const rootStyle = {
        "--video-progress": `${fraction(currentTime, duration) * 100}%`,
        "--video-buffered": `${fraction(buffered, duration) * 100}%`,
        "--video-volume": `${shownVolume * 100}%`,
    } as CSSProperties;

    return (
        // Media keys pressed while any of the player's controls has focus reach this handler. The wrapper itself
        // is not a focus stop: the controls inside it are the interactive elements.
        <div
            ref={rootRef}
            className={classNames(styles.player, {
                [styles.playing]: playing,
                [styles.idle]: idle && playing,
                [styles.fullScreen]: fullScreen,
            })}
            style={rootStyle}
            onKeyDown={onKeyDown}
            onPointerMove={wake}
            onPointerLeave={() => setIdle(true)}
            data-testid="video-player"
        >
            <video
                ref={mergedVideoRef}
                className={classNames(styles.video, videoClassName)}
                src={src}
                aria-label={label}
                title={title}
                controlsList="nodownload"
                crossOrigin="anonymous"
                preload={preload}
                muted={muted}
                autoPlay={autoPlay}
                poster={poster}
                playsInline
                onPlay={onPlay}
                onClick={togglePlay}
                onDoubleClick={toggleFullScreen}
            />

            {!playing && (
                <button
                    type="button"
                    className={styles.bigPlay}
                    onClick={togglePlay}
                    aria-label={_t("timeline|video_player|play")}
                >
                    <PlaySolidIcon aria-hidden={true} />
                </button>
            )}

            {!started && duration > 0 && (
                <Clock seconds={duration} className={styles.durationBadge} minutesMinLength={1} hoursMinLength={1} />
            )}

            <div className={styles.controls}>
                <input
                    type="range"
                    className={styles.seek}
                    min={0}
                    max={duration || 0}
                    step="any"
                    value={Math.min(currentTime, duration || 0)}
                    disabled={!duration}
                    onChange={(event) => seekTo(Number(event.target.value))}
                    aria-label={_t("timeline|video_player|seek")}
                />
                <div className={styles.bar}>
                    <button
                        type="button"
                        className={styles.control}
                        onClick={togglePlay}
                        aria-label={playing ? _t("timeline|video_player|pause") : _t("timeline|video_player|play")}
                    >
                        {playing ? <PauseSolidIcon aria-hidden={true} /> : <PlaySolidIcon aria-hidden={true} />}
                    </button>
                    <span className={styles.time}>
                        <Clock seconds={currentTime} minutesMinLength={1} hoursMinLength={1} />
                        <span aria-hidden="true"> / </span>
                        <Clock seconds={duration} minutesMinLength={1} hoursMinLength={1} />
                    </span>
                    <div className={styles.volume}>
                        <button
                            type="button"
                            className={styles.control}
                            onClick={toggleMute}
                            aria-label={isMuted ? _t("timeline|video_player|unmute") : _t("timeline|video_player|mute")}
                        >
                            {isMuted || volume === 0 ? (
                                <VolumeOffSolidIcon aria-hidden={true} />
                            ) : (
                                <VolumeOnSolidIcon aria-hidden={true} />
                            )}
                        </button>
                        <input
                            type="range"
                            className={styles.volumeSlider}
                            min={0}
                            max={1}
                            step={0.05}
                            value={shownVolume}
                            onChange={(event) => setVolumeTo(Number(event.target.value))}
                            aria-label={_t("timeline|video_player|volume")}
                        />
                    </div>
                    <button
                        type="button"
                        className={classNames(styles.control, styles.fullScreenButton)}
                        onClick={toggleFullScreen}
                        aria-label={
                            fullScreen
                                ? _t("timeline|video_player|exit_full_screen")
                                : _t("timeline|video_player|full_screen")
                        }
                    >
                        {fullScreen ? <CollapseIcon aria-hidden={true} /> : <FullScreenIcon aria-hidden={true} />}
                    </button>
                </div>
            </div>
        </div>
    );
}
