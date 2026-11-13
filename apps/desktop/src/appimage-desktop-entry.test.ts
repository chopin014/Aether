/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { getXdgDataHome, registerAppImageDesktopEntry } from "./appimage-desktop-entry.js";

describe("registerAppImageDesktopEntry", () => {
    let root: string;
    let dataHome: string;
    let iconSource: string;
    const entryPath = (): string => path.join(dataHome, "applications/aether.desktop");
    const iconPath = (): string => path.join(dataHome, "icons/hicolor/512x512/apps/aether.png");

    const register = (appImagePath: string): Promise<boolean> =>
        registerAppImageDesktopEntry({
            appImagePath,
            iconSource,
            dataHome,
            desktopName: "aether.desktop",
            protocol: "aether",
        });

    beforeEach(async () => {
        root = await mkdtemp(path.join(tmpdir(), "aether-appimage-entry-"));
        dataHome = path.join(root, "share");
        iconSource = path.join(root, "mount/resources/build/icon.png");
        await mkdir(path.dirname(iconSource), { recursive: true });
        await writeFile(iconSource, "png bytes");
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it("creates a launcher that handles sign-in links and shows the app icon", async () => {
        await expect(register("/home/user/Downloads/Aether-0.1.13-linux-x86_64.AppImage")).resolves.toBe(true);

        const entry = await readFile(entryPath(), "utf8");
        expect(entry).toContain('Exec="/home/user/Downloads/Aether-0.1.13-linux-x86_64.AppImage" %U\n');
        expect(entry).toContain("TryExec=/home/user/Downloads/Aether-0.1.13-linux-x86_64.AppImage\n");
        expect(entry).toContain("MimeType=x-scheme-handler/aether;\n");
        expect(entry).toContain(`Icon=${iconPath()}\n`);
        expect(entry).toContain("StartupWMClass=aether\n");
        await expect(readFile(iconPath(), "utf8")).resolves.toBe("png bytes");
    });

    it("points the launcher at the new file after an update renames the AppImage", async () => {
        await register("/home/user/Apps/Aether-0.1.13-linux-x86_64.AppImage");
        await register("/home/user/Apps/Aether-0.1.14-linux-x86_64.AppImage");

        const entry = await readFile(entryPath(), "utf8");
        expect(entry).toContain('Exec="/home/user/Apps/Aether-0.1.14-linux-x86_64.AppImage" %U\n');
        expect(entry).not.toContain("0.1.13");
    });

    it("does not rewrite an unchanged launcher", async () => {
        await register("/opt/Aether.AppImage");
        const before = await stat(entryPath());
        await new Promise((resolve) => setTimeout(resolve, 20));

        await register("/opt/Aether.AppImage");

        expect((await stat(entryPath())).mtimeMs).toBe(before.mtimeMs);
    });

    it("replaces a hand-made launcher without a program check", async () => {
        await mkdir(path.dirname(entryPath()), { recursive: true });
        await writeFile(entryPath(), '[Desktop Entry]\nName=Aether\nExec="/old/Aether.AppImage" %U\n');

        await expect(register("/new/Aether.AppImage")).resolves.toBe(true);

        expect(await readFile(entryPath(), "utf8")).toContain('Exec="/new/Aether.AppImage" %U\n');
    });

    it("keeps a working launcher from the install script", async () => {
        const launcher = path.join(root, "bin/aether");
        await mkdir(path.dirname(launcher), { recursive: true });
        await writeFile(launcher, "#!/bin/sh\n");
        await chmod(launcher, 0o755);
        const installed = `[Desktop Entry]\nExec="${launcher}" %U\nTryExec=${launcher}\n`;
        await mkdir(path.dirname(entryPath()), { recursive: true });
        await writeFile(entryPath(), installed);

        await expect(register("/home/user/Downloads/Aether.AppImage")).resolves.toBe(false);

        await expect(readFile(entryPath(), "utf8")).resolves.toBe(installed);
    });

    it("replaces a script launcher whose program was removed", async () => {
        await mkdir(path.dirname(entryPath()), { recursive: true });
        await writeFile(entryPath(), `[Desktop Entry]\nTryExec=${path.join(root, "missing/aether")}\n`);

        await expect(register("/home/user/Aether.AppImage")).resolves.toBe(true);
    });

    it("escapes paths with spaces, quotes and percent signs", async () => {
        await register('/home/user/My "Apps"/100% Aether.AppImage');

        expect(await readFile(entryPath(), "utf8")).toContain(
            'Exec="/home/user/My \\\\"Apps\\\\"/100%% Aether.AppImage" %U\n',
        );
    });
});

describe("getXdgDataHome", () => {
    it("uses XDG_DATA_HOME when it is an absolute path", () => {
        expect(getXdgDataHome({ XDG_DATA_HOME: "/data" }, "/home/user")).toBe("/data");
    });

    it("falls back to ~/.local/share", () => {
        expect(getXdgDataHome({}, "/home/user")).toBe("/home/user/.local/share");
        expect(getXdgDataHome({ XDG_DATA_HOME: "relative" }, "/home/user")).toBe("/home/user/.local/share");
    });
});
