/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    app,
    type BrowserWindow,
    ipcMain,
    type IpcMainEvent,
    session,
    shell,
    WebContentsView,
    type WebFrameMain,
} from "electron";
import type {
    SiteVideoEvent,
    SiteVideoState,
    SiteViewBounds,
    SiteViewCommand,
    SiteViewEvent,
    SiteViewState,
} from "shared-types";

/**
 * Sites watched together keep their own cookies and logins, apart from the app's Matrix session, and stay signed
 * in across restarts.
 */
export const SITE_PARTITION = "persist:aether-sites";

/** What each frame of the site reports about its own best video. */
export interface SiteFrameReport {
    /** How likely this is the video people mean to watch; 0 when the frame has none. */
    score: number;
    video: SiteVideoState | null;
    event?: SiteVideoEvent;
}

/** A site's own user agent check sees an ordinary Chrome, not Electron or Aether, which many sites refuse. */
export function plainChromeUserAgent(userAgent: string): string {
    return userAgent
        .replace(/\s(Electron|Aether|aether-desktop|Element)\/\S+/gi, "")
        .replace(/\s{2,}/g, " ")
        .trim();
}

/** Only web pages are opened; anything else (files, the app's own scheme, scripts) is refused. */
export function isSiteUrl(url: unknown): url is string {
    if (typeof url !== "string" || url.length > 4096) return false;
    try {
        const protocol = new URL(url).protocol;
        return protocol === "https:" || protocol === "http:";
    } catch {
        return false;
    }
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

/** Checks a report from a page frame; the page is not trusted. */
export function parseFrameReport(value: unknown): SiteFrameReport | undefined {
    if (!value || typeof value !== "object") return;
    const report = value as Record<string, unknown>;
    if (!isFiniteNumber(report.score) || report.score < 0) return;
    let video: SiteVideoState | null = null;
    if (report.video) {
        const v = report.video as Record<string, unknown>;
        if (
            typeof v.paused !== "boolean" ||
            typeof v.ended !== "boolean" ||
            typeof v.buffering !== "boolean" ||
            !isFiniteNumber(v.time) ||
            !isFiniteNumber(v.rate) ||
            (v.duration !== null && !isFiniteNumber(v.duration))
        )
            return;
        video = {
            paused: v.paused,
            ended: v.ended,
            buffering: v.buffering,
            time: Math.max(0, v.time),
            duration: v.duration,
            rate: v.rate,
        };
    }
    const events: SiteVideoEvent[] = ["playing", "paused", "seeked", "ended", "ratechange"];
    const event = events.find((name) => name === report.event);
    return { score: report.score, video, ...(event ? { event } : {}) };
}

/** Checks a command from the app's own window before it is passed to the page. */
export function parseCommand(value: unknown): SiteViewCommand | undefined {
    if (!value || typeof value !== "object") return;
    const command = value as Record<string, unknown>;
    if (command.play === true) return { play: true };
    if (command.pause === true) return { pause: true };
    if (isFiniteNumber(command.seek) && command.seek >= 0) return { seek: command.seek };
    if (isFiniteNumber(command.rate) && command.rate >= 0.25 && command.rate <= 4) return { rate: command.rate };
    if (isFiniteNumber(command.volume) && command.volume >= 0 && command.volume <= 1) return { volume: command.volume };
}

function parseBounds(value: unknown): SiteViewBounds | null | undefined {
    if (value === null) return null;
    if (!value || typeof value !== "object") return;
    const b = value as Record<string, unknown>;
    if (![b.x, b.y, b.width, b.height].every(isFiniteNumber)) return;
    return { x: b.x as number, y: b.y as number, width: b.width as number, height: b.height as number };
}

/**
 * The embedded browser for watching a website together. It lives in the app window above the web page, at the
 * place the call stage gives it; the app only ever sees what the page's video is doing, never the page itself.
 */
export class SiteView {
    private view: WebContentsView | null = null;
    /** Each frame's latest report, so the frame with the best video can be chosen. */
    private readonly frames = new Map<string, { frame: WebFrameMain; report: SiteFrameReport }>();
    private bestFrame: string | null = null;
    private volume = 1;
    private visible = false;
    /** Changes with each placement, so a hide still waiting for its still frame is cancelled by a newer show. */
    private placement = 0;

    public constructor(
        private readonly owner: BrowserWindow,
        private readonly preloadPath: string,
    ) {}

    public async open(url: string): Promise<void> {
        const view = this.view ?? this.create();
        this.resetFrames();
        await view.webContents.loadURL(url).catch(() => {
            // A failed or aborted load is shown by the page itself; the state event reports where it ended up.
        });
    }

    public setBounds(bounds: SiteViewBounds | null): void {
        const view = this.view;
        if (!view) return;
        const placement = ++this.placement;
        if (!bounds || bounds.width < 2 || bounds.height < 2) {
            if (!this.visible) return;
            this.visible = false;
            // The still frame is taken while the page is still showing, so the app has something to put in its place.
            void this.snapshotThenHide(view, placement);
            return;
        }
        // The app's page may be zoomed; the view is placed in window units.
        const zoom = this.owner.webContents.getZoomFactor();
        view.setBounds({
            x: Math.round(bounds.x * zoom),
            y: Math.round(bounds.y * zoom),
            width: Math.round(bounds.width * zoom),
            height: Math.round(bounds.height * zoom),
        });
        this.visible = true;
        view.setVisible(true);
    }

    public command(command: SiteViewCommand): void {
        const view = this.view;
        if (!view) return;
        if ("volume" in command) {
            this.volume = command.volume;
            view.webContents.setAudioMuted(command.volume === 0);
        }
        const best = this.bestFrame ? this.frames.get(this.bestFrame) : undefined;
        if (!best || best.frame.isDestroyed()) return;
        best.frame.send("aether:site-command", command);
    }

    public goBack(): void {
        const history = this.view?.webContents.navigationHistory;
        if (history?.canGoBack()) history.goBack();
    }

    public close(): void {
        const view = this.view;
        if (!view) return;
        this.view = null;
        this.resetFrames();
        if (!this.owner.isDestroyed()) this.owner.contentView.removeChildView(view);
        if (!view.webContents.isDestroyed()) view.webContents.close();
    }

    /** Called with each report a frame of the site sends. */
    public receiveFrameReport(event: IpcMainEvent, value: unknown): void {
        const view = this.view;
        const frame = event.senderFrame;
        if (!view || event.sender !== view.webContents || !frame) return;
        const report = parseFrameReport(value);
        if (!report) return;
        const key = `${frame.processId}:${frame.routingId}`;
        this.frames.set(key, { frame, report });
        const previous = this.bestFrame;
        this.chooseBestFrame();
        if (this.bestFrame !== key) return;
        if (report.event) this.emit({ type: "video", event: report.event });
        if (report.event || previous !== key || report.video) this.emitState();
    }

    private chooseBestFrame(): void {
        let best: string | null = null;
        let score = 0;
        for (const [key, entry] of this.frames) {
            if (entry.frame.isDestroyed()) {
                this.frames.delete(key);
                continue;
            }
            if (entry.report.score > score) {
                best = key;
                score = entry.report.score;
            }
        }
        // Keep the current choice while it still has a video, so two similar videos cannot make it flip.
        const current = this.bestFrame ? this.frames.get(this.bestFrame) : undefined;
        if (current && current.report.score > 0 && best && score <= current.report.score * 2) return;
        if (best !== this.bestFrame) {
            this.bestFrame = best;
            if (best) this.frames.get(best)!.frame.send("aether:site-command", { volume: this.volume });
        }
    }

    private resetFrames(): void {
        this.frames.clear();
        this.bestFrame = null;
    }

    private create(): WebContentsView {
        const sites = session.fromPartition(SITE_PARTITION);
        sites.setUserAgent(plainChromeUserAgent(app.userAgentFallback));
        sites.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === "fullscreen"));
        sites.setPermissionCheckHandler((_contents, permission) => permission === "fullscreen");
        const view = new WebContentsView({
            webPreferences: {
                session: sites,
                preload: this.preloadPath,
                sandbox: true,
                contextIsolation: true,
                nodeIntegration: false,
                // Runs the video preload in every frame: players often live in an embedded frame.
                nodeIntegrationInSubFrames: true,
                backgroundThrottling: false,
                autoplayPolicy: "no-user-gesture-required",
            },
        });
        view.setBackgroundColor("#000000");
        view.setVisible(false);
        const contents = view.webContents;
        contents.setWindowOpenHandler(({ url }) => {
            // Sign-in popups stay in the site's session; links meant for a new tab replace the page instead.
            if (!isSiteUrl(url)) return { action: "deny" };
            return {
                action: "allow",
                overrideBrowserWindowOptions: { autoHideMenuBar: true, width: 520, height: 720, parent: this.owner },
            };
        });
        contents.on("will-navigate", (event, url: string) => {
            if (isSiteUrl(url)) return;
            event.preventDefault();
            if (String(url).startsWith("mailto:")) void shell.openExternal(url);
        });
        const onChange = (): void => this.emitState();
        contents.on("did-navigate", () => {
            this.resetFrames();
            onChange();
        });
        contents.on("did-navigate-in-page", onChange);
        contents.on("page-title-updated", onChange);
        contents.on("did-start-loading", onChange);
        contents.on("did-stop-loading", onChange);
        // A frame that loads another page starts over; its old video is gone.
        contents.on("did-frame-navigate", (_event, _url, _code, _status, isMainFrame, processId, routingId) => {
            if (isMainFrame) return;
            this.frames.delete(`${processId}:${routingId}`);
            if (this.bestFrame === `${processId}:${routingId}`) this.bestFrame = null;
            this.chooseBestFrame();
            this.emitState();
        });
        contents.on("enter-html-full-screen", () => this.emit({ type: "fullscreen", on: true }));
        contents.on("leave-html-full-screen", () => this.emit({ type: "fullscreen", on: false }));
        contents.on("render-process-gone", () => this.resetFrames());
        this.owner.contentView.addChildView(view);
        this.view = view;
        return view;
    }

    private async snapshotThenHide(view: WebContentsView, placement: number): Promise<void> {
        const capture = view.webContents
            .capturePage()
            .then((image) => (image.isEmpty() ? null : `data:image/jpeg;base64,${image.toJPEG(80).toString("base64")}`))
            .catch(() => null);
        // Menus over the player should not wait long for the frame.
        const dataUrl = await Promise.race([capture, new Promise<null>((r) => setTimeout(() => r(null), 150))]);
        if (placement !== this.placement || this.view !== view) return;
        if (dataUrl) this.emit({ type: "snapshot", dataUrl });
        view.setVisible(false);
    }

    private emitState(): void {
        const view = this.view;
        if (!view) return;
        const contents = view.webContents;
        const best = this.bestFrame ? this.frames.get(this.bestFrame) : undefined;
        const state: SiteViewState = {
            url: contents.getURL(),
            title: contents.getTitle(),
            loading: contents.isLoading(),
            canGoBack: contents.navigationHistory.canGoBack(),
            video: best?.report.video ?? null,
        };
        this.emit({ type: "state", state });
    }

    private emit(event: SiteViewEvent): void {
        if (!this.owner.isDestroyed()) this.owner.webContents.send("aether:site-event", event);
    }
}

