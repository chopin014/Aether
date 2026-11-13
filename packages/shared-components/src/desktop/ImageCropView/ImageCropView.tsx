/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, {
    type CSSProperties,
    type JSX,
    type KeyboardEvent,
    type PointerEvent,
    useEffect,
    useId,
    useRef,
} from "react";
import { Button, IconButton, InlineSpinner, Text } from "@vector-im/compound-web";
import RotateRightIcon from "@vector-im/compound-design-tokens/assets/web/icons/rotate-right";
import ZoomInIcon from "@vector-im/compound-design-tokens/assets/web/icons/zoom-in";
import ZoomOutIcon from "@vector-im/compound-design-tokens/assets/web/icons/zoom-out";

import { type ViewModel, useViewModel } from "../../core/viewmodel";
import { _t } from "../../core/i18n/i18n";
import { cropSize, turnedImageSize, type ImageCropRotation } from "./cropGeometry";
import styles from "./ImageCropView.module.css";

/** How the result is shown: a round avatar, a rounded square icon, or a wide rectangle such as a banner. */
export type ImageCropShape = "circle" | "rounded" | "rectangle";

/** Everything the image editor renders. */
export interface ImageCropViewSnapshot {
    /** Address of the picked image. */
    imageUrl: string;
    /** Width of the image as stored, before turning. */
    imageWidth: number;
    /** Height of the image as stored, before turning. */
    imageHeight: number;
    shape: ImageCropShape;
    /** Width over height of the kept area. */
    aspectRatio: number;
    rotation: ImageCropRotation;
    /** 1 fits the image to the kept area; larger values show less of it. */
    zoom: number;
    maxZoom: number;
    /** Centre of the kept area, as a fraction of the turned image's width. */
    centreX: number;
    /** Centre of the kept area, as a fraction of the turned image's height. */
    centreY: number;
    /** The image moves, and editing it keeps only a still frame. */
    animated: boolean;
    /**
     * The image moves and its framing is applied wherever it is shown, so it keeps moving. It cannot be turned, as
     * turning would mean redrawing it.
     */
    keepsAnimation?: boolean;
    /** The edited image is being made. */
    busy: boolean;
    /** Why the edited image could not be made, ready to show. */
    error?: string;
}

/** What the image editor can ask for. */
export interface ImageCropViewActions {
    setZoom(this: void, zoom: number): void;
    /** Move the kept area by fractions of the turned image. */
    moveBy(this: void, x: number, y: number): void;
    /** Turn the image a quarter clockwise. */
    rotate(this: void): void;
    /** Go back to the whole image, unturned and centred. */
    reset(this: void): void;
    /** Keep the chosen area. */
    apply(this: void): void;
    /** Use the picked file as it is, keeping its animation. */
    keepOriginal(this: void): void;
    cancel(this: void): void;
}

/** Contract for the image editor. */
export type ImageCropViewModel = ViewModel<ImageCropViewSnapshot, ImageCropViewActions>;

const ZOOM_STEP = 0.1;
/** How far one arrow key press moves the image, as a fraction of the kept area. */
const NUDGE = 0.05;

/**
 * Lets a person choose which part of an image to keep before it becomes an avatar, icon or banner: drag to move it,
 * zoom with the slider, the wheel or + and -, and turn it a quarter at a time. The host supplies the dialog title.
 */
