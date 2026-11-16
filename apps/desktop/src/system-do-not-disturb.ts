/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { execFile } from "node:child_process";
import dbus from "@homebridge/dbus-native";

/** Runs a program and resolves to what it printed. */
export type CommandRunner = (file: string, args: string[]) => Promise<string>;
/** Reads the notification server's KDE `Inhibited` property, as decoded by the D-Bus library. */
export type InhibitedReader = () => Promise<unknown>;

/** Where the operating system's Do Not Disturb state is read from. */
export interface DoNotDisturbSources {
    platform: NodeJS.Platform;
    /** `XDG_CURRENT_DESKTOP`, such as `GNOME` or `KDE`. */
    desktop?: string;
    runCommand: CommandRunner;
    readInhibited: InhibitedReader;
    now: () => number;
}

/** How long a reading is reused: a burst of notifications asks many times within a second. */
const CACHE_MS = 2000;
const TIMEOUT_MS = 1000;

/**
 * GNOME's Do Not Disturb switch turns notification banners off (`show-banners` false). Firefox and Thunderbird read
 * the same key.
 */
export async function readGnomeDoNotDisturb(runCommand: CommandRunner): Promise<boolean | undefined> {
    try {
        const value = (
            await runCommand("gsettings", ["get", "org.gnome.desktop.notifications", "show-banners"])
        ).trim();
        if (value === "false") return true;
        if (value === "true") return false;
    } catch {
        // No gsettings, or no such key: the state cannot be read.
    }
    return undefined;
}

/**
 * KDE Plasma reports Do Not Disturb as the `Inhibited` property of the notification server, an extension of the
 * freedesktop notification specification that other servers may implement too.
 */
export async function readInhibitedDoNotDisturb(readInhibited: InhibitedReader): Promise<boolean | undefined> {
    try {
        const value = await readInhibited();
        return typeof value === "boolean" ? value : undefined;
    } catch {
        // The notification server does not have the property, or there is no session bus.
        return undefined;
    }
}

/**
 * Reads whether the operating system is in Do Not Disturb, so that Aether's own notification sounds can stay quiet
 * when the system hides notification banners.
 *
 * Supported: GNOME, and KDE Plasma or any notification server with the `Inhibited` property. Elsewhere, including
 * Windows, which has no documented interface for its Do Not Disturb switch, the state is unknown.
 */
export class SystemDoNotDisturb {
    private cached?: { at: number; value: Promise<boolean | undefined> };

    public constructor(private readonly sources: DoNotDisturbSources) {}

    /** @returns true when Do Not Disturb is on, false when it is off, undefined when it cannot be told. */
    public isActive(): Promise<boolean | undefined> {
        const now = this.sources.now();
        if (!this.cached || now - this.cached.at >= CACHE_MS) {
            this.cached = { at: now, value: this.read() };
        }
        return this.cached.value;
    }

    private async read(): Promise<boolean | undefined> {
        if (this.sources.platform !== "linux") return undefined;
        const desktops = (this.sources.desktop ?? "").toLowerCase().split(":");
        if (desktops.includes("gnome")) return readGnomeDoNotDisturb(this.sources.runCommand);
        return readInhibitedDoNotDisturb(this.sources.readInhibited);
    }
}

function runCommand(file: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(file, args, { timeout: TIMEOUT_MS, encoding: "utf8" }, (error, stdout) =>
            error ? reject(error) : resolve(stdout),
        );
    });
}

interface SessionBus {
    connection: { on: (event: string, listener: () => void) => void };
    invoke: (message: object, callback: (error: unknown, value: unknown) => void) => void;
}

/** Reads the KDE `Inhibited` property over a session bus connection opened on first use. */
function createInhibitedReader(): InhibitedReader {
    let bus: SessionBus | undefined;
    return () =>
        new Promise((resolve, reject) => {
            if (!bus) {
                // The maintained dbus-native fork's published types omit sessionBus.
                const opened = (dbus as unknown as { sessionBus: () => SessionBus }).sessionBus();
                const forget = (): void => {
                    if (bus === opened) bus = undefined;
                };
                opened.connection.on("error", forget);
                opened.connection.on("end", forget);
                bus = opened;
            }
            const timer = setTimeout(() => reject(new Error("Reading Inhibited timed out")), TIMEOUT_MS);
            bus.invoke(
                {
                    destination: "org.freedesktop.Notifications",
                    path: "/org/freedesktop/Notifications",
                    interface: "org.freedesktop.DBus.Properties",
                    member: "Get",
                    signature: "ss",
                    body: ["org.freedesktop.Notifications", "Inhibited"],
                },
                (error, value) => {
                    clearTimeout(timer);
                    if (error) {
                        reject(error instanceof Error ? error : new Error("Reading Inhibited failed"));
                        return;
                    }
                    // dbus-native decodes a variant as [signature tree, [value]].
                    resolve(Array.isArray(value) && Array.isArray(value[1]) ? value[1][0] : undefined);
                },
            );
        });
}

/** The Do Not Disturb state of the system the app runs on. */
export const systemDoNotDisturb = new SystemDoNotDisturb({
    platform: process.platform,
    desktop: process.env.XDG_CURRENT_DESKTOP,
    runCommand,
    readInhibited: createInhibitedReader(),
    now: Date.now,
});