/** Wires the site view's channels to one app window; only that window's own page may use them. */
export function setupSiteView(owner: BrowserWindow): SiteView {
    const view = new SiteView(owner, path.join(path.dirname(fileURLToPath(import.meta.url)), "site-preload.cjs"));
    const fromOwner = (event: IpcMainEvent | Electron.IpcMainInvokeEvent): boolean =>
        event.sender === owner.webContents && event.senderFrame === owner.webContents.mainFrame;

    ipcMain.removeHandler("aether:site-open");
    ipcMain.handle("aether:site-open", async (event, url: unknown) => {
        if (!fromOwner(event) || !isSiteUrl(url)) throw new Error("Invalid site");
        await view.open(url);
    });
    const listeners: [string, (event: IpcMainEvent, ...args: unknown[]) => void][] = [
        [
            "aether:site-bounds",
            (event, bounds) => {
                const parsed = parseBounds(bounds);
                if (fromOwner(event) && parsed !== undefined) view.setBounds(parsed);
            },
        ],
        [
            "aether:site-command",
            (event, command) => {
                const parsed = parseCommand(command);
                if (fromOwner(event) && parsed) view.command(parsed);
            },
        ],
        ["aether:site-back", (event) => fromOwner(event) && view.goBack()],
        ["aether:site-close", (event) => fromOwner(event) && view.close()],
        ["aether:site-frame", (event, report) => view.receiveFrameReport(event, report)],
    ];
    for (const [channel, listener] of listeners) {
        ipcMain.removeAllListeners(channel);
        ipcMain.on(channel, listener);
    }
    owner.on("closed", () => view.close());
    return view;
}
