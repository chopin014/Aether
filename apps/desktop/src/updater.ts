/*
Copyright 2016-2024 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import electronUpdater, { type AppUpdater, type UpdateDownloadedEvent } from "electron-updater";
import { app, ipcMain, type IpcMainEvent, type WebContents } from "electron";
import fs, { constants } from "node:fs/promises";
import path from "node:path";

import type { DesktopUpdateState } from "shared-types";

const UPDATE_POLL_INTERVAL_MS = 60 * 60 * 1000;
const INITIAL_UPDATE_DELAY_MS = 30 * 1000;
const RELEASES_URL = "https://github.com/chopin014/Aether/releases";
const GITHUB_OWNER = "chopin014";
const GITHUB_REPOSITORY = "Aether";

type UnsupportedReason = NonNullable<DesktopUpdateState["reason"]>;

interface LegacyDownloadedUpdate {
    releaseNotes: string;
    releaseName: string;
    releaseDate: Date;
    updateURL: string;
}

/** Runtime details used to decide whether this installed build can update. */
export interface RuntimeUpdateEnvironment {
    enabled: boolean;
    isPackaged: boolean;
    platform: NodeJS.Platform;
    resourcesPath: string;
    appImagePath?: string;
    executablePath: string;
}

/** How a Linux build was installed, which decides how it updates. */
export type LinuxPackage = "appimage" | "deb";

type UpdateSupportResolver = (environment: RuntimeUpdateEnvironment) => Promise<UnsupportedReason | undefined>;

interface DesktopUpdaterOptions {
    currentVersion: string;
    resolveUnsupportedReason: UpdateSupportResolver;
    initialDelayMs?: number;
    pollIntervalMs?: number;
    /** Whether a downloaded update installs when the app quits, rather than only when the user restarts for it. */
    installOnQuit?: boolean;
}

function hasExpectedGitHubConfiguration(config: string): boolean {
    const readSetting = (name: string): string | undefined => {
        const value = new RegExp(`^${name}:\\s*["']?([^\\s"']+)["']?\\s*$`, "m").exec(config)?.[1];
        return value;
    };

    return (
        readSetting("provider") === "github" &&
        readSetting("owner") === GITHUB_OWNER &&
        readSetting("repo") === GITHUB_REPOSITORY &&
        (readSetting("host") === undefined || readSetting("host") === "github.com")
    );
}

/**
 * Works out how a Linux build was installed. electron-builder writes the deb's `package-type` file into the folder the
 * AppImage is also packed from, so an AppImage can carry it too. A running AppImage therefore wins over that file.
 * @param appImagePath The `APPIMAGE` environment variable.
 * @param resourcesPath The app's resources folder.
 */
