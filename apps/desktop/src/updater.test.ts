/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppUpdater, UpdateDownloadedEvent, UpdateCheckResult } from "electron-updater";

import { DesktopUpdater, desktopUpdater, resolveRuntimeUnsupportedReason } from "./updater.js";

const { ipcHandlers, upstreamListeners, upstreamUpdater } = vi.hoisted(() => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const updater = {
        autoDownload: true,
        autoInstallOnAppQuit: true,
        allowPrerelease: false,
        allowDowngrade: false,
        checkForUpdates: vi.fn<() => Promise<UpdateCheckResult | null>>(),
        quitAndInstall: vi.fn(),
        on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
            listeners.set(event, listener);
            return updater;
        }),
        removeListener: vi.fn((event: string) => {
            listeners.delete(event);
            return updater;
        }),
    };
    return {
        ipcHandlers: {} as Record<string, (...args: unknown[]) => unknown>,
        upstreamListeners: listeners,
        upstreamUpdater: updater,
    };
});

vi.mock("electron-updater", () => ({ default: { autoUpdater: upstreamUpdater } }));
vi.mock("electron", () => ({
    app: {
        getVersion: vi.fn(() => "0.1.0-dev.2"),
        isPackaged: true,
        once: vi.fn(),
    },
    ipcMain: {
        on: vi.fn((channel: string, listener: (...args: unknown[]) => unknown) => {
            ipcHandlers[channel] = listener;
        }),
    },
}));

interface FakeUpdater {
    updater: AppUpdater;
    checkForUpdates: ReturnType<typeof vi.fn<() => Promise<UpdateCheckResult | null>>>;
    quitAndInstall: ReturnType<typeof vi.fn>;
    emit: (event: string, ...args: unknown[]) => void;
}

function createFakeUpdater(): FakeUpdater {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const checkForUpdates = vi.fn<() => Promise<UpdateCheckResult | null>>();
    const quitAndInstall = vi.fn();
    const updater = {
        autoDownload: false,
        autoInstallOnAppQuit: false,
        allowPrerelease: true,
        allowDowngrade: true,
        checkForUpdates,
        quitAndInstall,
        on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
            listeners.set(event, listener);
            return updater;
        }),
        removeListener: vi.fn((event: string) => {
            listeners.delete(event);
            return updater;
        }),
    };

    return {
        updater: updater as unknown as AppUpdater,
        checkForUpdates,
        quitAndInstall,
        emit: (event, ...args) => listeners.get(event)?.(...args),
    };
}

function createController(
    fake: FakeUpdater,
    unsupportedReason?: "disabled" | "development" | "package" | "platform",
): DesktopUpdater {
    return new DesktopUpdater(fake.updater, {
        currentVersion: "0.1.0-dev.2",
        resolveUnsupportedReason: async () => unsupportedReason,
        initialDelayMs: 50,
        pollIntervalMs: 100,
    });
}

function downloadedUpdate(version = "0.1.0"): UpdateDownloadedEvent {
    return {
        downloadedFile: "/tmp/aether-update.AppImage",
        version,
        files: [{ url: "Aether-0.1.0.AppImage", sha512: "checksum" }],
        path: "Aether-0.1.0.AppImage",
        sha512: "checksum",
        releaseDate: "2026-10-25T00:00:00.000Z",
        releaseName: "Aether 0.1.0",
        releaseNotes: "Aether release notes",
    };
}

