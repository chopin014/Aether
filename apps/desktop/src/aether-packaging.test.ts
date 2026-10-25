/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import config from "../aether-builder.ts";
import { validatePlatformArtifacts } from "../scripts/aether-release-validation.ts";

async function writeValidPlatformArtifacts(
    directory: string,
    version: string,
    platform: "linux" | "win",
): Promise<void> {
    const stem = `Aether-${version}-${platform}-x64`;
    const installerName = `${stem}.${platform === "win" ? "exe" : "AppImage"}`;
    const installer = Buffer.from(`${platform} installer bytes`);
    const sha512 = createHash("sha512").update(installer).digest("base64");
    await writeFile(path.join(directory, installerName), installer);

    if (platform === "win") {
        await writeFile(path.join(directory, `${installerName}.blockmap`), "blockmap");
    } else {
        await writeFile(path.join(directory, `${stem}.deb`), "deb package");
        await writeFile(path.join(directory, `${stem}.tar.gz`), "tar package");
    }

    const manifestName = platform === "win" ? "latest.yml" : "latest-linux.yml";
    await writeFile(
        path.join(directory, manifestName),
        `version: ${version}\nfiles:\n  - url: ${installerName}\n    sha512: ${sha512}\n`,
    );
}

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
        expect(config.deb.recommends).toEqual([]);
    });
    it("configures public GitHub update metadata and unsigned Linux and Windows installers", () => {
        expect(config.publish).toEqual([
            {
                provider: "github",
                owner: "chopin014",
                repo: "Aether",
                private: false,
                channel: "latest",
            },
        ]);
        expect(config.generateUpdatesFilesForAllChannels).toBe(true);
        expect(config.linux.target).toEqual(["AppImage", "deb", "tar.gz"]);
        expect(config.linux.maintainer).toBe("Aether contributors <156453220+chopin014@users.noreply.github.com>");
        expect(config.win.target).toEqual(["nsis"]);
        expect(config.win.forceCodeSigning).toBe(false);
        expect(config.nsis).toMatchObject({ oneClick: false, perMachine: false, allowElevation: false });
        expect(config.extraResources).toContainEqual({ from: "aether", to: "build", filter: ["icon.*"] });
    });
    it("validates generated updater metadata against the real installer checksum", async () => {
        const directory = await mkdtemp(path.join(tmpdir(), "aether-release-"));
        const version = "0.1.0-dev.2";
        const installerName = `Aether-${version}-win-x64.exe`;
        const installer = Buffer.from("test installer bytes");
        const sha512 = createHash("sha512").update(installer).digest("base64");

        try {
            await writeFile(path.join(directory, installerName), installer);
            await writeFile(path.join(directory, `${installerName}.blockmap`), "blockmap");
            await writeFile(
                path.join(directory, "latest.yml"),
                `version: ${version}\nfiles:\n  - url: ${installerName}\n    sha512: ${sha512}\n`,
            );

            await expect(validatePlatformArtifacts(directory, version, "win")).resolves.toBeUndefined();

            const blockmapSha512 = createHash("sha512").update("blockmap").digest("base64");
            await writeFile(
                path.join(directory, "latest.yml"),
                `version: ${version}\nfiles:\n  - url: ${installerName}.blockmap\n    sha512: ${blockmapSha512}\n`,
            );
            await expect(validatePlatformArtifacts(directory, version, "win")).rejects.toThrow(
                `latest.yml does not reference the ${installerName} updater artifact`,
            );

            await writeFile(
                path.join(directory, "latest.yml"),
                `version: ${version}\nfiles:\n  - url: ${installerName}\n    sha512: ${sha512}\n`,
            );
            await writeFile(path.join(directory, installerName), "modified installer bytes");
            await expect(validatePlatformArtifacts(directory, version, "win")).rejects.toThrow(
                `latest.yml has an incorrect SHA-512 checksum for ${installerName}`,
            );
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
    it("requires the Linux AppImage and Linux update manifest", async () => {
        const directory = await mkdtemp(path.join(tmpdir(), "aether-linux-release-"));
        const version = "0.1.0";
        const appImageName = `Aether-${version}-linux-x64.AppImage`;
        const appImage = Buffer.from("test AppImage bytes");
        const sha512 = createHash("sha512").update(appImage).digest("base64");

        try {
            await writeFile(path.join(directory, appImageName), appImage);
            await writeFile(path.join(directory, `Aether-${version}-linux-x64.deb`), "deb package");
            await writeFile(path.join(directory, `Aether-${version}-linux-x64.tar.gz`), "tar package");
            await writeFile(
                path.join(directory, "latest-linux.yml"),
                `version: ${version}\nfiles:\n  - url: ${appImageName}\n    sha512: ${sha512}\n`,
            );

            await expect(validatePlatformArtifacts(directory, version, "linux")).resolves.toBeUndefined();
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
    it("reports a missing release artifact", async () => {
        const directory = await mkdtemp(path.join(tmpdir(), "aether-missing-artifact-"));
        const version = "0.1.0";

        try {
            await expect(validatePlatformArtifacts(directory, version, "linux")).rejects.toThrow(
                `Release asset is missing: Aether-${version}-linux-x64.AppImage`,
            );
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
    it("rejects malformed updater YAML", async () => {
        const directory = await mkdtemp(path.join(tmpdir(), "aether-malformed-manifest-"));
        const version = "0.1.0";

        try {
            await writeValidPlatformArtifacts(directory, version, "win");
            await writeFile(path.join(directory, "latest.yml"), `version: [${version}\nfiles: [`);

            await expect(validatePlatformArtifacts(directory, version, "win")).rejects.toThrow();
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
    it("rejects an updater manifest with a different version", async () => {
        const directory = await mkdtemp(path.join(tmpdir(), "aether-wrong-version-"));
        const version = "0.1.0";

        try {
            await writeValidPlatformArtifacts(directory, version, "win");
            await writeFile(path.join(directory, "latest.yml"), `version: 0.2.0\nfiles: []\n`);

            await expect(validatePlatformArtifacts(directory, version, "win")).rejects.toThrow(
                `latest.yml contains version 0.2.0; expected ${version}`,
            );
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
    it("rejects updater manifests with no file metadata", async () => {
        const directory = await mkdtemp(path.join(tmpdir(), "aether-empty-manifest-"));
        const version = "0.1.0";

        try {
            await writeValidPlatformArtifacts(directory, version, "win");
            await writeFile(path.join(directory, "latest.yml"), `version: ${version}\nfiles: []\n`);

            await expect(validatePlatformArtifacts(directory, version, "win")).rejects.toThrow(
                "latest.yml does not contain updater file metadata",
            );
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
    it("rejects malformed percent encoding in updater asset URLs", async () => {
        const directory = await mkdtemp(path.join(tmpdir(), "aether-invalid-asset-url-"));
        const version = "0.1.0";
        const installer = Buffer.from("win installer bytes");
        const sha512 = createHash("sha512").update(installer).digest("base64");

        try {
            await writeValidPlatformArtifacts(directory, version, "win");
            await writeFile(
                path.join(directory, "latest.yml"),
                `version: ${version}\nfiles:\n  - url: "%E0%A4%A"\n    sha512: ${sha512}\n`,
            );

            await expect(validatePlatformArtifacts(directory, version, "win")).rejects.toThrow(
                "latest.yml contains an invalid updater asset URL: %E0%A4%A",
            );
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
    it("validates all release artifacts and rejects unsupported CLI platforms", async () => {
        const directory = await mkdtemp(path.join(tmpdir(), "aether-release-cli-"));
        const version = "0.1.0";
        const scriptPath = path.resolve("scripts/aether-release-validation.ts");

        try {
            await writeValidPlatformArtifacts(directory, version, "linux");
            await writeValidPlatformArtifacts(directory, version, "win");

            const allPlatforms = spawnSync(process.execPath, [scriptPath, "all", version, directory], {
                encoding: "utf8",
            });
            expect(allPlatforms.error).toBeUndefined();
            expect(allPlatforms.status, allPlatforms.stderr).toBe(0);

            const unsupportedPlatform = spawnSync(process.execPath, [scriptPath, "mac", version, directory], {
                encoding: "utf8",
            });
            expect(unsupportedPlatform.error).toBeUndefined();
            expect(unsupportedPlatform.status).not.toBe(0);
            expect(unsupportedPlatform.stderr).toContain(
                "Usage: node scripts/aether-release-validation.ts <linux|win|all> <version> [directory]",
            );
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
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
