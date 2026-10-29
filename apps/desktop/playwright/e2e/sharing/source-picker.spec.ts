/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import fs from "node:fs/promises";
import path from "node:path";

import { test, expect } from "../../element-desktop-test.js";

const sources = [
    { id: "window:123:0", name: "Aether test window", thumbnailURL: "" },
    { id: "screen:0:0", name: "Aether test screen", thumbnailURL: "" },
];

for (const theme of ["dark", "light"] as const) {
    test.describe(`Desktop source picker, ${theme}`, () => {
        test.use({
            extraArgs: ["--storage-mode", "force-plaintext", "--disable-gpu", "--ozone-platform=x11"],
            extraEnv: async ({ tmpDir }, use) => {
                const configPath = path.join(tmpDir, "sharing-config.json");
                await fs.writeFile(
                    configPath,
                    JSON.stringify({
                        brand: "Aether",
                        default_theme: theme,
                        features: { feature_desktop_shell: true },
                        element_call: {
                            media_quality: {
                                screen_share: { max_resolution: 540, max_framerate: 12, max_bitrate: 750_000 },
                            },
                        },
                    }),
                );
                await use({ ELEMENT_DESKTOP_CONFIG_JSON: configPath });
            },
        });

        test("selects a source and capped quality, and cancels without sharing", async ({ app, page }, testInfo) => {
            test.slow();
            await expect(page.locator("#matrixchat")).toBeVisible();
            await page.reload();
            await expect(page.getByRole("heading", { name: "Welcome to Aether" })).toBeVisible();
            page.on("pageerror", (error) => console.error("Picker renderer error:", error));
            // Stub OS enumeration while retaining the renderer IPC and production modal.
            await app.evaluate(({ desktopCapturer, nativeImage }, availableSources) => {
                desktopCapturer.getSources = async () =>
                    availableSources.map((source) => ({
                        id: source.id,
                        name: source.name,
                        display_id: "",
                        appIcon: nativeImage.createEmpty(),
                        thumbnail: nativeImage.createFromBitmap(Buffer.from(new Uint8Array(320 * 180 * 4).fill(128)), {
                            width: 320,
                            height: 180,
                        }),
                    }));
            }, sources);
            await app.evaluate(({ ipcMain }) => {
                const state = globalThis as typeof globalThis & { aetherPickedSource?: string | null };
                ipcMain.on("ipcCall", (_event, payload: { name: string; args: [{ id: string }] }) => {
                    if (payload.name === "callDisplayMediaCallback") state.aetherPickedSource = payload.args[0].id;
                });
            });

            const openPicker = async (): Promise<void> => {
                await app.evaluate(({ BrowserWindow }) => {
                    const state = globalThis as typeof globalThis & { aetherPickedSource?: string | null };
                    state.aetherPickedSource = null;
                    BrowserWindow.getAllWindows()[0].webContents.send("openDesktopCapturerSourcePicker");
                });
            };
            const capture = async (name: string): Promise<void> => {
                await page.getByRole("dialog").evaluate(async (element) => {
                    await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished));
                });
                await page.evaluate(
                    () =>
                        new Promise<void>((resolve) => {
                            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
                        }),
                );
                const dataUrl = await app.evaluate(async ({ BrowserWindow }) =>
                    (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toDataURL(),
                );
                await fs.writeFile(testInfo.outputPath(name), Buffer.from(dataUrl.split(",")[1], "base64"));
            };
            const pickedSource = (): Promise<string | null> =>
                app.evaluate(
                    () => (globalThis as typeof globalThis & { aetherPickedSource: string | null }).aetherPickedSource,
                );

            await openPicker();
            const picker = page.getByRole("dialog", { name: "Share your screen" });
            await expect(picker).toBeVisible();
            const next = picker.getByRole("button", { name: "Next", exact: true });
            await expect(next).toBeDisabled();
            const windowSource = picker.getByRole("button", { name: "Aether test window", exact: true });
            await windowSource.focus();
            await page.keyboard.press("Space");
            await expect(windowSource).toHaveAttribute("aria-pressed", "true");
            await expect(next).toBeEnabled();
            await capture(`share-source-${theme}.png`);
            await next.click();
            await expect(picker.getByRole("button", { name: "540p", exact: true })).toHaveAttribute(
                "aria-pressed",
                "true",
            );
            await expect(picker.getByRole("button", { name: "720p", exact: true })).toBeDisabled();
            await expect(picker.getByRole("button", { name: "12 FPS", exact: true })).toHaveAttribute(
                "aria-pressed",
                "true",
            );
            await expect(picker.getByRole("button", { name: "30 FPS", exact: true })).toBeDisabled();
            await expect(picker.getByRole("button", { name: "1.5 Mbps", exact: true })).toBeDisabled();
            await expect(picker.getByText("Screen audio is unavailable for this capture method.")).toBeVisible();
            await capture(`share-quality-${theme}.png`);
            await page.keyboard.press("Escape");
            await expect(picker).not.toBeVisible();
            await expect.poll(pickedSource).toBe("");

            await openPicker();
            await expect(picker).toBeVisible();
            await picker.getByRole("tab", { name: "Application window", exact: true }).focus();
            await page.keyboard.press("ArrowRight");
            await expect(picker.getByRole("tab", { name: "Entire screen", exact: true })).toBeFocused();
            await picker.getByRole("button", { name: "Aether test screen", exact: true }).click();
            await next.click();
            await picker.getByRole("button", { name: "0.75 Mbps", exact: true }).click();
            await picker.getByRole("button", { name: "Share", exact: true }).click();
            await expect(picker).not.toBeVisible();
            await expect.poll(pickedSource).toBe("screen:0:0");
        });
    });
}
