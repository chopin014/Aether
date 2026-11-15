/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import type { SiteViewApi, SiteViewBounds, SiteViewEvent, SiteViewState } from "shared-types";

import type { WatchItem } from "./WatchTogetherProtocol";
import type { WatchPlayer, WatchPlayerEvent, WatchPlayerStatus } from "./WatchPlayer";

/** Where the page shown in the site view is, compared with the page shared with the call. */
export interface SitePageStatus {
    readonly url: string;
    readonly title: string;
    readonly loading: boolean;
    readonly canGoBack: boolean;
    readonly videoFound: boolean;
    /** The view shows the page everyone was sent to, so syncing applies. */
    readonly onSharedPage: boolean;
}

/** Ignores the fragment, as it moves around within one page; YouTube watch pages are the same video by ID. */
export function samePage(a: string, b: string): boolean {
    try {
        const x = new URL(a);
        const y = new URL(b);
        x.hash = y.hash = "";
        for (const url of [x, y]) {
            url.searchParams.delete("t");
            url.searchParams.sort();
        }
        return x.href === y.href;
    } catch {
        return a === b;
    }
}

/**
 * A website shown in the desktop app's own embedded browser and laid over the player tile. Everyone opens the page
 * themselves, signs in and clicks through like in a browser; once the page shows a video, it is kept in sync. The
 * embedded browser always draws above the app, so it is hidden, showing a still frame instead, whenever part of the
 * app's own interface needs to be on top.
 */
export class SitePlayer implements WatchPlayer {
    public readonly source = "site";
    public readonly element: HTMLDivElement;
    private readonly snapshot: HTMLImageElement;
    private readonly listeners = new Set<(event: WatchPlayerEvent) => void>();
    private readonly unsubscribe: () => void;
    private item: WatchItem | null = null;
    private state: SiteViewState | null = null;
    private stateAt = 0;
    private frame = 0;
    private lastBounds = "";
    private obscured = false;
    private disposed = false;

    public constructor(
        private readonly api: SiteViewApi,
        private readonly now: () => number = () => performance.now(),
        doc: Document = document,
    ) {
        this.element = doc.createElement("div");
        this.element.className = "mx_WatchTogether_site";
        this.element.style.cssText = "width:100%;height:100%;position:relative;background:#000;";
        this.snapshot = doc.createElement("img");
        this.snapshot.alt = "";
        this.snapshot.style.cssText = "width:100%;height:100%;object-fit:contain;display:none;";
        this.element.appendChild(this.snapshot);
        this.unsubscribe = api.onEvent(this.onEvent);
        this.place();
    }

    public get itemId(): string | null {
        return this.item?.id ?? null;
    }

    public get itemRef(): string | null {
        return this.item?.ref ?? null;
    }

    /** The page in the view, for "go to the shared page" and "share this page". */
    public page(): SitePageStatus | null {
        const state = this.state;
        if (!state || !this.item) return null;
        return {
            url: state.url,
            title: state.title,
            loading: state.loading,
            canGoBack: state.canGoBack,
            videoFound: !!state.video,
            onSharedPage: samePage(state.url, this.item.ref),
        };
    }

    /** True while the app's own menus or dialogs cover the player; the view is hidden so they can be seen. */
    public setObscured(obscured: boolean): void {
        this.obscured = obscured;
    }

    public load(item: WatchItem): void {
        this.item = item;
        this.state = null;
        void this.api.open(item.ref).catch(() => {});
        this.emit("status");
    }

    public goBack(): void {
        this.api.goBack();
    }

    /** Opens the shared page again after browsing away from it. */
    public reopen(): void {
        if (this.item) void this.api.open(this.item.ref).catch(() => {});
    }

    public play(): void {
        this.api.command({ play: true });
    }

    public pause(): void {
        this.api.command({ pause: true });
    }

    public seek(position: number): void {
        this.api.command({ seek: Math.max(0, position) });
    }

    public setRate(rate: number): void {
        this.api.command({ rate });
    }

    public setVolume(volume: number): void {
        this.api.command({ volume: Math.max(0, Math.min(1, volume)) });
    }

    public status(): WatchPlayerStatus {
        const video = this.state?.video;
        // Syncing waits until the page everyone was sent to shows its video.
        const ready = !!video && !!this.item && samePage(this.state!.url, this.item.ref);
        let time = video ? video.time : null;
        if (video && time !== null && !video.paused && !video.buffering) {
            time += ((this.now() - this.stateAt) / 1000) * video.rate;
            if (video.duration) time = Math.min(time, video.duration);
        }
        return {
            ready,
            playing: !!video && !video.paused && !video.ended,
            buffering: !!video?.buffering,
            time,
            duration: video?.duration ?? null,
            rate: video?.rate ?? 1,
            title: this.state?.title || undefined,
            hasVideo: true,
        };
    }

    public subscribe(listener: (event: WatchPlayerEvent) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    public dispose(): void {
        this.disposed = true;
        cancelAnimationFrame(this.frame);
        this.unsubscribe();
        this.api.close();
        this.element.remove();
        this.listeners.clear();
    }

    /**
     * Keeps the native view over this element, frame by frame, so it follows layout changes and tile animations.
     * It is hidden while the element is not shown, sits in another window (a popped-out call), or is covered.
     */
    private readonly place = (): void => {
        if (this.disposed) return;
        this.frame = requestAnimationFrame(this.place);
        const element = this.element;
        const view = element.ownerDocument.defaultView;
        let bounds: SiteViewBounds | null = null;
        if (!this.obscured && element.isConnected && view === window) {
            const box = element.getBoundingClientRect();
            const hidden = getComputedStyle(element).visibility === "hidden";
            if (!hidden && box.width >= 2 && box.height >= 2) {
                bounds = { x: box.left, y: box.top, width: box.width, height: box.height };
            }
        }
        const key = bounds ? `${bounds.x},${bounds.y},${bounds.width},${bounds.height}` : "";
        if (key === this.lastBounds) return;
        this.lastBounds = key;
        this.snapshot.style.display = bounds ? "none" : "block";
        this.api.setBounds(bounds);
    };

    private readonly onEvent = (event: SiteViewEvent): void => {
        switch (event.type) {
            case "state": {
                this.state = event.state;
                this.stateAt = this.now();
                this.emit("status");
                break;
            }
            case "video":
                this.emit(event.event);
                break;
            case "snapshot":
                this.snapshot.src = event.dataUrl;
                break;
        }
    };

    private emit(event: WatchPlayerEvent): void {
        for (const listener of this.listeners) listener(event);
    }
}

/** Shown in the web app, which cannot open websites inside itself: only the desktop app has an embedded browser. */
export class UnsupportedSitePlayer implements WatchPlayer {
    public readonly source = "site";
    public readonly element: HTMLDivElement;
    private item: WatchItem | null = null;

    public constructor(doc: Document = document) {
        this.element = doc.createElement("div");
    }

    public get itemId(): string | null {
        return this.item?.id ?? null;
    }

    public get itemRef(): string | null {
        return this.item?.ref ?? null;
    }

    public load(item: WatchItem): void {
        this.item = item;
    }

    public play(): void {}
    public pause(): void {}
    public seek(): void {}
    public setRate(): void {}
    public setVolume(): void {}

    public status(): WatchPlayerStatus {
        return {
            ready: false,
            playing: false,
            buffering: false,
            time: null,
            duration: null,
            rate: 1,
            hasVideo: false,
            error: "needs_desktop",
        };
    }

    public subscribe(): () => void {
        return () => {};
    }

    public dispose(): void {
        this.element.remove();
    }
}
