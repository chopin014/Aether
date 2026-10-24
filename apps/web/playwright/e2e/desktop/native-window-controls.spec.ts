/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { _electron as electron } from "@playwright/test";
import {
    buildConfigJson,
    populateLocalStorageWithCredentials,
    rejectToastIfExists,
    closeReleaseAnnouncementIfExists,
} from "@element-hq/element-web-playwright-common";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { test, expect } from "../../element-web-test";
import { ElementAppPage } from "../../pages/ElementAppPage";
import { SettingLevel } from "../../../src/settings/SettingLevel";
import { readSampleFileSync } from "../../sample-files";

test.skip(!process.env.ELEMENT_DESKTOP_SMOKE, "Set ELEMENT_DESKTOP_SMOKE=1 after building Element Desktop");

for (const theme of ["dark", "light"] as const) {
    test.describe(`native window controls (${theme})`, () => {
        test.use({
            displayName: "Alice",
            config: { default_theme: theme, features: { feature_desktop_shell: true } },
        });

        test("keeps the viewer actions clear of native controls without a title strip", async ({
            credentials,
            homeserver,
            config,
        }, testInfo) => {
            test.setTimeout(120_000);
            const profile = await mkdtemp(path.join(tmpdir(), "aether-controls-test-"));
            const configPath = path.join(profile, "config.json");
            config.brand = "Aether";
            await writeFile(configPath, JSON.stringify(buildConfigJson(homeserver.baseUrl, config)), { mode: 0o600 });
            const requireDesktop = createRequire(new URL("../../../../desktop/package.json", import.meta.url));
            const nativeEnv = Object.fromEntries(
                Object.entries(process.env).filter(
                    ([key, value]) => key !== "ELECTRON_RUN_AS_NODE" && value !== undefined,
                ),
            ) as Record<string, string>;
            const desktop = await electron.launch({
                executablePath: requireDesktop("electron"),
                args: [
                    fileURLToPath(new URL("../../../../desktop", import.meta.url)),
                    "--profile-dir",
                    profile,
                    "--config",
                    configPath,
                ],
                env: nativeEnv,
            });
            try {
                const page = await desktop.firstWindow();
                // Record the values passed to the real native API; still apply every update to the host.
                await desktop.evaluate(({ BrowserWindow }) => {
                    const window = BrowserWindow.getAllWindows()[0];
                    const apply = window.setTitleBarOverlay.bind(window);
                    const state = globalThis as typeof globalThis & {
                        aetherThemeColors?: { color?: string; symbolColor?: string };
                    };
                    window.setTitleBarOverlay = (options) => {
                        state.aetherThemeColors = options;
                        apply(options);
                    };
                });
                await populateLocalStorageWithCredentials(page, credentials);
                await page.reload();
                await expect(page.locator(".mx_MatrixChat")).toBeVisible({ timeout: 60_000 });
                await expect
                    .poll(() => desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()))
                    .toBe(true);
                await desktop.evaluate(({ BrowserWindow }) => {
                    const window = BrowserWindow.getAllWindows()[0];
                    window.unmaximize();
                    window.setContentSize(1280, 720);
                });
                await page.setViewportSize({ width: 1280, height: 720 });
                await rejectToastIfExists(page, "Verify this device");
                await rejectToastIfExists(page, "Notifications");
                await closeReleaseAnnouncementIfExists(page, "Introducing Sections");
                const app = new ElementAppPage(page);
                const expectedColors =
                    theme === "light"
                        ? { color: "rgb(255, 255, 255)", symbolColor: "rgb(76, 80, 112)" }
                        : { color: "rgb(18, 20, 42)", symbolColor: "rgb(154, 156, 192)" };
                await expect
                    .poll(() =>
                        desktop.evaluate(
                            () =>
                                (
                                    globalThis as typeof globalThis & {
                                        aetherThemeColors?: { color?: string; symbolColor?: string };
                                    }
                                ).aetherThemeColors,
                        ),
                    )
                    .toEqual(expectedColors);
                await page.getByRole("button", { name: "Friends", exact: true }).click();
                const search = page.getByRole("searchbox", { name: "Search", exact: true });
                await expect(search).toBeVisible();
                expect(
                    await search.evaluate((input) => {
                        const style = getComputedStyle(input);
                        return { margin: style.margin, borderWidth: style.borderTopWidth };
                    }),
                ).toEqual({ margin: "0px", borderWidth: "0px" });
                await search.focus();
                await expect(search).toBeFocused();
                await page.screenshot({ path: testInfo.outputPath(`native-contacts-${theme}.png`) });
                const roomId = await app.client.createRoom({ name: "Window controls" });
                const upload = await app.client.uploadContent(readSampleFileSync("element.png", null), {
                    name: "image.png",
                    type: "image/png",
                });
                await app.client.sendMessage(roomId, {
                    msgtype: "m.image",
                    body: "image.png",
                    url: upload.content_uri,
                });
                await page.evaluate((id) => {
                    window.location.hash = `/room/${id}`;
                }, roomId);
                const header = page.locator(".mx_RoomHeader");
                await expect(header).toBeVisible();
                expect((await header.boundingBox())!.y).toBe(0);
                const controls = await page.evaluate(() => {
                    const probe = document.createElement("div");
                    probe.style.cssText =
                        "position:fixed;width:var(--mx-window-controls-inline-size);height:var(--mx-window-controls-block-size)";
                    document.body.appendChild(probe);
                    const size = { width: probe.offsetWidth, height: probe.offsetHeight };
                    probe.remove();
                    return size;
                });
                expect(controls.width).toBeGreaterThan(0);
                expect(controls.height).toBe(48);
                await page.locator(".mx_ImageBody").first().click();
                const viewer = page.locator(".mx_ImageView");
                await expect(viewer).toBeVisible();
                for (const action of await viewer.getByRole("button").all()) {
                    if (!(await action.isVisible())) continue;
                    const bounds = (await action.boundingBox())!;
                    expect(bounds.y >= controls.height || bounds.x + bounds.width <= 1280 - controls.width).toBe(true);
                }
                await page.screenshot({ path: testInfo.outputPath(`native-viewer-${theme}.png`) });
                const close = viewer.getByRole("button", { name: "Close", exact: true });
                await close.focus();
                await page.keyboard.press("Enter");
                await expect(viewer).not.toBeAttached();
                await expect(header).toBeVisible();
                expect(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
                const messageSearch = page.getByRole("combobox", { name: "Search", exact: true });
                await messageSearch.fill("has:file");
                await messageSearch.press("Enter");
                const results = page.getByRole("region", { name: "Search results", exact: true });
                const closeSearch = results.getByRole("button", { name: "Close search results" });
                await expect(closeSearch).toBeVisible();
                const closeBounds = (await closeSearch.boundingBox())!;
                expect(closeBounds.y).toBeGreaterThanOrEqual(controls.height);
                const searchBounds = (await messageSearch.boundingBox())!;
                expect(searchBounds.x + searchBounds.width).toBeLessThanOrEqual(1280 - controls.width);
                await page.screenshot({ path: testInfo.outputPath(`native-search-${theme}.png`) });
                await closeSearch.focus();
                await page.keyboard.press("Enter");
                await expect(results).not.toBeAttached();
                expect(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
                const nextTheme = theme === "light" ? "dark" : "light";
                await app.settings.setValue("theme", null, SettingLevel.DEVICE, nextTheme);
                await expect
                    .poll(() =>
                        desktop.evaluate(
                            () =>
                                (
                                    globalThis as typeof globalThis & {
                                        aetherThemeColors?: { color?: string };
                                    }
                                ).aetherThemeColors?.color,
                        ),
                    )
                    .toBe(nextTheme === "light" ? "rgb(255, 255, 255)" : "rgb(18, 20, 42)");
                await app.cleanup();
            } finally {
                await desktop.close();
                await rm(profile, { recursive: true, force: true });
            }
        });
    });
}
