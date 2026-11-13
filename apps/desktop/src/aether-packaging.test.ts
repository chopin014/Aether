/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isBuiltin } from "node:module";
import { AppImageUpdater } from "electron-updater/out/AppImageUpdater.js";
import { ModuleKind, preProcessFile, transpileModule } from "typescript";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import config from "../aether-builder.ts";
import { validatePlatformArtifacts } from "../scripts/aether-release-validation.ts";
import { installAetherAppImage } from "../scripts/install-aether-appimage.ts";

async function writeValidPlatformArtifacts(
    directory: string,
    version: string,
    platform: "linux" | "win",
): Promise<void> {
    const installerNames =
        platform === "win"
            ? [`Aether-${version}-win-x64.exe`]
            : [`Aether-${version}-linux-x86_64.AppImage`, `Aether-${version}-linux-amd64.deb`];
    let files = "";
    for (const installerName of installerNames) {
        const installer = Buffer.from(`${installerName} bytes`);
        const sha512 = createHash("sha512").update(installer).digest("base64");
        await writeFile(path.join(directory, installerName), installer);
        files += `  - url: ${installerName}\n    sha512: ${sha512}\n`;
    }

    if (platform === "win") {
        await writeFile(path.join(directory, `${installerNames[0]}.blockmap`), "blockmap");
    }

    const manifestName = platform === "win" ? "latest.yml" : "latest-linux.yml";
    await writeFile(path.join(directory, manifestName), `version: ${version}\nfiles:\n${files}`);
}