export async function detectLinuxPackage(
    appImagePath: string | undefined,
    resourcesPath: string,
): Promise<LinuxPackage | undefined> {
    if (appImagePath !== undefined) {
        const isAppImage = path.isAbsolute(appImagePath) && path.extname(appImagePath).toLowerCase() === ".appimage";
        return isAppImage ? "appimage" : undefined;
    }
    try {
        const packageType = await fs.readFile(path.join(resourcesPath, "package-type"), "utf8");
        return packageType.trim() === "deb" ? "deb" : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Determines whether this build has the GitHub metadata and install form required for automatic updates.
 * @param environment Platform, packaging, command line and resources metadata for the running app.
 */
export async function resolveRuntimeUnsupportedReason(
    environment: RuntimeUpdateEnvironment,
): Promise<UnsupportedReason | undefined> {
    if (!environment.enabled) return "disabled";
    if (!environment.isPackaged) return "development";
    if (environment.platform !== "win32" && environment.platform !== "linux") return "platform";
    const linuxPackage =
        environment.platform === "linux"
            ? await detectLinuxPackage(environment.appImagePath, environment.resourcesPath)
            : undefined;
    if (environment.platform === "linux" && !linuxPackage) return "package";
    if (environment.platform === "win32") {
        try {
            await fs.access(path.join(path.dirname(environment.executablePath), "Uninstall Aether.exe"));
        } catch {
            return "package";
        }
    }

    try {
        const config = await fs.readFile(path.join(environment.resourcesPath, "app-update.yml"), "utf8");
        if (!hasExpectedGitHubConfiguration(config)) return "package";
    } catch {
        return "package";
    }

    // An AppImage update replaces the file in its own folder, which fails in a folder the user cannot write to.
    if (linuxPackage === "appimage") {
        try {
            await fs.access(path.dirname(environment.appImagePath!), constants.W_OK);
        } catch {
            return "location";
        }
    }

    return undefined;
}

function getRuntimeEnvironment(enabled: boolean): RuntimeUpdateEnvironment {
    return {
        enabled,
        isPackaged: app.isPackaged,
        platform: process.platform,
        resourcesPath: process.resourcesPath,
        appImagePath: process.env.APPIMAGE,
        executablePath: process.execPath,
    };
}

function isMainFrame(event: IpcMainEvent): boolean {
    return event.sender === global.mainWindow?.webContents && event.senderFrame === event.sender.mainFrame;
}

function toLegacyDownloadedUpdate(update: UpdateDownloadedEvent): LegacyDownloadedUpdate {
    const releaseNotes = update.releaseNotes;
    return {
        releaseNotes:
            typeof releaseNotes === "string"
                ? releaseNotes
                : (releaseNotes
                      ?.map((note) => note.note ?? "")
                      .filter(Boolean)
                      .join("\n\n") ?? ""),
        releaseName: update.releaseName ?? update.version,
        releaseDate: new Date(update.releaseDate),
        updateURL: update.files[0]?.url ?? "",
    };
}

/**
 * Coordinates GitHub Releases update checks and exposes a renderer-safe state snapshot.
 */
export class DesktopUpdater {
    private readonly currentVersion: string;
    private readonly resolveUnsupportedReason: UpdateSupportResolver;
    private readonly initialDelayMs: number;
    private readonly pollIntervalMs: number;
    private readonly installOnQuit: boolean;
    private state: DesktopUpdateState;
    private initialized = false;
    private supported = false;
    private disposed = false;
    private installing = false;
    private checkPromise?: Promise<void>;
    private initialCheckTimer?: ReturnType<typeof setTimeout>;
    private pollTimer?: ReturnType<typeof setInterval>;
    private latestDownloadedUpdate?: LegacyDownloadedUpdate;
    private readonly attachedWebContents = new Map<WebContents, () => void>();

    private readonly onCheckingForUpdate = (): void => {
        if (!this.supported || this.disposed) return;
        if (this.state.status !== "checking") {
            this.setState({ status: "checking", lastChecked: this.state.lastChecked });
        }
    };

    private readonly onUpdateAvailable = (info: { version: string }): void => {
        if (!this.supported || this.disposed) return;
        this.sendLegacyUpdateStatus(true);
        this.setState({ status: "downloading", version: info.version });
    };

    private readonly onUpdateNotAvailable = (): void => {
        if (!this.supported || this.disposed) return;
        if (this.state.status === "ready") {
            this.sendLegacyDownloadedUpdate();
            return;
        }
        this.markNoUpdateAvailable();
    };

    private readonly onDownloadProgress = (progress: { percent: number }): void => {
        if (!this.supported || this.disposed) return;
        if (!Number.isFinite(progress.percent)) return;
        const percent = Math.min(100, Math.max(0, progress.percent));
        this.setState({ status: "downloading", version: this.state.version, percent });
    };

    private readonly onUpdateDownloaded = (update: UpdateDownloadedEvent): void => {
        if (!this.supported || this.disposed) return;
        this.latestDownloadedUpdate = toLegacyDownloadedUpdate(update);
        this.setState({ status: "ready", version: update.version, percent: 100 });
        this.sendLegacyDownloadedUpdate();
    };

    private readonly onUpdateCancelled = (): void => {
        if (!this.supported || this.disposed) return;
        this.sendLegacyUpdateStatus("Update download cancelled");
        this.setState({ status: "error", lastChecked: Date.now() });
    };

    private readonly onError = (error: Error): void => {
        if (!this.supported || this.disposed) return;
        if (this.installing) {
            this.installing = false;
            global.appQuitting = false;
        }
        this.sendLegacyUpdateStatus(error.message);
        this.setState({ status: "error", lastChecked: Date.now() });
    };

    /**
     * Creates an updater controller. Runtime overrides make package and timer behavior testable.
     * @param updater Electron updater instance.
     * @param options Current app version and runtime configuration.
     */
    public constructor(
        private readonly updater: AppUpdater,
        options: DesktopUpdaterOptions,
    ) {
        this.currentVersion = options.currentVersion;
        this.resolveUnsupportedReason = options.resolveUnsupportedReason;
        this.initialDelayMs = options.initialDelayMs ?? INITIAL_UPDATE_DELAY_MS;
        this.pollIntervalMs = options.pollIntervalMs ?? UPDATE_POLL_INTERVAL_MS;
        this.installOnQuit = options.installOnQuit ?? true;
        this.state = { status: "idle", currentVersion: this.currentVersion };

        // All Aether production builds follow stable releases. This also lets existing dev builds
        // move to the first stable release without consuming another prerelease-only channel.
        this.updater.allowPrerelease = false;
        this.updater.allowDowngrade = false;
        this.updater.autoDownload = true;
        this.updater.autoInstallOnAppQuit = false;

        this.updater.on("checking-for-update", this.onCheckingForUpdate);
        this.updater.on("update-available", this.onUpdateAvailable);
        this.updater.on("update-not-available", this.onUpdateNotAvailable);
        this.updater.on("download-progress", this.onDownloadProgress);
        this.updater.on("update-downloaded", this.onUpdateDownloaded);
        this.updater.on("update-cancelled", this.onUpdateCancelled);
        this.updater.on("error", this.onError);
    }

    /**
     * Resolves whether this installation can update, then schedules automatic update checks.
     * @param enabled Whether `--no-update` was absent.
     */
    public async start(enabled: boolean): Promise<void> {
        if (this.initialized || this.disposed) return;
        this.initialized = true;
        let reason: UnsupportedReason | undefined;
        try {
            reason = await this.resolveUnsupportedReason(getRuntimeEnvironment(enabled));
        } catch {
            this.setState({ status: "error", lastChecked: Date.now() });
            return;
        }
        if (this.disposed) return;

        if (reason) {
            this.setState({ status: "unsupported", reason });
            return;
        }

        this.supported = true;
        this.updater.autoInstallOnAppQuit = this.installOnQuit;
        this.setState({ status: "idle" });
        this.initialCheckTimer = setTimeout(() => void this.checkForUpdates(), this.initialDelayMs);
        this.pollTimer = setInterval(() => void this.checkForUpdates(), this.pollIntervalMs);
    }

    /**
     * Returns the current update state for the renderer.
     */
    public getState(): DesktopUpdateState {
        return { ...this.state };
    }

    /**
     * Returns the public release page only when this installation supports updates.
     */
    public getFeedUrl(): string | undefined {
        return this.supported ? RELEASES_URL : undefined;
    }

    /**
     * Starts one update check. Repeated calls share an in-flight check and do not interrupt downloads.
     */
    public checkForUpdates(): Promise<void> {
        if (!this.initialized || !this.supported || this.disposed || this.installing) return Promise.resolve();
        if (this.state.status === "ready") {
            this.sendState();
            this.sendLegacyDownloadedUpdate();
            return Promise.resolve();
        }
        if (this.state.status === "downloading") {
            this.sendState();
            return Promise.resolve();
        }
        if (this.checkPromise) return this.checkPromise;

        this.setState({ status: "checking", lastChecked: this.state.lastChecked });
        this.checkPromise = this.performCheck();
        return this.checkPromise;
    }

    /**
     * Installs a downloaded update after a renderer explicitly requests an immediate restart.
     */
    public installUpdate(): void {
        if (
            !this.initialized ||
            !this.supported ||
            this.disposed ||
            this.installing ||
            this.state.status !== "ready" ||
            global.appQuitting
        ) {
            return;
        }

        this.installing = true;
        global.appQuitting = true;
        try {
            this.updater.quitAndInstall(true, true);
        } catch (error) {
            this.installing = false;
            global.appQuitting = false;
            this.onError(error instanceof Error ? error : new Error(String(error)));
        }
    }

    /**
     * Replays the latest state after the renderer finishes loading, including the legacy ready event.
     * @param webContents Main window renderer.
     */
    public attachRenderer(webContents: WebContents): void {
        if (this.attachedWebContents.has(webContents)) return;
        const listener = (): void => {
            this.sendState(webContents);
            this.sendLegacyDownloadedUpdate(webContents);
        };
        this.attachedWebContents.set(webContents, listener);
        webContents.on("did-finish-load", listener);
    }

    /**
     * Clears polling timers and removes listeners when Electron is shutting down.
     */
    public dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        if (this.initialCheckTimer) clearTimeout(this.initialCheckTimer);
        if (this.pollTimer) clearInterval(this.pollTimer);
        this.initialCheckTimer = undefined;
        this.pollTimer = undefined;

        this.updater.removeListener("checking-for-update", this.onCheckingForUpdate);
        this.updater.removeListener("update-available", this.onUpdateAvailable);
        this.updater.removeListener("update-not-available", this.onUpdateNotAvailable);
        this.updater.removeListener("download-progress", this.onDownloadProgress);
        this.updater.removeListener("update-downloaded", this.onUpdateDownloaded);
        this.updater.removeListener("update-cancelled", this.onUpdateCancelled);
        this.updater.removeListener("error", this.onError);
        for (const [webContents, listener] of this.attachedWebContents) {
            webContents.removeListener("did-finish-load", listener);
        }
        this.attachedWebContents.clear();
    }

    private async performCheck(): Promise<void> {
        try {
            const result = await this.updater.checkForUpdates();
            if (result?.downloadPromise) {
                await result.downloadPromise;
            }
            if (result === null && this.state.status === "checking") this.markNoUpdateAvailable();
            else if (result && !result.isUpdateAvailable && this.state.status === "checking")
                this.markNoUpdateAvailable();
        } catch (error) {
            // The updater emits the error event; the catch prevents an unhandled rejection from IPC/timers.
            if (!this.disposed && this.state.status !== "error") {
                this.onError(error instanceof Error ? error : new Error(String(error)));
            }
        } finally {
            this.checkPromise = undefined;
        }
    }

    private markNoUpdateAvailable(): void {
        this.sendLegacyUpdateStatus(false);
        this.setState({ status: "idle", lastChecked: Date.now() });
    }

    private setState(next: Omit<DesktopUpdateState, "currentVersion">): void {
        this.state = { currentVersion: this.currentVersion, ...next };
        this.sendState();
    }

    private sendState(webContents?: WebContents): void {
        const target = webContents ?? global.mainWindow?.webContents;
        target?.send("aether:update-state", this.getState());
    }

    private sendLegacyUpdateStatus(status: boolean | string): void {
        global.mainWindow?.webContents.send("check_updates", status);
    }

    private sendLegacyDownloadedUpdate(webContents?: WebContents): void {
        if (!this.latestDownloadedUpdate) return;
        const target = webContents ?? global.mainWindow?.webContents;
        target?.send("update-downloaded", this.latestDownloadedUpdate);
    }
}

/** A .deb build installs its updates as root, which asks for the user's password. */
const isDebBuild = process.platform === "linux" && process.env.APPIMAGE === undefined;

/** Shared main-process updater instance used by IPC and Electron startup. */
export const desktopUpdater = new DesktopUpdater(
    // Choose the AppImage updater from the running process, not from a package-type file it may carry.
    process.platform === "linux" && process.env.APPIMAGE !== undefined
        ? new electronUpdater.AppImageUpdater()
        : electronUpdater.autoUpdater,
    {
        currentVersion: app.getVersion(),
        resolveUnsupportedReason: resolveRuntimeUnsupportedReason,
        // A password prompt while quitting would be a surprise, so a .deb update waits for the user to restart for it.
        installOnQuit: !isDebBuild,
    },
);

ipcMain.on("install_update", (event: IpcMainEvent) => {
    if (isMainFrame(event)) desktopUpdater.installUpdate();
});

ipcMain.on("check_updates", (event: IpcMainEvent) => {
    if (isMainFrame(event)) void desktopUpdater.checkForUpdates();
});

app.once("will-quit", () => desktopUpdater.dispose());
