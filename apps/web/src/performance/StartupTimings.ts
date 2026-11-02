/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { logger } from "matrix-js-sdk/src/logger";

/** The moments of startup that decide how soon someone sees their chats, in the order they normally happen. */
export type StartupStep =
    | "boot"
    | "app_loaded"
    | "client_starting"
    | "store_ready"
    | "crypto_ready"
    | "sync_starting"
    | "chats_from_cache"
    | "chats_shown";

const PREFIX = "aether:startup:";
const recorded = new Set<StartupStep>();

/**
 * Note that a startup step was reached. Each step is recorded once per page load, as a `performance.mark`, so it shows
 * up in a DevTools performance recording.
 */
export function markStartup(step: StartupStep): void {
    if (recorded.has(step)) return;
    recorded.add(step);
    try {
        performance.mark(PREFIX + step);
    } catch {
        // Marks are only diagnostics.
    }
    if (step === "chats_shown") logStartupTimings();
}

/** Milliseconds from page start to each recorded step. */
export function getStartupTimings(): Partial<Record<StartupStep, number>> {
    const timings: Partial<Record<StartupStep, number>> = {};
    try {
        for (const entry of performance.getEntriesByType("mark")) {
            if (!entry.name.startsWith(PREFIX)) continue;
            timings[entry.name.slice(PREFIX.length) as StartupStep] = Math.round(entry.startTime);
        }
    } catch {
        // Marks are only diagnostics.
    }
    return timings;
}

function logStartupTimings(): void {
    const timings = Object.entries(getStartupTimings())
        .map(([step, ms]) => `${step}=${ms}ms`)
        .join(" ");
    logger.info(`Startup timings: ${timings}`);
}
