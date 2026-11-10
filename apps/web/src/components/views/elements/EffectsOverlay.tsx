/*
Copyright 2024 New Vector Ltd.
Copyright 2020 Nurjin Jafar
Copyright 2020 Nordeck IT + Consulting GmbH.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
 */
import React, { type FunctionComponent, useCallback, useEffect, useRef, useState } from "react";
import { logger } from "matrix-js-sdk/src/logger";
import { type MatrixEvent } from "matrix-js-sdk/src/matrix";

import dis from "../../../dispatcher/dispatcher";
import type ICanvasEffect from "../../../effects/ICanvasEffect";
import { CHAT_EFFECTS } from "../../../effects";
import UIStore, { UI_EVENTS } from "../../../stores/UIStore";

interface IProps {
    /** The room view the effects play across: the canvas is as wide as it is. */
    room: HTMLElement;
}

const EffectsOverlay: FunctionComponent<IProps> = ({ room }) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const effectsRef = useRef<Map<string, ICanvasEffect>>(new Map<string, ICanvasEffect>());
    const [roomWidth, setRoomWidth] = useState(0);
    // Effects asked for before the room was first measured. They place themselves across the canvas as they start,
    // so they wait for it to be as wide as the room.
    const measuredRef = useRef(false);
    const waitingRef = useRef(new Set<string>());

    // The room is measured as the browser lays it out. Read while rendering, its width would make the browser lay
    // the page out there and then: in the middle of opening a room, that is the whole new room.
    useEffect(() => {
        const observer = new ResizeObserver(([entry]) => {
            setRoomWidth(Math.round(entry.borderBoxSize?.[0]?.inlineSize ?? entry.contentRect.width));
        });
        observer.observe(room, { box: "border-box" });
        return () => observer.disconnect();
    }, [room]);

    const startEffect = useCallback((name: string): void => {
        const load = async (): Promise<ICanvasEffect | null> => {
            let effect: ICanvasEffect | null = effectsRef.current.get(name) || null;
            if (effect === null) {
                const definition = CHAT_EFFECTS.find((e) => e.command === name)!;
                try {
                    effect = await definition.getRenderer();
                    effectsRef.current.set(name, effect);
                } catch (err) {
                    logger.warn(`Unable to run effect module.`, err);
                }
            }
            return effect;
        };
        if (!name) return;
        void load().then((module) => module?.start(canvasRef.current!));
    }, []);

    // The canvas has the room's width from this commit on: start whatever was waiting for it.
    useEffect(() => {
        if (roomWidth === 0) return;
        measuredRef.current = true;
        const waiting = [...waitingRef.current];
        waitingRef.current.clear();
        for (const name of waiting) startEffect(name);
    }, [roomWidth, startEffect]);

    useEffect(() => {
        const resize = (): void => {
            if (canvasRef.current && canvasRef.current?.height !== UIStore.instance.windowHeight) {
                canvasRef.current.height = UIStore.instance.windowHeight;
            }
        };
        const onAction = (payload: { action: string; event?: MatrixEvent }): void => {
            const actionPrefix = "effects.";
            const isOutdated = isEventOutdated(payload.event);
            if (canvasRef.current && payload.action.startsWith(actionPrefix) && !isOutdated) {
                const effect = payload.action.slice(actionPrefix.length);
                if (measuredRef.current) startEffect(effect);
                else waitingRef.current.add(effect);
            }
        };
        const dispatcherRef = dis.register(onAction);
        const canvas = canvasRef.current;
        if (canvas) canvas.height = UIStore.instance.windowHeight;
        UIStore.instance.on(UI_EVENTS.Resize, resize);

        const currentEffects = effectsRef.current; // this is not a react node ref, warning can be safely ignored
        return () => {
            dis.unregister(dispatcherRef);
            UIStore.instance.off(UI_EVENTS.Resize, resize);
            for (const effect in currentEffects) {
                const effectModule: ICanvasEffect = currentEffects.get(effect)!;
                if (effectModule && effectModule.isRunning) {
                    void effectModule.stop();
                }
            }
        };
    }, [startEffect]);

    return (
        <canvas
            ref={canvasRef}
            width={roomWidth}
            style={{
                display: "block",
                zIndex: 999999,
                pointerEvents: "none",
                position: "fixed",
                top: 0,
                right: 0,
            }}
            aria-hidden={true}
        />
    );
};

export default EffectsOverlay;

// 48 hours
// 48h * 60m * 60s * 1000ms
const OUTDATED_EVENT_THRESHOLD = 48 * 60 * 60 * 1000;

/**
 * Return true if the event is older than 48h.
 * @param event
 */
function isEventOutdated(event?: MatrixEvent): boolean {
    if (!event) return false;

    const nowTs = Date.now();
    const eventTs = event.getTs();
    return nowTs - eventTs > OUTDATED_EVENT_THRESHOLD;
}
