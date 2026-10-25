/*
Copyright 2023, 2024 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import type { DesktopCapturerSource, Streams } from "electron";

type DisplayMediaCallback = (streams: Streams) => void;

let displayMediaCallback: DisplayMediaCallback | null = null;
const displayMediaSources = new Map<string, DesktopCapturerSource>();

export const setDisplayMediaCallback = (callback: DisplayMediaCallback | null): void => {
    const previous = displayMediaCallback;
    displayMediaCallback = callback;
    displayMediaSources.clear();
    previous?.({ video: { id: "", name: "" } });
};

/** Keep native sources in main; renderer metadata cannot authorize a different source. */
export const setDisplayMediaSources = (sources: DesktopCapturerSource[]): void => {
    if (!displayMediaCallback) return;
    displayMediaSources.clear();
    for (const source of sources) displayMediaSources.set(source.id, source);
};

/** Look up a renderer selection in the pending picker results. */
export const getDisplayMediaSource = (id: unknown): DesktopCapturerSource | undefined => {
    return typeof id === "string" ? displayMediaSources.get(id) : undefined;
};

/**
 * Atomically read and clear the pending display-media callback.
 *
 * The screen-share request handler stores a single callback per request (see
 * electron-main.ts). Reading-and-clearing in one step guarantees consume-once
 * semantics: a duplicate or stale `callDisplayMediaCallback` IPC — e.g. left over
 * from the macOS 15+ native picker path, which never consumes it via the renderer —
 * resolves to `null` and becomes a safe no-op instead of invoking a stale callback twice.
 */
export const consumeDisplayMediaCallback = (): DisplayMediaCallback | null => {
    const callback = displayMediaCallback;
    displayMediaCallback = null;
    displayMediaSources.clear();
    return callback;
};