describe("DesktopUpdater", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        upstreamListeners.clear();
        global.appQuitting = false;
        (global as unknown as { mainWindow?: unknown }).mainWindow = undefined;
    });

    afterEach(() => {
        vi.useRealTimers();
        global.appQuitting = false;
        (global as unknown as { mainWindow?: unknown }).mainWindow = undefined;
    });

    it("coalesces concurrent checks and reports when no update is available", async () => {
        const fake = createFakeUpdater();
        let resolveCheck!: (result: UpdateCheckResult | null) => void;
        fake.checkForUpdates.mockReturnValue(new Promise((resolve) => (resolveCheck = resolve)));
        const updater = createController(fake);
        await updater.start(true);

        const firstCheck = updater.checkForUpdates();
        const secondCheck = updater.checkForUpdates();
        expect(secondCheck).toBe(firstCheck);
        expect(fake.checkForUpdates).toHaveBeenCalledTimes(1);

        resolveCheck(null);
        await firstCheck;
        expect(updater.getState()).toMatchObject({ status: "idle", lastChecked: expect.any(Number) });
    });

    it("allows another check after a failure", async () => {
        const fake = createFakeUpdater();
        fake.checkForUpdates.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(null);
        const updater = createController(fake);
        await updater.start(true);

        await updater.checkForUpdates();
        expect(updater.getState()).toMatchObject({ status: "error", lastChecked: expect.any(Number) });

        await updater.checkForUpdates();
        expect(fake.checkForUpdates).toHaveBeenCalledTimes(2);
        expect(updater.getState().status).toBe("idle");
    });

    it("handles a rejected automatic download promise so the next check can retry", async () => {
        const fake = createFakeUpdater();
        let rejectDownload!: (error: Error) => void;
        const downloadPromise = new Promise<string[]>((_, reject) => (rejectDownload = reject));
        const updateInfo = {
            version: "0.1.0",
            files: [{ url: "Aether-0.1.0.AppImage", sha512: "checksum" }],
            path: "Aether-0.1.0.AppImage",
            sha512: "checksum",
            releaseDate: "2026-10-25T00:00:00.000Z",
        };
        fake.checkForUpdates
            .mockResolvedValueOnce({
                isUpdateAvailable: true,
                updateInfo,
                versionInfo: updateInfo,
                downloadPromise,
            })
            .mockResolvedValueOnce(null);
        const updater = createController(fake);
        await updater.start(true);

        const firstCheck = updater.checkForUpdates();
        await Promise.resolve();
        fake.emit("error", new Error("download failed"));
        rejectDownload(new Error("download failed"));
        await firstCheck;
        expect(updater.getState().status).toBe("error");

        await updater.checkForUpdates();
        expect(fake.checkForUpdates).toHaveBeenCalledTimes(2);
        expect(updater.getState().status).toBe("idle");
    });

    it("replays ready state and the legacy downloaded event after renderer reload", async () => {
        const fake = createFakeUpdater();
        const updater = createController(fake);
        await updater.start(true);
        fake.emit("update-available", { version: "0.1.0" });
        fake.emit("update-downloaded", downloadedUpdate());

        const emitter = new EventEmitter();
        const send = vi.fn();
        const webContents = Object.assign(emitter, { send }) as unknown as Electron.WebContents;
        updater.attachRenderer(webContents);
        emitter.emit("did-finish-load");

        expect(send).toHaveBeenCalledWith("aether:update-state", {
            status: "ready",
            currentVersion: "0.1.0-dev.2",
            version: "0.1.0",
            percent: 100,
        });
        expect(send).toHaveBeenCalledWith(
            "update-downloaded",
            expect.objectContaining({ releaseName: "Aether 0.1.0", releaseNotes: "Aether release notes" }),
        );
        expect(fake.quitAndInstall).not.toHaveBeenCalled();

        const mainWindowSend = vi.fn();
        (global as unknown as { mainWindow: unknown }).mainWindow = { webContents: { send: mainWindowSend } };
        await updater.checkForUpdates();
        expect(mainWindowSend).toHaveBeenCalledWith("aether:update-state", updater.getState());
        expect(mainWindowSend).toHaveBeenCalledWith("update-downloaded", expect.anything());
        expect(fake.checkForUpdates).not.toHaveBeenCalled();
    });

    it("publishes the native ready state before the legacy update event", async () => {
        const fake = createFakeUpdater();
        const updater = createController(fake);
        await updater.start(true);
        const send = vi.fn();
        (global as unknown as { mainWindow: unknown }).mainWindow = { webContents: { send } };
        const update = { ...downloadedUpdate(), releaseName: "Aether v0.1.0 release" };

        fake.emit("update-downloaded", update);

        expect(send.mock.calls.map(([channel]) => channel)).toEqual(["aether:update-state", "update-downloaded"]);
        expect(send).toHaveBeenNthCalledWith(1, "aether:update-state", {
            status: "ready",
            currentVersion: "0.1.0-dev.2",
            version: "0.1.0",
            percent: 100,
        });
        expect(send).toHaveBeenNthCalledWith(
            2,
            "update-downloaded",
            expect.objectContaining({ releaseName: "Aether v0.1.0 release" }),
        );
    });

    it("keeps download progress within the supported percentage range", async () => {
        const fake = createFakeUpdater();
        const updater = createController(fake);
        await updater.start(true);
        fake.emit("update-available", { version: "0.1.0" });
        fake.emit("download-progress", { percent: 42 });
        expect(updater.getState()).toMatchObject({ status: "downloading", percent: 42 });

        fake.emit("download-progress", { percent: Number.NaN });
        expect(updater.getState().percent).toBe(42);
        fake.emit("download-progress", { percent: 140 });
        expect(updater.getState().percent).toBe(100);
    });

    it("replays downloading state when another renderer check arrives during a download", async () => {
        const fake = createFakeUpdater();
        const updater = createController(fake);
        await updater.start(true);
        fake.emit("update-available", { version: "0.1.0" });
        const send = vi.fn();
        (global as unknown as { mainWindow: unknown }).mainWindow = { webContents: { send } };

        await updater.checkForUpdates();

        expect(send).toHaveBeenCalledWith("aether:update-state", {
            status: "downloading",
            currentVersion: "0.1.0-dev.2",
            version: "0.1.0",
        });
        expect(fake.checkForUpdates).not.toHaveBeenCalled();
    });

    it("disposes scheduled checks and update event handlers", async () => {
        const fake = createFakeUpdater();
        fake.checkForUpdates.mockResolvedValue(null);
        const updater = createController(fake);
        await updater.start(true);
        updater.dispose();

        await vi.advanceTimersByTimeAsync(500);

        expect(fake.checkForUpdates).not.toHaveBeenCalled();
        expect(fake.updater.removeListener).toHaveBeenCalledWith("update-downloaded", expect.any(Function));
    });

    it("uses stable-only update metadata for prerelease builds and never allows downgrade", async () => {
        const fake = createFakeUpdater();
        const updater = createController(fake);
        expect(fake.updater.autoInstallOnAppQuit).toBe(false);
        await updater.start(true);

        expect(fake.updater.allowPrerelease).toBe(false);
        expect(fake.updater.allowDowngrade).toBe(false);
        expect(fake.updater.autoDownload).toBe(true);
        expect(fake.updater.autoInstallOnAppQuit).toBe(true);
    });

    it("does not check or install before readiness, or install before a download is ready", async () => {
        const fake = createFakeUpdater();
        const updater = createController(fake);

        await updater.checkForUpdates();
        updater.installUpdate();
        expect(fake.checkForUpdates).not.toHaveBeenCalled();
        expect(fake.quitAndInstall).not.toHaveBeenCalled();

        await updater.start(true);
        updater.installUpdate();
        expect(fake.quitAndInstall).not.toHaveBeenCalled();
    });

    it("does not restart the app for a downloaded update when the app is already quitting", async () => {
        const fake = createFakeUpdater();
        const updater = createController(fake);
        await updater.start(true);
        fake.emit("update-downloaded", downloadedUpdate());
        global.appQuitting = true;

        updater.installUpdate();

        expect(fake.quitAndInstall).not.toHaveBeenCalled();
    });

    it("uses a silent restart only after the renderer explicitly asks to install a ready update", async () => {
        const fake = createFakeUpdater();
        const updater = createController(fake);
        await updater.start(true);
        fake.emit("update-downloaded", downloadedUpdate());

        updater.installUpdate();

        expect(fake.quitAndInstall).toHaveBeenCalledExactlyOnceWith(true, true);
        expect(global.appQuitting).toBe(true);
    });

    it("clears the quit guard if an explicit install request fails synchronously", async () => {
        const fake = createFakeUpdater();
        fake.quitAndInstall.mockImplementation(() => {
            throw new Error("installer unavailable");
        });
        const updater = createController(fake);
        await updater.start(true);
        fake.emit("update-downloaded", downloadedUpdate());

        updater.installUpdate();

        expect(global.appQuitting).toBe(false);
        expect(updater.getState().status).toBe("error");
    });

    it("marks unsupported packages and disables both the feed URL and update actions", async () => {
        const fake = createFakeUpdater();
        const updater = createController(fake, "package");
        await updater.start(true);

        expect(updater.getState()).toMatchObject({ status: "unsupported", reason: "package" });
        expect(updater.getFeedUrl()).toBeUndefined();
        expect(fake.updater.autoInstallOnAppQuit).toBe(false);
        await updater.checkForUpdates();
        updater.installUpdate();
        expect(fake.checkForUpdates).not.toHaveBeenCalled();
        expect(fake.quitAndInstall).not.toHaveBeenCalled();
    });

    it("honors --no-update and keeps a cached update from installing on quit", async () => {
        const fake = createFakeUpdater();
        const updater = createController(fake, "disabled");
        await updater.start(false);
        fake.emit("update-downloaded", downloadedUpdate());

        expect(updater.getState()).toMatchObject({ status: "unsupported", reason: "disabled" });
        expect(updater.getFeedUrl()).toBeUndefined();
        expect(fake.updater.autoInstallOnAppQuit).toBe(false);
        expect(fake.quitAndInstall).not.toHaveBeenCalled();
    });

    it("does not install when update IPC comes from an untrusted frame", async () => {
        const installUpdate = vi.spyOn(desktopUpdater, "installUpdate");
        const checkForUpdates = vi.spyOn(desktopUpdater, "checkForUpdates");
        const mainFrame = {};
        const webContents = { mainFrame };
        (global as unknown as { mainWindow: unknown }).mainWindow = { webContents };

        const checkHandler = ipcHandlers["check_updates"]!;
        const installHandler = ipcHandlers["install_update"]!;
        await checkHandler({ sender: {}, senderFrame: mainFrame });
        await installHandler({ sender: webContents, senderFrame: {} });

        expect(checkForUpdates).not.toHaveBeenCalled();
        expect(installUpdate).not.toHaveBeenCalled();
    });

    it("limits automatic updates to packaged NSIS and AppImage releases with Aether's GitHub metadata", async () => {
        const resourcesPath = await mkdtemp(path.join(tmpdir(), "aether-update-test-"));
        try {
            const environment = {
                enabled: true,
                isPackaged: true,
                platform: "win32" as NodeJS.Platform,
                resourcesPath,
                executablePath: path.join(resourcesPath, "Aether.exe"),
            };

            expect(await resolveRuntimeUnsupportedReason({ ...environment, enabled: false })).toBe("disabled");
            expect(await resolveRuntimeUnsupportedReason({ ...environment, isPackaged: false })).toBe("development");
            expect(await resolveRuntimeUnsupportedReason({ ...environment, platform: "darwin" })).toBe("platform");
            expect(await resolveRuntimeUnsupportedReason({ ...environment, platform: "linux" })).toBe("package");
            expect(await resolveRuntimeUnsupportedReason(environment)).toBe("package");

            await writeFile(
                path.join(resourcesPath, "app-update.yml"),
                "provider: github\nowner: chopin014\nrepo: Aether\n",
            );
            await writeFile(path.join(resourcesPath, "Uninstall Aether.exe"), "NSIS installer marker");
            expect(await resolveRuntimeUnsupportedReason(environment)).toBeUndefined();
            await writeFile(
                path.join(resourcesPath, "app-update.yml"),
                "provider: github\nowner: chopin014\nrepo: Aether\nhost: downloads.example.org\n",
            );
            expect(await resolveRuntimeUnsupportedReason(environment)).toBe("package");
            await writeFile(
                path.join(resourcesPath, "app-update.yml"),
                "provider: github\nowner: chopin014\nrepo: Aether\nhost: github.com\n",
            );
            expect(await resolveRuntimeUnsupportedReason(environment)).toBeUndefined();
            expect(
                await resolveRuntimeUnsupportedReason({
                    ...environment,
                    platform: "linux",
                    appImagePath: "/tmp/aether.AppImage",
                }),
            ).toBeUndefined();
        } finally {
            await rm(resourcesPath, { recursive: true, force: true });
        }
    });
});
