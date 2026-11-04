/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { logger } from "matrix-js-sdk/src/logger";

import { loadElementCallComponent } from "./ElementCallLoader";
import { DesktopVoicePipeline } from "../../../audio/desktop/DesktopVoicePipeline";
import { preloadDesktopVoiceSounds } from "../../../audio/DesktopVoiceSounds";

/** Automatic preparation starts by then even if the scheduler never releases it, so calls are not left cold. */
const RELEASE_DEADLINE_MS = 30_000;

/** Prepares again while preparation is active, for example when someone points at a voice channel. */
let prepareAgain: (() => void) | undefined;

/**
 * Get a call ready because someone is likely to join one soon, such as when they point at or focus a voice channel.
 * The prepared microphone expires when unused, so this keeps it ready without holding audio resources forever. Does
 * nothing unless the logged-in shell has started call preparation.
 */
export function prepareCallSoon(): void {
    prepareAgain?.();
}

/**
 * Prepare a desktop call during idle time, with cancellation on logout and no microphone capture.
 * An optional scheduler holds automatic preparation, including re-preparation when the window regains focus, until
 * the scheduler releases it. Explicit voice intent through {@link prepareCallSoon} stays immediate.
 */
export function prepareElementCall(schedule?: (start: () => void) => () => void): () => void {
    let disposed = false;
    let pipeline: DesktopVoicePipeline | undefined;
    const prepare = (): void => {
        if (disposed) return;
        void loadElementCallComponent().catch((error: unknown) =>
            logger.debug("Could not prepare Element Call", error),
        );
        preloadDesktopVoiceSounds();
        try {
            pipeline = DesktopVoicePipeline.instance;
            pipeline.prepare();
        } catch (error) {
            logger.debug("Could not prepare the microphone processor", error);
        }
    };
    let idle: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Automatic preparation is held until the scheduler releases it, so startup work is not loaded early.
    let released = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const startIdle = (): void => {
        if (disposed || released) return;
        released = true;
        clearTimeout(deadline);
        idle = typeof requestIdleCallback === "function" ? requestIdleCallback(prepare, { timeout: 3000 }) : undefined;
        timer = idle === undefined ? setTimeout(prepare, 1000) : undefined;
    };
    const cancelScheduled = schedule?.(startIdle);
    // The scheduler may already have released preparation synchronously.
    if (!schedule) startIdle();
    else if (!released) deadline = setTimeout(startIdle, RELEASE_DEADLINE_MS);

    // Coming back to the app is a good moment to replace a prepared microphone that expired meanwhile.
    const onReturn = (): void => {
        if (released && document.visibilityState === "visible") prepare();
    };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    prepareAgain = prepare;

    return () => {
        disposed = true;
        cancelScheduled?.();
        clearTimeout(deadline);
        if (idle !== undefined) cancelIdleCallback(idle);
        clearTimeout(timer);
        window.removeEventListener("focus", onReturn);
        document.removeEventListener("visibilitychange", onReturn);
        if (prepareAgain === prepare) prepareAgain = undefined;
        pipeline?.cancelPreparation();
    };
}
