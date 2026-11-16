/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it, vi } from "vitest";

import {
    type DoNotDisturbSources,
    readGnomeDoNotDisturb,
    readInhibitedDoNotDisturb,
    SystemDoNotDisturb,
} from "./system-do-not-disturb.js";

function sources(overrides: Partial<DoNotDisturbSources> = {}): DoNotDisturbSources {
    return {
        platform: "linux",
        desktop: "GNOME",
        runCommand: vi.fn().mockResolvedValue("true\n"),
        readInhibited: vi.fn().mockResolvedValue(false),
        now: () => 0,
        ...overrides,
    };
}

describe("readGnomeDoNotDisturb", () => {
    it("reads Do Not Disturb as banners switched off", async () => {
        const runCommand = vi.fn().mockResolvedValue("false\n");
        await expect(readGnomeDoNotDisturb(runCommand)).resolves.toBe(true);
        expect(runCommand).toHaveBeenCalledWith("gsettings", [
            "get",
            "org.gnome.desktop.notifications",
            "show-banners",
        ]);
        await expect(readGnomeDoNotDisturb(vi.fn().mockResolvedValue("true\n"))).resolves.toBe(false);
    });

    it("cannot tell when gsettings fails or prints something else", async () => {
        await expect(readGnomeDoNotDisturb(vi.fn().mockRejectedValue(new Error("ENOENT")))).resolves.toBeUndefined();
        await expect(
            readGnomeDoNotDisturb(vi.fn().mockResolvedValue("No such key “show-banners”\n")),
        ).resolves.toBeUndefined();
    });
});

describe("readInhibitedDoNotDisturb", () => {
    it("reads the notification server's Inhibited property", async () => {
        await expect(readInhibitedDoNotDisturb(vi.fn().mockResolvedValue(true))).resolves.toBe(true);
        await expect(readInhibitedDoNotDisturb(vi.fn().mockResolvedValue(false))).resolves.toBe(false);
    });

    it("cannot tell when the server lacks the property or answers oddly", async () => {
        await expect(
            readInhibitedDoNotDisturb(vi.fn().mockRejectedValue(new Error("org.freedesktop.DBus.Error.InvalidArgs"))),
        ).resolves.toBeUndefined();
        await expect(readInhibitedDoNotDisturb(vi.fn().mockResolvedValue("yes"))).resolves.toBeUndefined();
    });
});

describe("SystemDoNotDisturb", () => {
    it.each(["GNOME", "ubuntu:GNOME", "Pop:GNOME"])("reads GNOME's switch on %s", async (desktop) => {
        const source = sources({ desktop, runCommand: vi.fn().mockResolvedValue("false\n") });
        await expect(new SystemDoNotDisturb(source).isActive()).resolves.toBe(true);
        expect(source.readInhibited).not.toHaveBeenCalled();
    });

    it.each(["KDE", "XFCE", undefined])("asks the notification server on %s", async (desktop) => {
        const source = sources({ desktop, readInhibited: vi.fn().mockResolvedValue(true) });
        await expect(new SystemDoNotDisturb(source).isActive()).resolves.toBe(true);
        expect(source.runCommand).not.toHaveBeenCalled();
    });

    it("cannot tell on a desktop whose notification server has no Inhibited property", async () => {
        const source = sources({ desktop: "sway", readInhibited: vi.fn().mockRejectedValue(new Error("no")) });
        await expect(new SystemDoNotDisturb(source).isActive()).resolves.toBeUndefined();
    });

    it.each(["win32", "darwin"] as const)("cannot tell on %s, and reads nothing", async (platform) => {
        const source = sources({ platform });
        await expect(new SystemDoNotDisturb(source).isActive()).resolves.toBeUndefined();
        expect(source.runCommand).not.toHaveBeenCalled();
        expect(source.readInhibited).not.toHaveBeenCalled();
    });

    it("reuses a reading for two seconds", async () => {
        let now = 1000;
        const runCommand = vi.fn().mockResolvedValue("false\n");
        const dnd = new SystemDoNotDisturb(sources({ runCommand, now: () => now }));

        await expect(dnd.isActive()).resolves.toBe(true);
        now += 1999;
        runCommand.mockResolvedValue("true\n");
        await expect(dnd.isActive()).resolves.toBe(true);
        expect(runCommand).toHaveBeenCalledTimes(1);

        now += 1;
        await expect(dnd.isActive()).resolves.toBe(false);
        expect(runCommand).toHaveBeenCalledTimes(2);
    });
});
