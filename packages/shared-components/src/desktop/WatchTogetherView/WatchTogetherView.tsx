/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, {
    type JSX,
    type KeyboardEvent,
    type RefObject,
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
} from "react";
import { Text } from "@vector-im/compound-web";
import {
    CloseIcon,
    DeleteIcon,
    ListBulletedIcon,
    PauseSolidIcon,
    PlaySolidIcon,
    PopOutIcon,
    SpotlightViewIcon,
    VolumeOffSolidIcon,
    VolumeOnSolidIcon,
} from "@vector-im/compound-design-tokens/assets/web/icons";

import { type ViewModel, useViewModel } from "../../core/viewmodel";
import { useI18n } from "../../core/i18n/i18nContext";
import { WatchTogetherIcon } from "./WatchTogetherIcon";
import styles from "./WatchTogetherView.module.css";

/** The call stage tile ID of the shared player, alongside participant and screen share tiles. */
export const WATCH_TOGETHER_TILE_ID = "watch-together";

/** One entry in the shared queue. */
export interface WatchTogetherQueueEntry {
    readonly id: string;
    readonly title: string;
    readonly subtitle?: string;
    readonly thumbnailUrl?: string;
    /** Display name of whoever added it. */
    readonly addedBy: string;
    readonly current: boolean;
}

/** The shared player as this device shows it. */
export interface WatchTogetherViewSnapshot {
    /** In the call, so links can be shared. */
    readonly connected: boolean;
    /** Something is queued for the call. */
    readonly active: boolean;
    readonly title: string;
    /** The YouTube channel or the site a file is from. */
    readonly subtitle?: string;
    /** Display name of whoever added what is playing. */
    readonly addedBy?: string;
    readonly thumbnailUrl?: string;
    /** "YouTube", or the host of a media file. */
    readonly sourceName?: string;
    readonly playing: boolean;
    /** The queue played to its end. */
    readonly ended: boolean;
    /** Seconds until a new item starts for everyone, or null once it has. */
    readonly startingIn: number | null;
    readonly buffering: boolean;
    /** False for audio, which shows its artwork instead of a black frame. */
    readonly hasVideo: boolean;
    /** The YouTube embed takes clicks itself; a media file is toggled by clicking anywhere on the player. */
    readonly embedHandlesClicks: boolean;
    readonly position: number;
    readonly duration: number | null;
    readonly rate: number;
    readonly rates: readonly number[];
    readonly hasPrevious: boolean;
    readonly hasNext: boolean;
    readonly queue: readonly WatchTogetherQueueEntry[];
    /** This device's volume, 0 to 100. */
    readonly volume: number;
    /** The user is deafened, so nothing plays on this device whatever the volume. */
    readonly deafened: boolean;
    /** Text in the panel's link field. */
    readonly draft: string;
    readonly adding: boolean;
    readonly addError?: string;
    /** Why this device cannot play the current item. */
    readonly playerError?: string;
    /** A short line such as "Alice paused", shown for a moment; the ID changes for each new notice. */
    readonly notice?: { readonly id: number; readonly text: string };
}

/** What people in the call can do with the shared player; everything except volume is shared with everyone. */
export interface WatchTogetherViewActions {
    setDraft(text: string): void;
    /** Plays the link in the field now, or adds it to the end of the queue. */
    submitDraft(mode: "play" | "queue"): Promise<void>;
    /** Takes a pasted link: true when it was playable and was played or queued. */
    addLink(text: string): boolean;
    togglePlaying(): void;
    seek(seconds: number): void;
    setRate(rate: number): void;
    next(): void;
    previous(): void;
    playItem(id: string): void;
    removeItem(id: string): void;
    /** Ends the activity for everyone. */
    stop(): void;
    setVolume(volume: number): void;
    /** Shows this device's player inside `host`; null when the host goes away. */
    attachPlayer(host: HTMLElement | null): void;
    /** Opens what is playing at its source in the browser. */
    openSource(): void;
}

export type WatchTogetherViewModel = ViewModel<WatchTogetherViewSnapshot, WatchTogetherViewActions>;

