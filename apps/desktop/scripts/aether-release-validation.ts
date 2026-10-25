/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Reuse the YAML parser electron-builder already installs instead of adding a release-only dependency.
const builderRequire = createRequire(import.meta.resolve("app-builder-lib"));
const parseYaml = (builderRequire("js-yaml") as { load: (source: string) => unknown }).load;

/** Platform whose release artifacts are checked. */
export type AetherReleasePlatform = "linux" | "win";

interface UpdateFile {
    url: string;
    sha512: string;
}

interface UpdateManifest {
    version: string;
    files: UpdateFile[];
}

function getManifestName(platform: AetherReleasePlatform): string {
    const suffix = platform === "linux" ? "-linux" : "";
    return `latest${suffix}.yml`;
}

async function getSha512(filePath: string): Promise<string> {
    const hash = createHash("sha512");
    const stream = createReadStream(filePath);
    for await (const chunk of stream) hash.update(chunk);
    return hash.digest("base64");
}

function assertExists(files: Set<string>, fileName: string): void {
    if (!files.has(fileName)) throw new Error(`Release asset is missing: ${fileName}`);
}

function isUpdateManifest(value: unknown): value is UpdateManifest {
    if (typeof value !== "object" || value === null) return false;

    const manifest = value as Partial<UpdateManifest>;
    return (
        typeof manifest.version === "string" &&
        Array.isArray(manifest.files) &&
        manifest.files.every(
            (file) =>
                typeof file === "object" &&
                file !== null &&
                typeof file.url === "string" &&
                typeof file.sha512 === "string",
        )
    );
}

/**
 * Checks that a platform's release assets and generated updater metadata agree.
 *
 * @param directory Directory containing one platform's electron-builder output.
 * @param version Semantic version to verify.
 * @param platform Platform whose artifacts should be present.
 */
export async function validatePlatformArtifacts(
    directory: string,
    version: string,
    platform: AetherReleasePlatform,
): Promise<void> {
    const names = new Set(await readdir(directory));
    // electron-builder uses each Linux format's native architecture name.
    const installerNames =
        platform === "win"
            ? [`Aether-${version}-win-x64.exe`]
            : [
                  `Aether-${version}-linux-x86_64.AppImage`,
                  `Aether-${version}-linux-amd64.deb`,
                  `Aether-${version}-linux-x64.tar.gz`,
              ];

    for (const installerName of installerNames) assertExists(names, installerName);

    if (platform === "win") assertExists(names, `${installerNames[0]}.blockmap`);

    const manifestName = getManifestName(platform);
    assertExists(names, manifestName);
    const manifestText = await readFile(path.join(directory, manifestName), "utf8");
    const manifest = parseYaml(manifestText);

    if (!isUpdateManifest(manifest)) throw new Error(`${manifestName} is not valid updater metadata`);
    if (manifest.version !== version)
        throw new Error(`${manifestName} contains version ${manifest.version}; expected ${version}`);
    if (manifest.files.length === 0) {
        throw new Error(`${manifestName} does not contain updater file metadata`);
    }

    const expectedUpdateAsset = installerNames[0];
    const referencedAssets = new Set<string>();
    for (const entry of manifest.files) {
        let assetName: string;
        try {
            assetName = decodeURIComponent(path.basename(entry.url.split(/[?#]/, 1)[0]));
        } catch {
            throw new Error(`${manifestName} contains an invalid updater asset URL: ${entry.url}`);
        }

        assertExists(names, assetName);
        referencedAssets.add(assetName);
        const assetHash = await getSha512(path.join(directory, assetName));
        if (assetHash !== entry.sha512)
            throw new Error(`${manifestName} has an incorrect SHA-512 checksum for ${assetName}`);
    }

    if (!referencedAssets.has(expectedUpdateAsset)) {
        throw new Error(`${manifestName} does not reference the ${expectedUpdateAsset} updater artifact`);
    }
}

async function validateAllArtifacts(directory: string, version: string): Promise<void> {
    await validatePlatformArtifacts(directory, version, "linux");
    await validatePlatformArtifacts(directory, version, "win");
}

async function main(): Promise<void> {
    const [platform, version, directory = "dist"] = process.argv.slice(2);
    if ((platform !== "linux" && platform !== "win" && platform !== "all") || version == null) {
        throw new Error("Usage: node scripts/aether-release-validation.ts <linux|win|all> <version> [directory]");
    }

    if (platform === "all") {
        await validateAllArtifacts(directory, version);
    } else {
        await validatePlatformArtifacts(directory, version, platform);
    }
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main();
}
