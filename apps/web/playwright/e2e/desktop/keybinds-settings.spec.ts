/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type Page } from "@playwright/test";
import { closeReleaseAnnouncementIfExists, rejectToastIfExists } from "@element-hq/element-web-playwright-common";

import { test, expect } from "../../element-web-test";

test.use({
    displayName: "Alice",
    config: { features: { feature_desktop_shell: true } },
});

async function openKeyboard(page: Page): Promise<void> {
    await closeReleaseAnnouncementIfExists(page, "Introducing Sections");
    for (const title of ["Verify this device", "Notifications"]) await rejectToastIfExists(page, title);
    const account = page.getByRole("group", { name: "User menu" });
    await account.getByRole("button", { name: "User menu", exact: true }).hover();
    await account.getByRole("button", { name: "All settings" }).click();
    await page.getByRole("dialog").getByText("Keyboard", { exact: true }).click();
    await expect(page.getByRole("region", { name: "Keybinds" })).toBeVisible();
}

test("records, persists and clears call shortcuts, and blocks duplicate combinations", async ({
    pageWithCredentials: page,
}) => {
    await page.goto("/");
    await openKeyboard(page);
    const keybinds = page.getByRole("region", { name: "Keybinds" });
    await keybinds.getByRole("button", { name: "Toggle microphone Record keybind" }).click();
    await page.keyboard.press("Control+Shift+KeyM");
    await expect(keybinds.getByRole("button", { name: "Toggle microphone Ctrl + Shift + M" })).toBeVisible();
    await expect(keybinds.getByText("Available while Aether is focused")).toBeVisible();
    await keybinds.getByRole("button", { name: "Push to talk Record keybind" }).click();
    await page.keyboard.press("Control+Shift+KeyM");
    await expect(keybinds.getByText("This key is already in use. Choose another combination.")).toHaveCount(2);
    await keybinds.getByRole("button", { name: "Clear Push to talk keybind" }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).not.toBeVisible();
    const dock = page.getByRole("button", { name: "Mute", exact: true });
    await expect(dock).toBeVisible();
    await page.keyboard.press("Control+Shift+KeyM");
    await expect(page.getByRole("button", { name: "Unmute", exact: true })).toBeVisible();
    await page.reload();
    await openKeyboard(page);
    await expect(keybinds.getByRole("button", { name: "Toggle microphone Ctrl + Shift + M" })).toBeVisible();
    await keybinds.getByRole("button", { name: "Clear Toggle microphone keybind" }).click();
    await expect(keybinds.getByRole("button", { name: "Toggle microphone Record keybind" })).toBeVisible();
});
