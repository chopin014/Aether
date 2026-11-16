/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { logger } from "matrix-js-sdk/src/logger";
import { EventType, type MatrixClient, type Room } from "matrix-js-sdk/src/matrix";

import { loadElementCallComponent, prefetchElementCallTransport } from "./ElementCallLoader";
import { getCallOpenIdToken } from "./ElementCallOpenIdToken";
import { DesktopVoicePipeline } from "../../../audio/desktop/DesktopVoicePipeline";
import { preloadDesktopVoiceSounds } from "../../../audio/DesktopVoiceSounds";

/** Automatic preparation starts by then even if the scheduler never releases it, so calls are not left cold. */
const RELEASE_DEADLINE_MS = 30_000;

/** Background call token fetches: at most this many per window, so a long list of voice channels costs little. */
export const BACKGROUND_TOKEN_LIMIT = 6;
export const BACKGROUND_TOKEN_WINDOW_MS = 10 * 60_000;
/** A room's call token is not fetched again in the background for this long: it lasts an hour, and Element Call
 * replaces it 5 minutes before it expires. */
export const TOKEN_REFRESH_MS = 56 * 60_000;

/** How long a homeserver's CORS preflight answer is kept without `Access-Control-Max-Age` (Chromium's default). */
export const PREFLIGHT_CACHE_MS = 5_000;

/**
 * The URL the call membership is written to when joining a room's call, as the SDK builds it.
 * See `MembershipManager.makeMembershipStateKey`.
 */
function membershipStateKey(client: MatrixClient, room: Room): string | undefined {
    const userId = client.getUserId();
    const deviceId = client.getDeviceId();
    if (!userId || !deviceId) return undefined;
    const stateKey = `${userId}_${deviceId}_m.call`;
    return /^org\.matrix\.msc(3757|3779)\b/.test(room.getVersion()) ? stateKey : `_${stateKey}`;
}

/** Prepares again while preparation is active, for example when someone points at a voice channel. */
let prepareAgain: (() => void) | undefined;
/** Fetches a room's call token while preparation is active: now, or in the background when idle. */
let prefetchToken: ((room: Room, background: boolean) => void) | undefined;

/**
 * Get a call ready because someone is likely to join one soon, such as when they point at or focus a voice channel.
 * The prepared microphone expires when unused, so this keeps it ready without holding audio resources forever. Does
 * nothing unless the logged-in shell has started call preparation.
 *
 * @param room - The room whose call they would join: its call token is fetched too, so joining does not wait for
 *     the call service.
 */
export function prepareCallSoon(room?: Room): void {
    prepareAgain?.();
    if (room) prefetchToken?.(room, false);
}

/**
 * Fetch the call token for a room the user can see and may well call in, such as a voice channel in the list or the
 * conversation they are reading, when the app is idle. Fetches run one at a time, are limited per window, and skip
 * rooms fetched recently. Does nothing unless the logged-in shell has started call preparation.
 */
export function prepareCallInBackground(room: Room): void {
    prefetchToken?.(room, true);
}

/**
 * Prepare a desktop call during idle time, with cancellation on logout and no microphone capture. The account's call
 * OpenID token is fetched too, so joining only waits for the call service.
 * An optional scheduler holds automatic preparation, including re-preparation when the window regains focus, until
 * the scheduler releases it. Explicit voice intent through {@link prepareCallSoon} stays immediate.
 */
