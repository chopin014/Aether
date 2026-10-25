/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";

import config from "../aether-builder.ts";

describe("Aether distribution identity", () => {
    it("isolates installation, profiles and callback URLs from Element", () => {
        expect(config.appId).toBe("io.github.chopin014.aether");
        expect(config.extraMetadata).toMatchObject({
            name: "aether",
            productName: "Aether",
            desktopName: "aether.desktop",
            electron_protocol: "aether",
        });
        expect(config.protocols.schemes).toEqual(["aether"]);
        expect(config.linux.executableName).toBe("aether");
        expect(config.deb.recommends).toEqual(["pulseaudio-utils", "x11-utils"]);
    });
    it("prepares Linux and Windows artifacts without publishing", () => {
        expect(config.publish).toBeNull();
        expect(config.linux.target).toEqual(["AppImage", "deb", "tar.gz"]);
        expect(config.linux.maintainer).toBe("Aether contributors <156453220+chopin014@users.noreply.github.com>");
        expect(config.win.target).toEqual(["nsis"]);
        expect(config.win.extraResources).toContainEqual({
            from: "native/share-audio/windows/build/Release/aether-share-audio.exe",
            to: "share-audio/aether-share-audio.exe",
        });
        expect(config.extraResources).toContainEqual({ from: "aether", to: "build", filter: ["icon.*"] });
    });
    it("ships the brand icon at every size Linux and Windows request", () => {
        const png = readFileSync("aether/icon.png");
        expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([512, 512]);
        const ico = readFileSync("aether/icon.ico");
        // A width byte of 0 means 256 px in the ICO directory.
        const sizes = Array.from({ length: ico.readUInt16LE(4) }, (_, i) => ico[6 + i * 16] || 256);
        expect(sizes).toEqual([16, 24, 32, 48, 64, 128, 256]);
    });
    it("brands the sign-in screens with files the web app serves", () => {
        const { branding } = JSON.parse(readFileSync("config.desktop.json", "utf8"));
        expect(branding).toEqual({
            auth_header_logo_url: "themes/aether/symbol.svg",
            welcome_background_url: "themes/aether/background.svg",
        });
        for (const url of Object.values<string>(branding)) {
            expect(existsSync(`../web/res/${url}`)).toBe(true);
        }
    });
    it("ships the Matrix desktop shell and Element Call without an upstream update feed", () => {
        const renderer = JSON.parse(readFileSync("config.desktop.json", "utf8"));
        expect(renderer.brand).toBe("Aether");
        expect(renderer.features.feature_desktop_shell).toBe(true);
        expect(renderer.element_call.use_exclusively).toBe(true);
        expect(renderer.update_base_url).toBeUndefined();
        expect(renderer.posthog).toBeUndefined();
        expect(renderer.bug_report_endpoint_url).toBeUndefined();
    });
});