/** Formats seconds as m:ss, or h:mm:ss for long videos. */
export function formatPlaybackTime(seconds: number): string {
    const total = Math.max(0, Math.floor(seconds));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = String(total % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

const formatRate = (rate: number): string => `${rate}×`;

/** Keeps `layer` exactly over `slot` inside `container`, following layout changes and tile animations. */
function useFollowSlot(
    layer: RefObject<HTMLElement | null>,
    slot: RefObject<HTMLElement | null>,
    container: RefObject<HTMLElement | null>,
): void {
    useLayoutEffect(() => {
        let frame = 0;
        let last = "";
        const place = (): void => {
            frame = requestAnimationFrame(place);
            const element = layer.current;
            const target = slot.current;
            const parent = container.current;
            if (!element) return;
            if (!target || !parent || !target.isConnected) {
                if (last !== "hidden") element.dataset.hidden = "true";
                last = "hidden";
                return;
            }
            const a = target.getBoundingClientRect();
            const b = parent.getBoundingClientRect();
            const next = `${a.left - b.left},${a.top - b.top},${a.width},${a.height}`;
            if (next === last) return;
            last = next;
            delete element.dataset.hidden;
            element.style.transform = `translate(${a.left - b.left}px, ${a.top - b.top}px)`;
            element.style.width = `${a.width}px`;
            element.style.height = `${a.height}px`;
        };
        place();
        return () => cancelAnimationFrame(frame);
    }, [layer, slot, container]);
}

function SpeedMenu({
    vm,
    rate,
    rates,
}: {
    vm: WatchTogetherViewModel;
    rate: number;
    rates: readonly number[];
}): JSX.Element {
    const { translate: _t } = useI18n();
    const [open, setOpen] = useState(false);
    return (
        <div className={styles.speed} onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setOpen(false)}>
            <button
                type="button"
                className={styles.textControl}
                aria-label={_t("desktop|watch_together|speed", { rate: formatRate(rate) })}
                aria-expanded={open}
                onClick={() => setOpen(!open)}
            >
                {formatRate(rate)}
            </button>
            {open && (
                <div className={styles.speedMenu} role="menu">
                    {rates.map((option) => (
                        <button
                            key={option}
                            type="button"
                            role="menuitemradio"
                            aria-checked={option === rate}
                            className={styles.speedOption}
                            onClick={() => {
                                vm.setRate(option);
                                setOpen(false);
                            }}
                        >
                            {formatRate(option)}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

/** Props for {@link WatchTogetherPlayer}. */
export interface WatchTogetherPlayerProps {
    vm: WatchTogetherViewModel;
    /** The tile the player covers; it can move between the spotlight, the grid and the filmstrip. */
    slotRef: RefObject<HTMLElement | null>;
    /** The positioned stage element the layer is placed in. */
    containerRef: RefObject<HTMLElement | null>;
    /** Shown small in the filmstrip: no controls, and a click focuses it. */
    compact: boolean;
    /** It is the focused tile; otherwise its controls offer to focus it, since the video takes its clicks. */
    focused: boolean;
    onFocus: () => void;
    onOpenQueue: () => void;
}

/**
 * The shared player and its controls. It is rendered once, at a fixed place in the call stage, and laid over
 * whichever tile stands for it: moving an embedded player in the page would reload it and interrupt playback.
 */
export function WatchTogetherPlayer({
    vm,
    slotRef,
    containerRef,
    compact,
    focused,
    onFocus,
    onOpenQueue,
}: WatchTogetherPlayerProps): JSX.Element {
    const { translate: _t } = useI18n();
    const snapshot = useViewModel(vm);
    const layerRef = useRef<HTMLDivElement>(null);
    const hostRef = useRef<HTMLDivElement>(null);
    const [scrub, setScrub] = useState<number | null>(null);
    useFollowSlot(layerRef, slotRef, containerRef);

    useEffect(() => {
        vm.attachPlayer(hostRef.current);
        return () => vm.attachPlayer(null);
    }, [vm]);

    // Player shortcuts while one of its controls has focus; sliders keep their own arrow keys.
    const onKeyDown = useCallback(
        (event: KeyboardEvent<HTMLDivElement>): void => {
            if ((event.target as HTMLElement).tagName === "INPUT") return;
            if (event.key === "k") vm.togglePlaying();
            else if (event.key === "ArrowLeft") vm.seek(snapshot.position - 5);
            else if (event.key === "ArrowRight") vm.seek(snapshot.position + 5);
            else return;
            event.preventDefault();
        },
        [vm, snapshot.position],
    );

    const duration = snapshot.duration ?? 0;
    const position = scrub ?? Math.min(snapshot.position, duration || snapshot.position);
    const muted = snapshot.volume === 0 || snapshot.deafened;
    const showArtwork = !snapshot.hasVideo || !!snapshot.playerError;

    const subtitle = [
        snapshot.subtitle,
        snapshot.addedBy && _t("desktop|watch_together|added_by", { name: snapshot.addedBy }),
    ]
        .filter(Boolean)
        .join(" · ");

    // YouTube's terms forbid covering its player, so the controls sit in a bar below the picture, never on it.
    return (
        <div
            ref={layerRef}
            className={styles.layer}
            data-compact={compact || undefined}
            data-testid="watch-together-player"
            role="region"
            aria-label={_t("desktop|watch_together|player_label", { title: snapshot.title })}
            onKeyDown={onKeyDown}
        >
            <div className={styles.screen}>
                <div ref={hostRef} className={styles.host} data-artwork={showArtwork || undefined} />
                {showArtwork && (
                    <div className={styles.artwork} aria-hidden="true">
                        {snapshot.thumbnailUrl && (
                            <img className={styles.artworkBackdrop} src={snapshot.thumbnailUrl} alt="" />
                        )}
                        <div className={styles.artworkCover}>
                            {snapshot.thumbnailUrl ? (
                                <img src={snapshot.thumbnailUrl} alt="" />
                            ) : (
                                <WatchTogetherIcon width={40} height={40} />
                            )}
                        </div>
                    </div>
                )}
                {(compact || !snapshot.embedHandlesClicks) && (
                    <button
                        type="button"
                        className={styles.clickSurface}
                        aria-label={
                            compact
                                ? _t("desktop|watch_together|focus")
                                : snapshot.playing
                                  ? _t("desktop|watch_together|pause")
                                  : _t("desktop|watch_together|play")
                        }
                        onClick={compact ? onFocus : vm.togglePlaying}
                    />
                )}
                {!compact && snapshot.playerError && (
                    <div className={styles.card} role="alert">
                        <Text size="md" weight="semibold">
                            {snapshot.playerError}
                        </Text>
                        <div className={styles.cardActions}>
                            {snapshot.hasNext && (
                                <button type="button" className={styles.pillButton} onClick={vm.next}>
                                    {_t("desktop|watch_together|skip")}
                                </button>
                            )}
                            <button type="button" className={styles.pillButton} onClick={vm.openSource}>
                                <PopOutIcon width={16} height={16} />
                                {_t("desktop|watch_together|open_source", { source: snapshot.sourceName ?? "" })}
                            </button>
                        </div>
                    </div>
                )}
                {!compact && snapshot.ended && !snapshot.playerError && (
                    <div className={styles.card} role="status">
                        <Text size="md" weight="semibold">
                            {_t("desktop|watch_together|queue_finished")}
                        </Text>
                        <div className={styles.cardActions}>
                            <button type="button" className={styles.pillButton} onClick={vm.togglePlaying}>
                                <PlaySolidIcon width={16} height={16} />
                                {_t("desktop|watch_together|replay")}
                            </button>
                            <button type="button" className={styles.pillButton} onClick={onOpenQueue}>
                                {_t("desktop|watch_together|add_more")}
                            </button>
                        </div>
                    </div>
                )}
                {compact && (
                    <div className={styles.compactLabel}>
                        <WatchTogetherIcon width={14} height={14} aria-hidden="true" />
                        <span>{snapshot.title}</span>
                    </div>
                )}
            </div>

            {!compact && (
                <div className={styles.controlBar}>
                    <input
                        className={styles.progress}
                        type="range"
                        min={0}
                        max={duration || 1}
                        step={0.1}
                        value={duration ? position : 0}
                        disabled={!duration}
                        aria-label={_t("desktop|watch_together|seek")}
                        aria-valuetext={formatPlaybackTime(position)}
                        style={{ "--progress": duration ? `${(position / duration) * 100}%` : "0%" } as object}
                        onChange={(e) => setScrub(Number(e.currentTarget.value))}
                        onPointerUp={(e) => {
                            vm.seek(Number(e.currentTarget.value));
                            setScrub(null);
                        }}
                        onKeyUp={(e) => {
                            if (scrub === null) return;
                            vm.seek(Number(e.currentTarget.value));
                            setScrub(null);
                        }}
                    />
                    <div className={styles.controlsRow}>
                        <button
                            type="button"
                            className={styles.iconControl}
                            aria-label={_t("desktop|watch_together|previous")}
                            title={_t("desktop|watch_together|previous")}
                            onClick={vm.previous}
                        >
                            <SkipIcon direction="previous" />
                        </button>
                        <button
                            type="button"
                            className={styles.playButton}
                            aria-label={
                                snapshot.playing
                                    ? _t("desktop|watch_together|pause")
                                    : _t("desktop|watch_together|play")
                            }
                            data-testid="watch-together-toggle"
                            onClick={vm.togglePlaying}
                        >
                            {snapshot.playing ? <PauseSolidIcon /> : <PlaySolidIcon />}
                        </button>
                        <button
                            type="button"
                            className={styles.iconControl}
                            aria-label={_t("desktop|watch_together|next")}
                            title={_t("desktop|watch_together|next")}
                            disabled={!snapshot.hasNext}
                            onClick={vm.next}
                        >
                            <SkipIcon direction="next" />
                        </button>
                        <span className={styles.time}>
                            {formatPlaybackTime(position)}
                            {snapshot.duration !== null && ` / ${formatPlaybackTime(snapshot.duration)}`}
                        </span>
                        <div className={styles.nowPlaying}>
                            <span className={styles.title} title={snapshot.title}>
                                {snapshot.title}
                            </span>
                            {/* What someone just did shows in place of the details for a moment. */}
                            <span className={styles.metaLine}>
                                {snapshot.startingIn !== null && !snapshot.playerError ? (
                                    <span className={styles.status} role="status">
                                        {_t("desktop|watch_together|starting")}
                                    </span>
                                ) : (
                                    <>
                                        <span
                                            key={`subtitle-${snapshot.notice?.id ?? 0}`}
                                            className={styles.subtitle}
                                            data-after-notice={snapshot.notice ? true : undefined}
                                        >
                                            <WatchTogetherIcon width={12} height={12} aria-hidden="true" />
                                            {[snapshot.sourceName, subtitle].filter(Boolean).join(" · ")}
                                        </span>
                                        {snapshot.notice && (
                                            <span key={snapshot.notice.id} className={styles.notice} role="status">
                                                {snapshot.notice.text}
                                            </span>
                                        )}
                                    </>
                                )}
                            </span>
                        </div>
                        <div className={styles.volume}>
                            <button
                                type="button"
                                className={styles.iconControl}
                                aria-label={
                                    muted ? _t("desktop|watch_together|unmute") : _t("desktop|watch_together|mute")
                                }
                                title={snapshot.deafened ? _t("desktop|watch_together|deafened") : undefined}
                                disabled={snapshot.deafened}
                                onClick={() => vm.setVolume(snapshot.volume === 0 ? 100 : 0)}
                            >
                                {muted ? <VolumeOffSolidIcon /> : <VolumeOnSolidIcon />}
                            </button>
                            <input
                                className={styles.volumeSlider}
                                type="range"
                                min={0}
                                max={100}
                                value={snapshot.deafened ? 0 : snapshot.volume}
                                disabled={snapshot.deafened}
                                aria-label={_t("desktop|watch_together|volume")}
                                style={{ "--progress": `${snapshot.deafened ? 0 : snapshot.volume}%` } as object}
                                onChange={(e) => vm.setVolume(Number(e.currentTarget.value))}
                            />
                        </div>
                        <SpeedMenu vm={vm} rate={snapshot.rate} rates={snapshot.rates} />
                        {!focused && (
                            <button
                                type="button"
                                className={styles.iconControl}
                                aria-label={_t("desktop|watch_together|focus")}
                                title={_t("desktop|watch_together|focus")}
                                onClick={onFocus}
                            >
                                <SpotlightViewIcon />
                            </button>
                        )}
                        <button
                            type="button"
                            className={styles.iconControl}
                            aria-label={_t("desktop|watch_together|queue", { count: snapshot.queue.length })}
                            title={_t("desktop|watch_together|queue", { count: snapshot.queue.length })}
                            onClick={onOpenQueue}
                        >
                            <ListBulletedIcon />
                            {snapshot.queue.length > 1 && (
                                <span className={styles.queueCount}>{snapshot.queue.length}</span>
                            )}
                        </button>
                        <button
                            type="button"
                            className={styles.iconControl}
                            aria-label={_t("desktop|watch_together|stop")}
                            title={_t("desktop|watch_together|stop")}
                            onClick={vm.stop}
                        >
                            <CloseIcon />
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}

function SkipIcon({ direction }: { direction: "previous" | "next" }): JSX.Element {
    return (
        <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
            style={direction === "previous" ? { transform: "scaleX(-1)" } : undefined}
        >
            <path d="M5 6.2v11.6c0 .8.9 1.3 1.6.8l8.3-5.8c.6-.4.6-1.2 0-1.6L6.6 5.4C5.9 4.9 5 5.4 5 6.2Z" />
            <rect x="16.5" y="5" width="2.5" height="14" rx="1.2" />
        </svg>
    );
}

/** The toolbar panel: share a link, see what is coming up, and end the activity. */
export function WatchTogetherPanel({ vm }: { vm: WatchTogetherViewModel }): JSX.Element {
    const { translate: _t } = useI18n();
    const snapshot = useViewModel(vm);
    const inputRef = useRef<HTMLInputElement>(null);
    useEffect(() => inputRef.current?.focus(), []);

    return (
        <div className={styles.panel} data-testid="watch-together-panel">
            <form
                className={styles.linkForm}
                onSubmit={(e) => {
                    e.preventDefault();
                    void vm.submitDraft(snapshot.active ? "queue" : "play");
                }}
            >
                <Text as="label" size="sm" weight="semibold" htmlFor="watch-together-link">
                    {_t("desktop|watch_together|link_label")}
                </Text>
                <div className={styles.linkRow}>
                    <input
                        ref={inputRef}
                        id="watch-together-link"
                        className={styles.linkInput}
                        type="url"
                        inputMode="url"
                        autoComplete="off"
                        spellCheck={false}
                        placeholder={_t("desktop|watch_together|link_placeholder")}
                        value={snapshot.draft}
                        disabled={!snapshot.connected}
                        aria-invalid={!!snapshot.addError}
                        aria-describedby="watch-together-link-hint"
                        onChange={(e) => vm.setDraft(e.currentTarget.value)}
                    />
                    {snapshot.active ? (
                        <>
                            <button
                                type="submit"
                                className={styles.primaryButton}
                                disabled={!snapshot.draft.trim() || snapshot.adding}
                            >
                                {_t("desktop|watch_together|add_to_queue")}
                            </button>
                            <button
                                type="button"
                                className={styles.secondaryButton}
                                disabled={!snapshot.draft.trim() || snapshot.adding}
                                onClick={() => void vm.submitDraft("play")}
                            >
                                {_t("desktop|watch_together|play_now")}
                            </button>
                        </>
                    ) : (
                        <button
                            type="submit"
                            className={styles.primaryButton}
                            disabled={!snapshot.draft.trim() || snapshot.adding}
                        >
                            {_t("desktop|watch_together|play_for_everyone")}
                        </button>
                    )}
                </div>
                <Text
                    id="watch-together-link-hint"
                    size="xs"
                    className={snapshot.addError ? styles.error : styles.hint}
                    role={snapshot.addError ? "alert" : undefined}
                >
                    {snapshot.addError ?? _t("desktop|watch_together|link_hint")}
                </Text>
            </form>

            {snapshot.queue.length > 0 && (
                <>
                    <div className={styles.queueHeader}>
                        <Text size="sm" weight="semibold">
                            {_t("desktop|watch_together|up_next")}
                        </Text>
                        <button type="button" className={styles.dangerLink} onClick={vm.stop}>
                            {_t("desktop|watch_together|stop")}
                        </button>
                    </div>
                    <ol className={styles.queueList}>
                        {snapshot.queue.map((entry, index) => (
                            <li key={entry.id} className={styles.queueItem} data-current={entry.current || undefined}>
                                <button
                                    type="button"
                                    className={styles.queueMain}
                                    aria-current={entry.current || undefined}
                                    onClick={() => vm.playItem(entry.id)}
                                >
                                    <span className={styles.queueIndex}>
                                        {entry.current ? (
                                            <WatchTogetherIcon width={16} height={16} aria-hidden="true" />
                                        ) : (
                                            index + 1
                                        )}
                                    </span>
                                    {entry.thumbnailUrl ? (
                                        <img className={styles.queueThumb} src={entry.thumbnailUrl} alt="" />
                                    ) : (
                                        <span className={styles.queueThumb} />
                                    )}
                                    <span className={styles.queueText}>
                                        <span className={styles.queueTitle}>{entry.title}</span>
                                        <span className={styles.queueMeta}>
                                            {[
                                                entry.subtitle,
                                                _t("desktop|watch_together|added_by", { name: entry.addedBy }),
                                            ]
                                                .filter(Boolean)
                                                .join(" · ")}
                                        </span>
                                    </span>
                                </button>
                                <button
                                    type="button"
                                    className={styles.iconControl}
                                    aria-label={_t("desktop|watch_together|remove", { title: entry.title })}
                                    title={_t("action|remove")}
                                    onClick={() => vm.removeItem(entry.id)}
                                >
                                    <DeleteIcon width={18} height={18} />
                                </button>
                            </li>
                        ))}
                    </ol>
                </>
            )}
        </div>
    );
}
