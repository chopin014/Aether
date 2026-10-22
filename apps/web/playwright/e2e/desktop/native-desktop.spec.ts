/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { _electron as electron } from "@playwright/test";
import { type EventType } from "matrix-js-sdk/src/matrix";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    buildConfigJson,
    populateLocalStorageWithCredentials,
    rejectToastIfExists,
    closeReleaseAnnouncementIfExists,
} from "@element-hq/element-web-playwright-common";

import { test, expect } from "../../element-web-test";
import { ElementAppPage } from "../../pages/ElementAppPage";

// The regular web suite does not install Electron or build the desktop host.
test.skip(!process.env.ELEMENT_DESKTOP_SMOKE, "Set ELEMENT_DESKTOP_SMOKE=1 after building Element Desktop");
test.use({
    displayName: "Alice",
    matrixRTC: true,
    config: {
        default_theme: "dark",
        features: {
            feature_desktop_shell: true,
            feature_video_rooms: true,
            feature_element_call_video_rooms: true,
            feature_element_call_react: true,
        },
        element_call: { disable: false, use_exclusively: true },
    },
});

test("the real Electron host runs the Matrix shell through its native preload", async ({
    credentials,
    homeserver,
    config,
    bot,
}, testInfo) => {
    test.setTimeout(120_000);
    const profile = await mkdtemp(path.join(tmpdir(), "element-desktop-shell-"));
    const configPath = path.join(profile, "config.json");
    config.brand = "Aether";
    await writeFile(configPath, JSON.stringify(buildConfigJson(homeserver.baseUrl, config)), { mode: 0o600 });
    const requireDesktop = createRequire(new URL("../../../../desktop/package.json", import.meta.url));
    const nativeEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (key !== "ELECTRON_RUN_AS_NODE" && value !== undefined) nativeEnv[key] = value;
    }
    const packaged = process.env.AETHER_PACKAGED_SMOKE === "1";
    const desktop = await electron.launch({
        executablePath: packaged
            ? fileURLToPath(new URL("../../../../desktop/dist/linux-smoke/aether", import.meta.url))
            : requireDesktop("electron"),
        args: [
            ...(packaged ? [] : [fileURLToPath(new URL("../../../../desktop/lib/electron-main.js", import.meta.url))]),
            "--profile-dir",
            profile,
            "--config",
            configPath,
        ],
        env: nativeEnv,
    });
    try {
        expect(await desktop.evaluate(({ app }) => app.getName())).toBe("Aether");
        const page = await desktop.firstWindow();
        await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 720));
        await populateLocalStorageWithCredentials(page, credentials);
        await page.reload();
        await page.waitForSelector(".mx_MatrixChat", { timeout: 60_000 });
        expect(new URL(page.url()).protocol).toBe("vector:");
        expect(await page.evaluate(() => "electron" in window)).toBe(true);
        await rejectToastIfExists(page, "Verify this device");
        await rejectToastIfExists(page, "Notifications");
        await closeReleaseAnnouncementIfExists(page, "Introducing Sections");
        const app = new ElementAppPage(page);
        const spaceId = await app.client.createRoom({ name: "Desktop studio", creation_content: { type: "m.space" } });
        const roomId = await app.client.createRoom({ name: "general", invite: [bot.credentials!.userId] });
        const designId = await app.client.createRoom({ name: "design" });
        const voiceId = await app.client.createRoom({
            name: "Lounge",
            creation_content: { type: "org.matrix.msc3417.call" },
        });
        await app.client.evaluate(
            async (client, { spaceId, roomIds }) => {
                for (const roomId of roomIds) {
                    await client.sendStateEvent(
                        spaceId,
                        "m.space.child" as EventType.SpaceChild,
                        { via: [client.getDomain()!] },
                        roomId,
                    );
                    await client.sendStateEvent(
                        roomId,
                        "m.space.parent" as EventType.SpaceParent,
                        { via: [client.getDomain()!], canonical: true },
                        spaceId,
                    );
                }
            },
            {
                spaceId,
                roomIds: [roomId, designId, voiceId],
            } as const,
        );
        await bot.sendMessage(roomId, "The desktop UI is running on Matrix. This message came from another member.");
        await app.viewSpaceByName("Desktop studio");
        await expect(page.locator(".mx_DesktopShell_titlebar")).toHaveText("Desktop studio");
        // Retain the vector protocol and preload while navigating within the desktop app.
        await page.evaluate((id) => {
            window.location.hash = `/room/${id}`;
        }, roomId);
        const composer = page.getByRole("textbox", { name: "Send an unencrypted message…" });
        await composer.fill("Sent from Element Desktop");
        await composer.press("Enter");
        await expect(page.getByRole("status", { name: "Your message was sent" })).toBeVisible();
        await expect(page.getByRole("group", { name: "User menu" })).toBeVisible();
        await expect(page.getByRole("button", { name: "Open room design", exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: "Toggle Text Channels section", exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: "Toggle Voice Channels section", exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: "Search Ctrl K" })).not.toBeVisible();
        const textChannels = page.getByRole("button", { name: "Toggle Text Channels section", exact: true });
        await textChannels.click();
        await expect(page.getByRole("button", { name: "Open room design", exact: true })).not.toBeVisible();
        await textChannels.click();
        await expect(page.getByRole("button", { name: "Open room design", exact: true })).toBeVisible();
        await page.mouse.move(1200, 15);
        await page.screenshot({ path: testInfo.outputPath("native-desktop.png") });
        await page.getByRole("button", { name: "2 members", exact: true }).click();
        await expect(page.getByRole("listbox", { name: "Member list" })).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath("native-members.png") });
        await page.getByRole("button", { name: "2 members", exact: true }).click();
        await page.getByRole("button", { name: "All settings", exact: true }).click();
        await expect(page.getByRole("dialog")).toBeVisible();
        await expect
            .poll(() => page.getByRole("dialog").evaluate((element) => element.scrollWidth <= element.clientWidth))
            .toBe(true);
        await page.screenshot({ path: testInfo.outputPath("native-settings.png") });
        if (process.env.ELEMENT_DESKTOP_REVIEW) {
            test.setTimeout(30 * 60_000);
            await page.keyboard.press("Escape");
            await page.waitForEvent("close", { timeout: 0 });
        }
        if (!page.isClosed()) await app.cleanup();
    } finally {
        await desktop.close();
        await rm(profile, { recursive: true, force: true });
    }
});