export function prepareElementCall(client: MatrixClient, schedule?: (start: () => void) => () => void): () => void {
    let disposed = false;
    let pipeline: DesktopVoicePipeline | undefined;
    const prepare = (): void => {
        if (disposed) return;
        void loadElementCallComponent().catch((error: unknown) =>
            logger.debug("Could not prepare Element Call", error),
        );
        preloadDesktopVoiceSounds();
        void getCallOpenIdToken(client).catch((error: unknown) =>
            logger.debug("Could not prepare a call OpenID token", error),
        );
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
    // Joining waits for the call service's token, which lasts an hour: fetch it when a call is likely.
    const fetchedAt = new Map<string, number>();
    const queue = new Map<string, Room>();
    const backgroundFetches: number[] = [];
    let fetching = false;
    let tokenIdle: number | undefined;
    let tokenTimer: ReturnType<typeof setTimeout> | undefined;
    const fetchToken = (room: Room): Promise<void> => {
        fetchedAt.set(room.roomId, Date.now());
        return prefetchElementCallTransport(client, room.roomId).catch((error: unknown) =>
            logger.debug("Could not prepare a call token", error),
        );
    };
    const drain = (): void => {
        if (disposed || !released || fetching) return;
        const now = Date.now();
        while (backgroundFetches.length && now - backgroundFetches[0] >= BACKGROUND_TOKEN_WINDOW_MS) {
            backgroundFetches.shift();
        }
        // Rooms fetched within the token's life need nothing; the first other one is next.
        let next: [string, Room] | undefined;
        for (const entry of queue) {
            if (now - (fetchedAt.get(entry[0]) ?? -Infinity) >= TOKEN_REFRESH_MS) {
                next = entry;
                break;
            }
            queue.delete(entry[0]);
        }
        if (!next) return;
        if (backgroundFetches.length >= BACKGROUND_TOKEN_LIMIT) {
            // Try again once the oldest fetch leaves the window.
            clearTimeout(tokenTimer);
            tokenTimer = setTimeout(drain, backgroundFetches[0] + BACKGROUND_TOKEN_WINDOW_MS - now);
            return;
        }
        const [roomId, room] = next;
        queue.delete(roomId);
        fetching = true;
        backgroundFetches.push(now);
        const run = (): void => {
            tokenIdle = tokenTimer = undefined;
            if (disposed) return;
            void fetchToken(room).finally(() => {
                fetching = false;
                drain();
            });
        };
        if (typeof requestIdleCallback === "function") tokenIdle = requestIdleCallback(run, { timeout: 5000 });
        else tokenTimer = setTimeout(run, 0);
    };
    // Every write to the homeserver waits for a CORS preflight first (~220 ms on matrix.org), which the browser keeps
    // for PREFLIGHT_CACHE_MS per URL. Reading the membership state URL when someone is about to join has that answer
    // ready for the join's membership write to the same URL.
    const preflightWarmedAt = new Map<string, number>();
    const warmMembershipWrite = (room: Room): void => {
        const stateKey = membershipStateKey(client, room);
        const now = Date.now();
        if (!stateKey || now - (preflightWarmedAt.get(room.roomId) ?? -Infinity) < PREFLIGHT_CACHE_MS - 1_000) return;
        preflightWarmedAt.set(room.roomId, now);
        void client.getStateEvent(room.roomId, EventType.GroupCallMemberPrefix, stateKey).catch(() => {
            // No membership there yet is the usual answer; only the preflight matters.
        });
    };
    const prefetch = (room: Room, background: boolean): void => {
        if (disposed) return;
        if (!background) {
            warmMembershipWrite(room);
            void fetchToken(room);
            return;
        }
        queue.set(room.roomId, room);
        drain();
    };
    const startIdle = (): void => {
        if (disposed || released) return;
        released = true;
        clearTimeout(deadline);
        // Background token fetches queued before release start with it.
        drain();
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

    prefetchToken = prefetch;

    return () => {
        disposed = true;
        cancelScheduled?.();
        clearTimeout(deadline);
        if (idle !== undefined) cancelIdleCallback(idle);
        clearTimeout(timer);
        window.removeEventListener("focus", onReturn);
        document.removeEventListener("visibilitychange", onReturn);
        if (prepareAgain === prepare) prepareAgain = undefined;
        if (prefetchToken === prefetch) prefetchToken = undefined;
        queue.clear();
        if (tokenIdle !== undefined) cancelIdleCallback(tokenIdle);
        clearTimeout(tokenTimer);
        pipeline?.cancelPreparation();
    };
}
