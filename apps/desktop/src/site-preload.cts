/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/// <reference lib="dom" />

// Runs in every frame of a website watched together, in its own isolated world: the page cannot see or call it.
// It finds the video the page is about, reports what that video does, and plays, pauses or seeks it on request.
// It is compiled to CommonJS and may only use Electron's modules, as sandboxed preloads require.

import { ipcRenderer, webFrame } from "electron";

/** Short or tiny videos (previews, adverts, animated backgrounds) should lose to the main one. */
const MIN_WIDTH = 120;
const MIN_HEIGHT = 68;
/** A live stream has no length; score it as an hour-long video. */
const LIVE_DURATION = 3600;
const SCAN_MS = 1000;
/** Looking inside shadow roots walks the whole page, so it happens less often. */
const SHADOW_SCAN_EVERY = 3;
const REPORT_MS = 1000;

/** How likely a video is the one people mean to watch: big, long and actually showing. */
export function videoScore(video: HTMLVideoElement): number {
    if (!video.isConnected || video.readyState === 0) return 0;
    const box = video.getBoundingClientRect();
    if (box.width < MIN_WIDTH || box.height < MIN_HEIGHT) return 0;
    const style = getComputedStyle(video);
    if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") return 0;
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : LIVE_DURATION;
    const area = (video.videoWidth || box.width) * (video.videoHeight || box.height);
    return area * (duration + 1);
}

/** Every video in a document, including those inside open shadow roots when asked to look. */
export function findVideos(root: Document | ShadowRoot, deep: boolean): HTMLVideoElement[] {
    const videos = [...root.querySelectorAll("video")];
    if (deep) {
        for (const element of root.querySelectorAll("*")) {
            if (element.shadowRoot) videos.push(...findVideos(element.shadowRoot, true));
        }
    }
    return videos;
}

/** The highest-scoring video, keeping the current one unless another clearly beats it. */
export function pickVideo(
    videos: HTMLVideoElement[],
    current: HTMLVideoElement | null,
): { video: HTMLVideoElement | null; score: number } {
    let best: HTMLVideoElement | null = null;
    let score = 0;
    for (const video of videos) {
        const value = videoScore(video);
        if (value > score) {
            best = video;
            score = value;
        }
    }
    const currentScore = current ? videoScore(current) : 0;
    if (current && currentScore > 0 && score <= currentScore * 2) return { video: current, score: currentScore };
    return { video: best, score };
}

export function videoState(video: HTMLVideoElement): {
    paused: boolean;
    ended: boolean;
    buffering: boolean;
    time: number;
    duration: number | null;
    rate: number;
} {
    return {
        paused: video.paused,
        ended: video.ended,
        buffering: !video.paused && video.readyState < 3,
        time: video.currentTime,
        duration: Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null,
        rate: video.playbackRate,
    };
}

/** Netflix's player breaks when its video element is seeked directly; its own player API seeks safely. */
function netflixSeek(seconds: number): boolean {
    if (!/(^|\.)netflix\.com$/.test(location.hostname)) return false;
    void webFrame
        .executeJavaScript(
            `(() => { const p = window.netflix.appContext.state.playerApp.getAPI().videoPlayer;` +
                ` const id = p.getAllPlayerSessionIds().find((s) => s.includes("watch"));` +
                ` p.getVideoPlayerBySessionId(id).seek(${Math.round(seconds * 1000)}); })()`,
        )
        .catch(() => {});
    return true;
}

function start(): void {
    let video: HTMLVideoElement | null = null;
    let score = 0;
    let scans = 0;
    let lastReport = 0;
    let volume = 1;
    const abort = { controller: new AbortController() };

    const report = (event?: string): void => {
        lastReport = Date.now();
        ipcRenderer.send("aether:site-frame", {
            score,
            video: video ? videoState(video) : null,
            ...(event ? { event } : {}),
        });
    };

    const watch = (next: HTMLVideoElement | null): void => {
        abort.controller.abort();
        abort.controller = new AbortController();
        video = next;
        if (!video) return;
        video.volume = volume;
        video.muted = volume === 0;
        const signal = abort.controller.signal;
        const on = (name: string, event?: string): void =>
            video!.addEventListener(name, () => report(event), { signal });
        on("playing", "playing");
        on("pause", "paused");
        on("seeked", "seeked");
        on("ended", "ended");
        on("ratechange", "ratechange");
        on("durationchange");
        on("waiting");
    };

    const scan = (): void => {
        const picked = pickVideo(findVideos(document, scans++ % SHADOW_SCAN_EVERY === 0), video);
        const changed = picked.video !== video || picked.score > 0 !== score > 0;
        score = picked.score;
        if (picked.video !== video) watch(picked.video);
        if (changed || (video && Date.now() - lastReport >= REPORT_MS)) report();
    };

    ipcRenderer.on("aether:site-command", (_event, command: Record<string, unknown>) => {
        if (typeof command?.volume === "number") {
            volume = Math.max(0, Math.min(1, command.volume));
            if (video) {
                video.volume = volume;
                video.muted = volume === 0;
            }
        }
        if (!video) return;
        if (command.play === true) void video.play().catch(() => {});
        else if (command.pause === true) video.pause();
        else if (typeof command.seek === "number" && Number.isFinite(command.seek)) {
            if (!netflixSeek(command.seek)) video.currentTime = Math.max(0, command.seek);
        } else if (typeof command.rate === "number" && Number.isFinite(command.rate)) {
            video.playbackRate = command.rate;
        }
    });

    setInterval(scan, SCAN_MS);
    scan();
}

// Only in a page loaded into the site view, never when imported by tests.
if (typeof process !== "undefined" && process.type === "renderer") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
    else start();
}
