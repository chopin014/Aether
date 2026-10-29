/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import electronUpdater from "electron-updater";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import config from "../aether-builder.ts";

const directories: string[] = [];

afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Aether's GitHub release feed", () => {
    it.each([
        { current: "0.1.0-dev.2", published: "0.1.0", available: true },
        { current: "0.1.0", published: "0.1.1", available: true },
        { current: "0.1.1", published: "0.1.0", available: false },
        { current: "0.1.0", published: "0.1.0", available: false },
    ])(
        "checks stable releases from $current without selecting a newer preview",
        async ({ current, published, available }) => {
            const directory = await mkdtemp(path.join(tmpdir(), "aether-github-feed-"));
            directories.push(directory);
            const updater = new electronUpdater.NsisUpdater(undefined, {
                version: current,
                name: "Aether",
                isPackaged: true,
                appUpdateConfigPath: path.join(directory, "app-update.yml"),
                userDataPath: directory,
                baseCachePath: directory,
                whenReady: async () => {},
                relaunch: vi.fn(),
                quit: vi.fn(),
                onQuit: vi.fn(),
            });
            updater.logger = null;
            updater.autoDownload = false;
            updater.allowPrerelease = false;
            updater.allowDowngrade = false;

            // Keep the actual GitHub provider and semver logic; replace its HTTP transport only.
            const requests: string[] = [];
            const request = vi.fn(async (options: { hostname: string; path: string }) => {
                expect(options.hostname).toBe("github.com");
                const requestPath = new URL(options.path, "https://github.com").pathname;
                requests.push(requestPath);
                if (requestPath.endsWith("releases.atom")) {
                    return `<feed>
                    <entry><title>Preview</title><link href="https://github.com/chopin014/Aether/releases/tag/v9.0.0-beta.1"/><content>Preview</content></entry>
                    <entry><title>Stable</title><link href="https://github.com/chopin014/Aether/releases/tag/v${published}"/><content>Stable</content></entry>
                </feed>`;
                }
                if (requestPath.endsWith("releases/latest")) return JSON.stringify({ tag_name: `v${published}` });
                if (/\/latest(?:-linux|-mac)?\.yml$/.test(requestPath)) {
                    return `version: ${published}
files:
  - url: Aether-${published}-win-x64.exe
    sha512: fixture-checksum
    size: 123
releaseDate: '2026-10-25T00:00:00.000Z'
`;
                }
                throw new Error(`Unexpected update request: ${requestPath}`);
            });
            Object.defineProperty(updater, "httpExecutor", { value: { request } });
            updater.setFeedURL({ ...config.publish[0], provider: "github" });

            const result = await updater.checkForUpdates();

            expect(result?.isUpdateAvailable).toBe(available);
            expect(result?.updateInfo.version).toBe(published);
            expect(result?.downloadPromise ?? null).toBeNull();
            expect(requests).toEqual([
                "/chopin014/Aether/releases.atom",
                "/chopin014/Aether/releases/latest",
                expect.stringMatching(new RegExp(`/releases/download/v${published.replaceAll(".", "\\.")}/latest`)),
            ]);
            expect(requests.some((url) => url.includes("beta"))).toBe(false);
        },
    );
});
