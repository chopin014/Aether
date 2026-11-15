/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import type { WatchItem } from "./WatchTogetherProtocol";
import type { WatchPlayer, WatchPlayerError, WatchPlayerEvent, WatchPlayerStatus } from "./WatchPlayer";

export const YOUTUBE_EMBED_ORIGIN = "https://www.youtube.com";

/** YouTube's player states, as its embed reports them. */
const YouTubeState = {
    Unstarted: -1,
    Ended: 0,
    Playing: 1,
    Paused: 2,
    Buffering: 3,
} as const;

/** YouTube's error codes, from its player API reference. */
function mapError(code: unknown): WatchPlayerError {
    if (code === 101 || code === 150) return "not_embeddable";
    if (code === 2 || code === 100) return "not_found";
    return "unplayable";
}

/** How often to repeat the handshake until the embed answers; it ignores messages sent before its script runs. */
const HANDSHAKE_INTERVAL_MS = 250;

/**
 * The official YouTube embed, driven through the same `postMessage` interface YouTube's own IFrame API script uses.
 * Loading that script into the app would run YouTube's code next to the user's Matrix session, so this talks to
 * the embed directly instead; the embed stays in its own cross-origin frame.
 *
 * The embed is shown without YouTube's controls: the call stage draws its own, so every change goes through the
 * shared session. A click on the video still pauses it, which the session hears about as a `paused` event.
 */
export class YouTubeEmbedPlayer implements WatchPlayer {
    public readonly source = "youtube";
    public readonly element: HTMLDivElement;
    private readonly iframe: HTMLIFrameElement;
    private readonly listeners = new Set<(event: WatchPlayerEvent) => void>();
    private item: WatchItem | null = null;
    private connected = false;
    private handshake?: ReturnType<typeof setInterval>;
    private queue: { func: string; args: unknown[] }[] = [];
    private state: number = YouTubeState.Unstarted;
    private time: number | null = null;
    private timeAt = 0;
    private duration: number | null = null;
    private rate = 1;
    private title?: string;
    private error?: WatchPlayerError;
    private volume = 1;
    private loads = 0;
    private disposed = false;
    /** The window the embed reports to: the one its frame is in, which changes when the call pops out. */
    private listeningWindow: Window | null = null;

    public constructor(
        private readonly now: () => number = () => performance.now(),
        private readonly win: Window = window,
    ) {
        this.element = win.document.createElement("div");
        this.element.className = "mx_WatchTogether_youtube";
        // The rule reads this DOM call as React's createElement; the sandbox is set on the element just below.
        // oxlint-disable-next-line react/iframe-missing-sandbox
        this.iframe = win.document.createElement("iframe");
        this.iframe.allow = "autoplay; encrypted-media; picture-in-picture";
        // YouTube's player needs its scripts and its own origin; links it opens go to the browser.
        this.iframe.setAttribute(
            "sandbox",
            "allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox",
        );
        this.iframe.referrerPolicy = "strict-origin-when-cross-origin";
        this.iframe.setAttribute("frameborder", "0");
        this.iframe.style.cssText = "width:100%;height:100%;border:0;display:block;";
        this.iframe.addEventListener("load", this.onFrameLoad);
        this.element.appendChild(this.iframe);
        this.listenOn(win);
    }

    public get itemId(): string | null {
        return this.item?.id ?? null;
    }

    public load(item: WatchItem, position: number, play: boolean): void {
        if (this.disposed) return;
        this.item = item;
        this.state = YouTubeState.Unstarted;
        this.time = position;
        this.timeAt = this.now();
        this.duration = null;
        this.title = undefined;
        this.error = undefined;
        this.iframe.title = item.title ?? "YouTube";
        if (!this.iframe.src) {
            this.iframe.src = this.embedUrl(item.ref, position);
            this.queue = [];
            if (play) this.command("playVideo");
            else this.command("pauseVideo");
        } else {
            const args = [{ videoId: item.ref, startSeconds: position }];
            this.command(play ? "loadVideoById" : "cueVideoById", args);
        }
        this.emit("status");
    }

    public play(): void {
        this.command("playVideo");
    }

    public pause(): void {
        this.command("pauseVideo");
    }

    public seek(position: number): void {
        this.time = position;
        this.timeAt = this.now();
        this.command("seekTo", [position, true]);
    }

    public setRate(rate: number): void {
        this.command("setPlaybackRate", [rate]);
    }

    public setVolume(volume: number): void {
        this.volume = Math.max(0, Math.min(1, volume));
        this.command("setVolume", [Math.round(this.volume * 100)]);
        this.command(this.volume === 0 ? "mute" : "unMute");
    }

    public status(): WatchPlayerStatus {
        const playing = this.state === YouTubeState.Playing || this.state === YouTubeState.Buffering;
        let time = this.time;
        if (time !== null && this.state === YouTubeState.Playing) {
            time += ((this.now() - this.timeAt) / 1000) * this.rate;
            if (this.duration) time = Math.min(time, this.duration);
        }
        return {
            ready: this.connected,
            playing,
            buffering: this.state === YouTubeState.Buffering,
            time,
            duration: this.duration,
            rate: this.rate,
            title: this.title,
            hasVideo: true,
            error: this.error,
        };
    }