describe("Aether distribution identity", () => {
    it.skipIf(process.platform !== "linux")(
        "keeps the installed launcher working after an AppImage update",
        async () => {
            const home = await mkdtemp(path.join(tmpdir(), "aether install "));
            const appImageEnvironment = process.env.APPIMAGE;
            try {
                const source = path.join(home, "Aether-0.1.6-linux-x86_64.AppImage");
                await writeFile(source, '#!/bin/sh\nprintf "%s\\n" "old version" "$@"\n');
                await installAetherAppImage(source, home);
                const installed = path.join(home, ".local/opt/aether/Aether.AppImage");
                const launcher = path.join(home, ".local/bin/aether");
                const launch = (): ReturnType<typeof spawnSync> =>
                    spawnSync(launcher, ["aether://example/room with spaces"], {
                        env: { ...process.env, HOME: home, ELECTRON_RUN_AS_NODE: "1" },
                        encoding: "utf8",
                    });
                expect(launch().stdout).toBe("old version\naether://example/room with spaces\n");
                const desktopEntry = readFileSync(path.join(home, ".local/share/applications/aether.desktop"), "utf8");
                expect(desktopEntry).toContain(`Exec="${launcher}" %U`);
                expect(desktopEntry).not.toContain("0.1.6");

                const update = path.join(home, "Aether-0.1.7-linux-x86_64.AppImage");
                await writeFile(update, '#!/bin/sh\nprintf "%s\\n" "updated version" "$@"\n', { mode: 0o755 });
                process.env.APPIMAGE = installed;
                const filenameUpdated = vi.fn();
                // Exercise electron-updater's real replacement logic without starting Electron or a download.
                const result = Reflect.apply(
                    Reflect.get(AppImageUpdater.prototype, "doInstall"),
                    {
                        installerPath: update,
                        emit: filenameUpdated,
                    },
                    [{ isForceRunAfter: false }],
                );
                expect(result).toBe(true);
                expect(filenameUpdated).not.toHaveBeenCalled();
                expect(launch().stdout).toBe("updated version\naether://example/room with spaces\n");
                expect(readFileSync(path.join(home, ".local/share/applications/aether.desktop"), "utf8")).toBe(
                    desktopEntry,
                );
            } finally {
                if (appImageEnvironment === undefined) delete process.env.APPIMAGE;
                else process.env.APPIMAGE = appImageEnvironment;
                await rm(home, { recursive: true, force: true });
            }
        },
    );

    it("preserves the installed AppImage if a replacement cannot be read", async () => {
        const home = await mkdtemp(path.join(tmpdir(), "aether-install-"));
        try {
            const source = path.join(home, "download.AppImage");
            await writeFile(source, "installed version");
            await installAetherAppImage(source, home);
            await expect(installAetherAppImage(path.join(home, "missing.AppImage"), home)).rejects.toThrow();
            expect(readFileSync(path.join(home, ".local/opt/aether/Aether.AppImage"), "utf8")).toBe(
                "installed version",
            );
            await writeFile(source, "reinstalled version");
            await installAetherAppImage(source, home);
            expect(readFileSync(path.join(home, ".local/opt/aether/Aether.AppImage"), "utf8")).toBe(
                "reinstalled version",
            );
        } finally {
            await rm(home, { recursive: true, force: true });
        }
    });

    it("ships the external runtime dependencies used during localization startup", () => {
        const source = readFileSync(new URL("./language-helper.ts", import.meta.url), "utf8");
        const { outputText } = transpileModule(source, { compilerOptions: { module: ModuleKind.ESNext } });
        const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
        const runtimeDependencies = new Set([
            ...Object.keys(manifest.dependencies),
            ...Object.keys(manifest.optionalDependencies),
        ]);
        const missingDependencies = preProcessFile(outputText)
            .importedFiles.map(({ fileName }) => fileName)
            .filter((name) => !name.startsWith(".") && !isBuiltin(name))
            .map((name) => (name.startsWith("@") ? name.split("/").slice(0, 2).join("/") : name.split("/")[0]))
            .filter((name) => !runtimeDependencies.has(name));

        expect(missingDependencies).toEqual([]);
    });

    it("isolates installation, profiles and callback URLs from Element", () => {
        expect(config.productName).toBe("Aether");
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
        expect(config.linux.target).toEqual(["AppImage", "deb"]);
        expect(config.linux.extraResources).toContainEqual({ from: "native-dist", to: "native/nvenc" });
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
    it("requires the Linux AppImage, the .deb and a manifest listing both", async () => {
        const directory = await mkdtemp(path.join(tmpdir(), "aether-linux-release-"));
        const version = "0.1.0";
        const appImageName = `Aether-${version}-linux-x86_64.AppImage`;
        const debName = `Aether-${version}-linux-amd64.deb`;

        try {
            await writeValidPlatformArtifacts(directory, version, "linux");
            await expect(validatePlatformArtifacts(directory, version, "linux")).resolves.toBeUndefined();

            const sha512 = createHash("sha512").update(`${appImageName} bytes`).digest("base64");
            await writeFile(
                path.join(directory, "latest-linux.yml"),
                `version: ${version}\nfiles:\n  - url: ${appImageName}\n    sha512: ${sha512}\n`,
            );
            await expect(validatePlatformArtifacts(directory, version, "linux")).rejects.toThrow(
                `latest-linux.yml does not reference the ${debName} updater artifact`,
            );

            await rm(path.join(directory, debName));
            await expect(validatePlatformArtifacts(directory, version, "linux")).rejects.toThrow(
                `Release asset is missing: ${debName}`,
            );
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
    it("rejects a Linux release containing a tar.gz package that cannot update", async () => {
        const directory = await mkdtemp(path.join(tmpdir(), "aether-manual-package-"));
        const version = "0.1.0";

        try {
            await writeValidPlatformArtifacts(directory, version, "linux");
            await writeFile(path.join(directory, `Aether-${version}-linux-x64.tar.gz`), "manual package");

            await expect(validatePlatformArtifacts(directory, version, "linux")).rejects.toThrow(
                "Linux release assets must only contain packages that update in the app",
            );
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
    it("reports a missing release artifact", async () => {
        const directory = await mkdtemp(path.join(tmpdir(), "aether-missing-artifact-"));
        const version = "0.1.0";

        try {
            await expect(validatePlatformArtifacts(directory, version, "linux")).rejects.toThrow(
                `Release asset is missing: Aether-${version}-linux-x86_64.AppImage`,
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
            expect(allPlatforms.stderr).toBe("");
            expect(allPlatforms.status).toBe(0);

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
    it("uses the packaged Aether logo as the renderer favicon", () => {
        expect(readFileSync("../web/res/vector-icons/512.png").equals(readFileSync("aether/icon.png"))).toBe(true);
        const manifest = JSON.parse(readFileSync("../web/res/manifest.json", "utf8"));
        for (const icon of manifest.icons) {
            const png = readFileSync(`../web/res${icon.src}`);
            expect(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`).toBe(icon.sizes);
        }
    });
    it("uses Aether in the renderer install and startup names", () => {
        const manifest = JSON.parse(readFileSync("../web/res/manifest.json", "utf8"));
        expect(manifest).toMatchObject({ name: "Aether", short_name: "Aether" });
        const html = readFileSync("../web/src/vector/index.html", "utf8");
        expect(html).toContain("<title>Aether</title>");
        expect(html).toContain('name="application-name" content="Aether"');
        expect(html).toContain('name="apple-mobile-web-app-title" content="Aether"');
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
