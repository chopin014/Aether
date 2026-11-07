/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type CSSProperties, type JSX, useEffect, useRef } from "react";

import { makeLayer, type Ctx } from "./artKit";

/**
 * Bakes part of a scene once per size and keeps it, so a still frame or an animation only composites prepared layers.
 * The layer is drawn in CSS pixels; its canvas is sized for the screen's pixel density.
 */
export type Bake = (
    key: string,
    paint: (ctx: CanvasRenderingContext2D, width: number, height: number) => void,
) => HTMLCanvasElement | undefined;

/** One frame of a scene. Everything is a function of time, so any moment can be drawn directly. */
export interface ArtFrame {
    ctx: Ctx;
    /** Size in CSS pixels. */
    width: number;
    height: number;
    /** Seconds since the scene started. */
    t: number;
    bake: Bake;
}

/** A piece of procedural artwork. */
export interface ArtScene {
    /** Identifies the scene in the shared layer cache. */
    id: string;
    /** The moment shown while the artwork is still, chosen to look complete. */
    rest: number;
    /** Draw a frame. */
    draw(frame: ArtFrame): void;
}

/** Baked layers shared by every canvas showing the same scene at the same size, such as a member list's rows. */
const layers = new Map<string, HTMLCanvasElement>();
const MAX_LAYERS = 96;

function bakeFor(sceneId: string, width: number, height: number, ratio: number): Bake {
    return (key, paint) => {
        const id = `${sceneId}/${key}/${width}x${height}@${ratio}`;
        let canvas = layers.get(id);
        if (!canvas) {
            const layer = makeLayer(width * ratio, height * ratio);
            if (!layer) return undefined;
            layer.ctx.scale(ratio, ratio);
            paint(layer.ctx, width, height);
            canvas = layer.canvas;
            if (layers.size >= MAX_LAYERS) layers.delete(layers.keys().next().value!);
            layers.set(id, canvas);
        }
        return canvas;
    };
}

interface ArtCanvasProps {
    scene: ArtScene;
    /** The artwork moves. When false it shows its still frame. */
    live: boolean;
    className?: string;
    style?: CSSProperties;
    /** Frames per second while moving. Small art reads as smooth at less than the display's rate. */
    fps?: number;
    /**
     * Where the animation starts when it is live from the moment it appears. A negative time delays it, as a card's
     * effect waits a moment after the card opens. A still canvas always shows the scene's rest frame.
     */
    from?: number;
}

/**
 * Draws a scene into a canvas the size of its box, sharp at the screen's pixel density. Still, it draws one frame and
 * stops; live, it animates from that same frame, so starting and stopping never jump. Nothing runs while the page is
 * hidden.
 */
export function ArtCanvas({ scene, live, className, style, fps = 60, from }: ArtCanvasProps): JSX.Element {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    // Where the animation stopped, so the next start continues from there instead of restarting.
    const clock = useRef<number | undefined>(undefined);
    const shownScene = useRef(scene);

    useEffect(() => {
        if (shownScene.current !== scene) {
            shownScene.current = scene;
            clock.current = undefined;
        }
        clock.current ??= live ? (from ?? scene.rest) : scene.rest;
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext("2d");
        if (!canvas || !ctx) return;
        let width = 0;
        let height = 0;
        let ratio = 1;
        let frame = 0;
        let last = 0;
        let lastDrawn = 0;
        const interval = 1000 / fps;

        const draw = (): void => {
            if (!width || !height) return;
            ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
            ctx.clearRect(0, 0, width, height);
            scene.draw({
                ctx,
                width,
                height,
                t: clock.current ?? scene.rest,
                bake: bakeFor(scene.id, width, height, ratio),
            });
        };

        const tick = (now: number): void => {
            frame = requestAnimationFrame(tick);
            if (document.hidden) {
                last = now;
                return;
            }
            if (last) clock.current = (clock.current ?? scene.rest) + Math.min(0.1, (now - last) / 1000);
            last = now;
            if (now - lastDrawn < interval - 2) return;
            lastDrawn = now;
            draw();
        };

        const resize = (): void => {
            const box = canvas.getBoundingClientRect();
            const nextWidth = Math.round(box.width);
            const nextHeight = Math.round(box.height);
            // Twice the pixels is sharp on any screen; more costs memory without a visible gain.
            const nextRatio = Math.min(2, window.devicePixelRatio || 1);
            if (nextWidth === width && nextHeight === height && nextRatio === ratio) return;
            width = nextWidth;
            height = nextHeight;
            ratio = nextRatio;
            canvas.width = Math.max(1, Math.round(width * ratio));
            canvas.height = Math.max(1, Math.round(height * ratio));
            draw();
        };

        resize();
        const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(resize);
        observer?.observe(canvas);
        if (live) frame = requestAnimationFrame(tick);
        return () => {
            observer?.disconnect();
            cancelAnimationFrame(frame);
        };
    }, [scene, live, fps, from]);

    return <canvas ref={canvasRef} className={className} style={style} aria-hidden="true" />;
}