    public subscribe(listener: (event: WatchPlayerEvent) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    public dispose(): void {
        this.disposed = true;
        clearInterval(this.handshake);
        this.listenOn(null);
        this.iframe.removeEventListener("load", this.onFrameLoad);
        this.iframe.removeAttribute("src");
        this.element.remove();
        this.listeners.clear();
    }

    private embedUrl(videoId: string, position: number): string {
        const params = new URLSearchParams({
            enablejsapi: "1",
            controls: "0",
            disablekb: "1",
            playsinline: "1",
            rel: "0",
            iv_load_policy: "3",
            fs: "0",
            start: String(Math.max(0, Math.floor(position))),
        });
        // The embed only accepts a web origin; the desktop app's own scheme is left out and identified by the
        // Referer the desktop host adds instead.
        const origin = this.win.location.origin;
        if (/^https?:\/\//.test(origin)) params.set("origin", origin);
        return `${YOUTUBE_EMBED_ORIGIN}/embed/${videoId}?${params}`;
    }

    private command(func: string, args: unknown[] = []): void {
        if (this.disposed) return;
        if (!this.connected) {
            // Only the latest play/pause matters once the embed answers.
            if (func === "playVideo" || func === "pauseVideo")
                this.queue = this.queue.filter((c) => c.func !== "playVideo" && c.func !== "pauseVideo");
            this.queue.push({ func, args });
            return;
        }
        this.post({ event: "command", func, args });
    }

    private post(message: Record<string, unknown>): void {
        try {
            this.iframe.contentWindow?.postMessage(
                JSON.stringify({ ...message, id: 1, channel: "widget" }),
                YOUTUBE_EMBED_ORIGIN,
            );
        } catch {
            // The frame is still on a blank page or navigating; the handshake repeats until the embed answers.
        }
    }

    /** Every load of the frame starts a new embed, which needs the handshake again; a later load lost its place. */
    private readonly onFrameLoad = (): void => {
        // Inserting the frame before it has a video loads a blank page, which is not the embed.
        if (!this.iframe.src) return;
        this.listenOn(this.iframe.ownerDocument.defaultView ?? this.win);
        this.connected = false;
        clearInterval(this.handshake);
        this.post({ event: "listening" });
        this.handshake = setInterval(() => this.post({ event: "listening" }), HANDSHAKE_INTERVAL_MS);
        if (this.loads++ > 0) {
            // Moving the frame in the page reloads it; whoever owns the player loads the item again.
            this.state = YouTubeState.Unstarted;
            this.queue = [];
            this.emit("reset");
        }
    };

    private listenOn(target: Window | null): void {
        if (target === this.listeningWindow) return;
        this.listeningWindow?.removeEventListener("message", this.onMessage);
        this.listeningWindow = target;
        target?.addEventListener("message", this.onMessage);
    }

    private readonly onMessage = (event: MessageEvent): void => {
        if (event.source !== this.iframe.contentWindow || event.origin !== YOUTUBE_EMBED_ORIGIN) return;
        let data: Record<string, unknown>;
        try {
            data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
        } catch {
            return;
        }
        if (!data || typeof data !== "object") return;
        if (!this.connected) {
            this.connected = true;
            clearInterval(this.handshake);
            this.command("setVolume", [Math.round(this.volume * 100)]);
            if (this.volume === 0) this.command("mute");
            for (const { func, args } of this.queue.splice(0)) this.post({ event: "command", func, args });
        }
        if (data.event === "onError") {
            this.error = mapError(data.info);
            this.emit("error");
            return;
        }
        if (data.event !== "infoDelivery" && data.event !== "initialDelivery") return;
        const info = data.info as Record<string, unknown> | undefined;
        if (!info || typeof info !== "object") return;
        this.applyInfo(info);
    };

    private applyInfo(info: Record<string, unknown>): void {
        if (typeof info.currentTime === "number" && Number.isFinite(info.currentTime)) {
            this.time = info.currentTime;
            this.timeAt = this.now();
        }
        if (typeof info.duration === "number" && info.duration > 0) this.duration = info.duration;
        if (typeof info.playbackRate === "number" && info.playbackRate > 0) this.rate = info.playbackRate;
        const videoData = info.videoData as Record<string, unknown> | undefined;
        if (typeof videoData?.title === "string" && videoData.title) this.title = videoData.title;
        const previous = this.state;
        if (typeof info.playerState === "number") this.state = info.playerState;
        if (this.state !== previous) {
            if (this.state === YouTubeState.Ended) this.emit("ended");
            else if (this.state === YouTubeState.Paused && previous === YouTubeState.Playing) this.emit("paused");
            else if (this.state === YouTubeState.Playing) this.emit("playing");
        }
        this.emit("status");
    }

    private emit(event: WatchPlayerEvent): void {
        for (const listener of this.listeners) listener(event);
    }
}
