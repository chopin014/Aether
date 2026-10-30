/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, type PointerEvent, useEffect, useRef } from "react";
import { Button, Text } from "@vector-im/compound-web";
import { PlaySolidIcon, PauseSolidIcon } from "@vector-im/compound-design-tokens/assets/web/icons";

import { useI18n } from "../../core/i18n/i18nContext";
import styles from "./SoundboardClipView.module.css";

/** Local source and the portion that will be uploaded. All times are in seconds. */
export interface SoundboardClipSnapshot {
    name: string;
    duration: number;
    peaks: readonly number[];
    start: number;
    end: number;
    playing: boolean;
    volume: number;
    editing?: boolean;
    position: number;
}

interface Props {
    clip: SoundboardClipSnapshot;
    disabled: boolean;
    onRange: (start: number, end: number) => void;
    onPreview: () => void;
    onVolume: (volume: number) => void;
    onCancel: () => void;
    onSave: () => void;
}

const time = (seconds: number): string => `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, "0")}`;

/** Waveform with draggable and keyboard-accessible selection edges and local preview controls. */
export function SoundboardClipView({
    clip,
    disabled,
    onRange,
    onPreview,
    onVolume,
    onCancel,
    onSave,
}: Props): JSX.Element {
    const { translate: _t } = useI18n();
    const previewButton = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        if (!disabled) previewButton.current?.focus();
    }, [disabled]);
    const waveform = useRef<HTMLDivElement>(null);
    const drag = useRef<{ edge: "start" | "end" | "move"; x: number; start: number; end: number } | null>(null);
    const percent = (seconds: number): string => `${(seconds / clip.duration) * 100}%`;
    const setEdge = (edge: "start" | "end", value: number): void => {
        if (edge === "start") onRange(Math.max(0, clip.end - 10, Math.min(clip.end - 0.1, value)), clip.end);
        else
            onRange(
                clip.start,
                Math.max(clip.start + Math.min(0.1, clip.duration), Math.min(clip.duration, clip.start + 10, value)),
            );
    };
    const beginDrag = (event: PointerEvent<HTMLElement>, edge: "start" | "end" | "move"): void => {
        if (disabled) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { edge, x: event.clientX, start: clip.start, end: clip.end };
    };
    const moveDrag = (event: PointerEvent<HTMLElement>): void => {
        if (!drag.current || !waveform.current || disabled) return;
        const { edge, x, start, end } = drag.current;
        const delta = ((event.clientX - x) / waveform.current.getBoundingClientRect().width) * clip.duration;
        if (edge === "move") {
            const next = Math.max(0, Math.min(clip.duration - (end - start), start + delta));
            onRange(next, next + end - start);
        } else if (edge === "start") {
            onRange(Math.max(0, end - 10, Math.min(end - 0.1, start + delta)), end);
        } else {
            onRange(start, Math.min(clip.duration, start + 10, Math.max(start + 0.1, end + delta)));
        }
    };
    return (
        <section className={styles.editor} aria-label={_t("desktop|soundboard|clip_title")}>
            <div className={styles.heading}>
                <Text size="sm" weight="semibold" className={styles.filename}>
                    {clip.name}
                </Text>
                <Text size="xs" className={styles.duration}>
                    {time(clip.end - clip.start)} / 0:10.0
                </Text>
            </div>
            <Text size="xs" className={styles.hint}>
                {clip.duration > 10 ? _t("desktop|soundboard|trim_hint") : _t("desktop|soundboard|preview_hint")}
            </Text>
            <div className={styles.waveform} ref={waveform}>
                <svg viewBox="0 0 400 80" preserveAspectRatio="none" aria-hidden="true">
                    {clip.peaks.map((peak, index) => (
                        <rect
                            key={(index / clip.peaks.length) * clip.duration}
                            x={(index / clip.peaks.length) * 400}
                            y={40 - peak * 34}
                            width={2}
                            height={Math.max(2, peak * 68)}
                            rx={1}
                            className={
                                index / clip.peaks.length >= clip.start / clip.duration &&
                                index / clip.peaks.length <= clip.end / clip.duration
                                    ? styles.selectedBar
                                    : undefined
                            }
                        />
                    ))}
                </svg>
                <button
                    type="button"
                    role="slider"
                    disabled={disabled}
                    className={styles.selection}
                    aria-label={_t("desktop|soundboard|selection_position")}
                    aria-valuemin={0}
                    aria-valuemax={clip.duration - (clip.end - clip.start)}
                    aria-valuenow={clip.start}
                    aria-valuetext={time(clip.start)}
                    style={{ left: percent(clip.start), width: percent(clip.end - clip.start) }}
                    onPointerDown={(event) => beginDrag(event, "move")}
                    onPointerMove={moveDrag}
                    onPointerUp={() => {
                        drag.current = null;
                    }}
                    onPointerCancel={() => {
                        drag.current = null;
                    }}
                    onKeyDown={(event) => {
                        if (!["ArrowLeft", "ArrowDown", "ArrowRight", "ArrowUp", "Home", "End"].includes(event.key))
                            return;
                        event.preventDefault();
                        const length = clip.end - clip.start;
                        const delta = event.shiftKey ? 1 : 0.1;
                        const next = Math.max(
                            0,
                            Math.min(
                                clip.duration - length,
                                event.key === "Home"
                                    ? 0
                                    : event.key === "End"
                                      ? clip.duration - length
                                      : clip.start + (["ArrowLeft", "ArrowDown"].includes(event.key) ? -delta : delta),
                            ),
                        );
                        onRange(next, next + length);
                    }}
                />
                {(["start", "end"] as const).map((edge) => (
                    <button
                        key={edge}
                        type="button"
                        role="slider"
                        disabled={disabled}
                        className={styles.handle}
                        style={{ left: percent(clip[edge]) }}
                        aria-label={
                            edge === "start"
                                ? _t("desktop|soundboard|selection_start")
                                : _t("desktop|soundboard|selection_end")
                        }
                        aria-valuemin={
                            edge === "start" ? Math.max(0, clip.end - 10) : clip.start + Math.min(0.1, clip.duration)
                        }
                        aria-valuemax={
                            edge === "start" ? Math.max(0, clip.end - 0.1) : Math.min(clip.duration, clip.start + 10)
                        }
                        aria-valuenow={clip[edge]}
                        aria-valuetext={time(clip[edge])}
                        onPointerDown={(event) => beginDrag(event, edge)}
                        onPointerMove={moveDrag}
                        onPointerUp={() => {
                            drag.current = null;
                        }}
                        onPointerCancel={() => {
                            drag.current = null;
                        }}
                        onKeyDown={(event) => {
                            const delta = event.shiftKey ? 1 : 0.1;
                            if (
                                ["ArrowLeft", "ArrowDown", "ArrowRight", "ArrowUp", "Home", "End"].includes(event.key)
                            ) {
                                event.preventDefault();
                                setEdge(
                                    edge,
                                    event.key === "Home"
                                        ? 0
                                        : event.key === "End"
                                          ? clip.duration
                                          : clip[edge] +
                                            (["ArrowLeft", "ArrowDown"].includes(event.key) ? -delta : delta),
                                );
                            }
                        }}
                    />
                ))}
                {clip.playing && <div className={styles.playhead} style={{ left: percent(clip.position) }} />}
            </div>
            <div className={styles.timestamps} aria-hidden="true">
                <span>0:00.0</span>
                <span>{time(clip.duration)}</span>
            </div>
            <label className={styles.volume}>
                <Text as="span" size="xs">
                    {_t("desktop|soundboard|clip_volume")}
                </Text>
                <input
                    type="range"
                    min={0}
                    max={100}
                    step={1}
                    value={clip.volume}
                    disabled={disabled}
                    onChange={(event) => onVolume(Number(event.target.value))}
                />
                <Text as="span" size="xs">
                    {clip.volume}%
                </Text>
            </label>
            <div className={styles.controls}>
                <Button
                    ref={previewButton}
                    kind="secondary"
                    size="md"
                    onClick={onPreview}
                    disabled={disabled}
                    aria-label={
                        clip.playing
                            ? _t("desktop|soundboard|stop_preview")
                            : _t("desktop|soundboard|preview_selection")
                    }
                >
                    {clip.playing ? <PauseSolidIcon /> : <PlaySolidIcon />}
                    {time(clip.playing ? clip.position : clip.start)} – {time(clip.end)}
                </Button>
                <div className={styles.actions}>
                    <Button kind="tertiary" size="md" onClick={onCancel} disabled={disabled}>
                        {_t("action|cancel")}
                    </Button>
                    <Button size="md" onClick={onSave} disabled={disabled}>
                        {clip.editing ? _t("action|save") : _t("desktop|soundboard|upload_clip")}
                    </Button>
                </div>
            </div>
        </section>
    );
}