export function ImageCropView({ vm }: { /** The editor's model. */ vm: ImageCropViewModel }): JSX.Element {
    const s = useViewModel(vm);
    const hintId = useId();
    const stage = useRef<HTMLDivElement>(null);
    const imageBox = useRef<HTMLDivElement>(null);
    const drag = useRef<{ pointer: number; x: number; y: number } | null>(null);

    const kept = cropSize(s);
    const turned = turnedImageSize(s);
    const quarter = s.rotation % 2 === 1;
    // The image box is the turned image; the picture inside it is turned with CSS around its own centre.
    const pictureWidth = quarter ? (turned.height / turned.width) * 100 : 100;
    const pictureHeight = quarter ? (turned.width / turned.height) * 100 : 100;

    // The wheel zooms instead of scrolling the dialog, which needs a listener that may cancel the scroll.
    const zoom = useRef(s.zoom);
    zoom.current = s.zoom;
    useEffect(() => {
        const element = stage.current;
        if (!element) return;
        const onWheel = (event: WheelEvent): void => {
            event.preventDefault();
            vm.setZoom(zoom.current * Math.exp(-event.deltaY * 0.002));
        };
        element.addEventListener("wheel", onWheel, { passive: false });
        return () => element.removeEventListener("wheel", onWheel);
    }, [vm]);

    const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
        if (s.busy || event.button !== 0) return;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY };
    };
    const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
        const start = drag.current;
        const box = imageBox.current?.getBoundingClientRect();
        if (!start || start.pointer !== event.pointerId || !box?.width || !box.height) return;
        // Dragging the picture right shows more of its left side.
        vm.moveBy(-(event.clientX - start.x) / box.width, -(event.clientY - start.y) / box.height);
        drag.current = { ...start, x: event.clientX, y: event.clientY };
    };
    const onPointerEnd = (event: PointerEvent<HTMLDivElement>): void => {
        if (drag.current?.pointer === event.pointerId) drag.current = null;
    };
    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
        const moves: Record<string, [number, number]> = {
            ArrowLeft: [-kept.width * NUDGE, 0],
            ArrowRight: [kept.width * NUDGE, 0],
            ArrowUp: [0, -kept.height * NUDGE],
            ArrowDown: [0, kept.height * NUDGE],
        };
        if (moves[event.key]) {
            vm.moveBy(...moves[event.key]);
        } else if (event.key === "+" || event.key === "=") {
            vm.setZoom(s.zoom + ZOOM_STEP);
        } else if (event.key === "-") {
            vm.setZoom(s.zoom - ZOOM_STEP);
        } else {
            return;
        }
        event.preventDefault();
    };

    return (
        <div className={styles.editor} aria-busy={s.busy}>
            {/* The working area is moved with the arrow keys, so it must take focus; no built-in control moves in two directions. */}
            <div
                ref={stage}
                className={styles.stage}
                role="application"
                // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex
                tabIndex={0}
                aria-label={_t("desktop|image_crop|position")}
                aria-describedby={hintId}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerEnd}
                onPointerCancel={onPointerEnd}
                onKeyDown={onKeyDown}
            >
                <span id={hintId} className={styles.hint}>
                    {_t("desktop|image_crop|position_hint")}
                </span>
                <div
                    className={styles.frame}
                    data-shape={s.shape}
                    style={{ "--aspect": s.aspectRatio } as CSSProperties}
                >
                    <div
                        ref={imageBox}
                        className={styles.imageBox}
                        style={{
                            width: `${100 / kept.width}%`,
                            height: `${100 / kept.height}%`,
                            left: `${(0.5 - s.centreX / kept.width) * 100}%`,
                            top: `${(0.5 - s.centreY / kept.height) * 100}%`,
                        }}
                    >
                        <img
                            className={styles.picture}
                            src={s.imageUrl}
                            alt=""
                            draggable={false}
                            style={{
                                width: `${pictureWidth}%`,
                                height: `${pictureHeight}%`,
                                left: `${(100 - pictureWidth) / 2}%`,
                                top: `${(100 - pictureHeight) / 2}%`,
                                transform: `rotate(${s.rotation * 90}deg)`,
                            }}
                        />
                    </div>
                    <div className={styles.mask} aria-hidden="true" />
                </div>
            </div>

            <div className={styles.tools}>
                <div className={styles.zoom}>
                    <ZoomOutIcon className={styles.zoomIcon} aria-hidden="true" />
                    <input
                        type="range"
                        className={styles.slider}
                        aria-label={_t("desktop|image_crop|zoom")}
                        aria-valuetext={`${Math.round(s.zoom * 100)}%`}
                        min={1}
                        max={s.maxZoom}
                        step={0.01}
                        value={s.zoom}
                        disabled={s.busy}
                        style={{ "--position": `${((s.zoom - 1) / (s.maxZoom - 1)) * 100}%` } as CSSProperties}
                        onChange={(event) => vm.setZoom(Number(event.target.value))}
                    />
                    <ZoomInIcon className={styles.zoomIcon} aria-hidden="true" />
                </div>
                <IconButton
                    size="32px"
                    tooltip={_t("desktop|image_crop|rotate")}
                    disabled={s.busy || s.keepsAnimation}
                    onClick={vm.rotate}
                >
                    <RotateRightIcon />
                </IconButton>
            </div>

            {s.animated && s.keepsAnimation && (
                <Text as="p" size="sm" className={styles.notice}>
                    {_t("desktop|image_crop|animation_kept")}
                </Text>
            )}
            {s.animated && !s.keepsAnimation && (
                <div className={styles.notice}>
                    <Text as="p" size="sm">
                        {_t("desktop|image_crop|animated")}
                    </Text>
                    <Button size="md" kind="secondary" disabled={s.busy} onClick={vm.keepOriginal}>
                        {_t("desktop|image_crop|keep_original")}
                    </Button>
                </div>
            )}

            {s.error && (
                <Text as="p" size="sm" role="alert" className={styles.error}>
                    {s.error}
                </Text>
            )}

            <div className={styles.actions}>
                <Button kind="tertiary" size="md" className={styles.reset} disabled={s.busy} onClick={vm.reset}>
                    {_t("desktop|image_crop|reset")}
                </Button>
                <Button kind="secondary" size="md" disabled={s.busy} onClick={vm.cancel}>
                    {_t("action|cancel")}
                </Button>
                <Button kind="primary" size="md" disabled={s.busy} onClick={vm.apply}>
                    {s.busy && <InlineSpinner />}
                    {_t("desktop|image_crop|apply")}
                </Button>
            </div>
        </div>
    );
}
