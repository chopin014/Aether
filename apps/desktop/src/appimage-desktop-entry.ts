/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { access, constants, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** Key marking desktop entries that Aether wrote for itself and may rewrite. */
const MANAGED_KEY = "X-Aether-AppImage";

/** Where and how to register a running AppImage with the desktop. */
export interface AppImageDesktopEntryOptions {
    /** Absolute path of the running AppImage file (the `APPIMAGE` environment variable). */
    appImagePath: string;
    /** Icon inside the mounted AppImage. */
    iconSource: string;
    /** The user's data directory, `$XDG_DATA_HOME` or `~/.local/share`. */
    dataHome: string;
    /** Desktop entry file name, such as `aether.desktop`. It also names the window's app id. */
    desktopName: string;
    /** URL scheme the app handles, such as `aether`. */
    protocol: string;
}

/** Returns the user's data directory following the XDG base directory rules. */
export function getXdgDataHome(env: NodeJS.ProcessEnv, home: string): string {
    const dataHome = env.XDG_DATA_HOME;
    return dataHome && path.isAbsolute(dataHome) ? dataHome : path.join(home, ".local/share");
}

// Desktop-entry values and quoted Exec arguments have separate escape rules.
function desktopValue(value: string): string {
    return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\r", "\\r");
}

function desktopQuote(value: string): string {
    return `"${desktopValue(value.replace(/[\\`"$]/g, "\\$&")).replaceAll("%", "%%")}"`;
}

async function readIfExists(file: string): Promise<Buffer | undefined> {
    try {
        return await readFile(file);
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw e;
    }
}

function isManagedEntry(entry: string): boolean {
    return entry.split("\n").some((line) => line.startsWith(`${MANAGED_KEY}=`));
}

function getIconPath(dataHome: string, appId: string): string {
    return path.join(dataHome, "icons/hicolor/512x512/apps", `${appId}.png`);
}

/** A launcher from the install script or the user, whose program still exists, is left alone. */
async function isWorkingForeignEntry(entry: string): Promise<boolean> {
    if (isManagedEntry(entry)) return false;
    const tryExec = /^TryExec=(.+)$/m.exec(entry)?.[1];
    if (!tryExec || !path.isAbsolute(tryExec)) return false;
    try {
        await access(tryExec, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

async function writeIfChanged(file: string, content: Buffer): Promise<void> {
    const existing = await readIfExists(file);
    if (existing?.equals(content)) return;
    await mkdir(path.dirname(file), { recursive: true });
    // Write beside the target and rename, so the desktop never reads a half-written file.
    const staging = `${file}.${process.pid}.tmp`;
    await writeFile(staging, content);
    await rename(staging, file);
}

/**
 * Registers a running AppImage with the desktop: a launcher in the application menu, the taskbar icon and the
 * handler for sign-in links. An AppImage registers nothing when downloaded, and updates can rename the file, so
 * this runs on every launch and rewrites the entry whenever the AppImage path changes.
 * @returns whether the entry now points at this AppImage. False when a working launcher from elsewhere was kept.
 */
export async function registerAppImageDesktopEntry(options: AppImageDesktopEntryOptions): Promise<boolean> {
    const entryPath = path.join(options.dataHome, "applications", options.desktopName);
    const existing = await readIfExists(entryPath);
    if (existing && (await isWorkingForeignEntry(existing.toString("utf8")))) return false;

    const appId = options.desktopName.replace(/\.desktop$/, "");
    // The mounted AppImage disappears when the app quits, so the icon must be copied out of it.
    const iconPath = getIconPath(options.dataHome, appId);
    await writeIfChanged(iconPath, await readFile(options.iconSource));

    const entry = [
        "[Desktop Entry]",
        "Type=Application",
        "Name=Aether",
        "Comment=Matrix messaging and Element Call",
        `Exec=${desktopQuote(options.appImagePath)} %U`,
        `TryExec=${desktopValue(options.appImagePath)}`,
        `Icon=${desktopValue(iconPath)}`,
        "Terminal=false",
        "Categories=Network;InstantMessaging;Chat;",
        `MimeType=x-scheme-handler/${options.protocol};`,
        "StartupNotify=true",
        // Matches the window's app id, which is how the taskbar finds this entry's icon.
        `StartupWMClass=${appId}`,
        `${MANAGED_KEY}=true`,
        "",
    ].join("\n");
    await writeIfChanged(entryPath, Buffer.from(entry));
    return true;
}

/**
 * Removes the launcher and icon an AppImage wrote for itself. An installed package such as the .deb has its own
 * system launcher, and the user's copy would take its place and open the AppImage instead.
 * @param dataHome The user's data directory, `$XDG_DATA_HOME` or `~/.local/share`.
 * @param desktopName Desktop entry file name, such as `aether.desktop`.
 * @returns whether an AppImage launcher was removed.
 */
export async function removeAppImageDesktopEntry(dataHome: string, desktopName: string): Promise<boolean> {
    const entryPath = path.join(dataHome, "applications", desktopName);
    const existing = await readIfExists(entryPath);
    if (!existing || !isManagedEntry(existing.toString("utf8"))) return false;

    await rm(entryPath, { force: true });
    await rm(getIconPath(dataHome, desktopName.replace(/\.desktop$/, "")), { force: true });
    return true;
}
