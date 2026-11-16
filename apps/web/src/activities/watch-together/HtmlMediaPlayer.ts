/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import type { WatchItem } from "./WatchTogetherProtocol";
import type { WatchPlayer, WatchPlayerEvent, WatchPlayerStatus, WatchPlayerError } from "./WatchPlayer";

// Values of MediaError and HTMLMediaElement constants, which not every DOM implementation defines.
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;
const HAVE_METADATA = 1;
const HAVE_FUTURE_DATA = 3;

/** An audio or video file from the web, played by the browser itself. */
export class HtmlMediaPlayer implements WatchPlayer {
    public readonly source = "media";
    public readonly element: HTMLVideoElement;
    private readonly listeners = new Set<(event: WatchPlayerEvent) => void>();
    private item: WatchItem | null = null;
    private error?: WatchPlayerError;
    private readonly abort = new AbortController();

    public constructor(doc: Document = document) {
        this.element = doc.createElement("video");
        this.element.className = "mx_WatchTogether_media";
        this.element.playsInline = true;
        this.element.preload = "auto";
        this.element.style.cssText = "width:100%;height:100%;display:block;object-fit:contain;background:#000;";
        const on = (name: string, listener: () => void): void =>
            this.element.addEventListener(name, listener, { signal: this.abort.signal });
        on("playing", () => this.emit("playing"));
        on("pause", () => {
            // Taking the element out of the page pauses it; only a pause while shown is the user's.
            if (!this.element.ended && this.element.isConnected) this.emit("paused");
        });
        on("ended", () => this.emit("ended"));
        on("error", () => {
            const code = this.element.error?.code;
            this.error = code === MEDIA_ERR_SRC_NOT_SUPPORTED ? "unplayable" : "not_found";
            this.emit("error");
        });
        for (const name of ["loadedmetadata", "durationchange", "ratechange", "waiting", "canplay", "seeked"])
            on(name, () => this.emit("status"));
    }

    public get itemId(): string | null {
        return this.item?.id ?? null;
    }

    public load(item: WatchItem, position: number, play: boolean): void {
        this.item = item;
        this.error = undefined;
        this.element.src = item.ref;
        this.element.currentTime = Math.max(0, position);
        if (play) this.play();
        this.emit("status");
    }

    public play(): void {
        // A rejected play() is reported again by the next status check, so it needs no handling here.
        this.element.play()?.catch(() => {});
    }

    public pause(): void {
        this.element.pause();
    }

    public seek(position: number): void {
        this.element.currentTime = Math.max(0, position);
    }

    public setRate(rate: number): void {
        this.element.playbackRate = rate;
    }

    public setVolume(volume: number): void {
        this.element.volume = Math.max(0, Math.min(1, volume));
        this.element.muted = volume === 0;
    }

    public status(): WatchPlayerStatus {
        const media = this.element;
        const duration = Number.isFinite(media.duration) && media.duration > 0 ? media.duration : null;
        return {
            ready: !!this.item,
            playing: !media.paused && !media.ended,
            buffering: !media.paused && media.readyState < HAVE_FUTURE_DATA,
            time: this.item ? media.currentTime : null,
            duration,
            rate: media.playbackRate,
            hasVideo: media.readyState < HAVE_METADATA || media.videoWidth > 0,
            error: this.error,
        };
    }

    public subscribe(listener: (event: WatchPlayerEvent) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    public dispose(): void {
        this.abort.abort();
        this.element.pause();
        this.element.removeAttribute("src");
        this.element.load();
        this.element.remove();
        this.listeners.clear();
    }

    private emit(event: WatchPlayerEvent): void {
        for (const listener of this.listeners) listener(event);
    }
}
