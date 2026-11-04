/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { chmod, copyFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Installs a per-user AppImage and desktop launcher without version-dependent paths.
 * @param source Downloaded Aether AppImage.
 * @param home User home directory containing the installation.
 */
export async function installAetherAppImage(source: string, home: string = homedir()): Promise<void> {
    const installDirectory = path.join(home, ".local/opt/aether");
    const binDirectory = path.join(home, ".local/bin");
    const applicationsDirectory = path.join(home, ".local/share/applications");
    const executable = path.join(installDirectory, "Aether.AppImage");
    await mkdir(installDirectory, { recursive: true });

    // Replace the directory entry so reinstalling also works while the old AppImage is mounted.
    const stagingDirectory = await mkdtemp(path.join(installDirectory, ".install-"));
    try {
        const stagedImage = path.join(stagingDirectory, "Aether.AppImage");
        await copyFile(source, stagedImage);
        await chmod(stagedImage, 0o755);
        await rename(stagedImage, executable);
    } finally {
        await rm(stagingDirectory, { recursive: true, force: true });
    }

    await mkdir(binDirectory, { recursive: true });
    await mkdir(applicationsDirectory, { recursive: true });
    await copyFile(new URL("../aether/icon.png", import.meta.url), path.join(installDirectory, "icon.png"));
    const launcher = path.join(binDirectory, "aether");
    await writeFile(
        launcher,
        '#!/bin/sh\nunset ELECTRON_RUN_AS_NODE\nexec "$HOME/.local/opt/aether/Aether.AppImage" "$@"\n',
    );
    await chmod(launcher, 0o755);

    // Desktop-entry values and quoted Exec arguments have separate escape rules.
    const desktopValue = (value: string): string =>
        value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\r", "\\r");
    const desktopQuote = (value: string): string =>
        `"${desktopValue(value.replace(/[\\`"$]/g, "\\$&")).replaceAll("%", "%%")}"`;
    await writeFile(
        path.join(applicationsDirectory, "aether.desktop"),
        [
            "[Desktop Entry]",
            "Type=Application",
            "Name=Aether",
            "Comment=Matrix messaging and Element Call",
            `Exec=${desktopQuote(launcher)} %U`,
            `TryExec=${desktopValue(launcher)}`,
            `Icon=${desktopValue(path.join(installDirectory, "icon.png"))}`,
            "Terminal=false",
            "Categories=Network;InstantMessaging;Chat;",
            "MimeType=x-scheme-handler/aether;",
            "StartupNotify=true",
            "StartupWMClass=Aether",
            "",
        ].join("\n"),
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    const source = process.argv[2];
    if (!source) throw new Error("Usage: node install-aether-appimage.ts /path/to/Aether.AppImage");
    await installAetherAppImage(path.resolve(source));
    console.log("Installed Aether. Launch it from the application menu or ~/.local/bin/aether.");
}
