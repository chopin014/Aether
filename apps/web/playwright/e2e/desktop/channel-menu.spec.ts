/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { closeReleaseAnnouncementIfExists, rejectToast } from "@element-hq/element-web-playwright-common";
import { type Page } from "@playwright/test";

import { test as base, expect } from "../../element-web-test";

const CAPTURES = "/tmp/aether-channel-menu-captures";
const TOPIC = "Release planning and everyday chatter";

const test = base.extend<{ roomId: string }>({
    roomId: [
        async ({ app, bot }, use) => {
            const roomId = await app.client.createRoom({ name: "general", topic: TOPIC });
            await app.client.inviteUser(roomId, bot.credentials!.userId);
            await bot.joinRoom(roomId);
            await app.viewRoomById(roomId);
            await use(roomId);
        },
        { auto: true },
    ],
});

test.use({ displayName: "Alice", botCreateOpts: { displayName: "Robin" } });

const channelName = (page: Page) => page.getByRole("banner").getByRole("button", { name: "general", exact: true });
const menu = (page: Page) => page.getByRole("menu");

async function dismissToasts(page: Page): Promise<void> {
    await rejectToast(page, "Verify this device");
    await rejectToast(page, "Notifications");
    await closeReleaseAnnouncementIfExists(page, "Introducing Sections");
}

for (const theme of ["dark", "light"] as const) {
    test.describe(`desktop shell, ${theme} theme`, () => {
        test.use({ config: { default_theme: theme, features: { feature_desktop_shell: true } } });
        test.beforeEach(async ({ page, user }) => dismissToasts(page));

        test("opens the channel menu from the name, with Escape and focus return", async ({ page, roomId }) => {
            const trigger = channelName(page);
            await expect(trigger).toHaveAttribute("aria-haspopup", "menu");
            await trigger.click();
            await expect(menu(page)).toBeVisible();
            for (const name of ["Mark as read", "Invite to channel", "Copy link", "Mute channel", "Edit channel"]) {
                await expect(menu(page).getByRole("menuitem", { name })).toBeVisible();
            }
            await expect(menu(page).getByRole("menuitem", { name: /^(People|Threads|Pinned)/ })).toHaveCount(0);
            // No room info card opens beside it.
            await expect(page.locator(".mx_RoomSummaryCard")).toHaveCount(0);
            await page.screenshot({ path: `${CAPTURES}/header-menu-${theme}.png` });

            await page.keyboard.press("Escape");
            await expect(menu(page)).not.toBeVisible();
            await expect(trigger).toBeFocused();
        });

        test("toggles favourite and opens the room settings from Edit channel", async ({ page }) => {
            await channelName(page).click();
            await menu(page).getByRole("menuitemcheckbox", { name: "Favourite" }).click();
            await expect(menu(page)).not.toBeVisible();
            await channelName(page).click();
            await expect(menu(page).getByRole("menuitemcheckbox", { name: "Favourite" })).toBeChecked();
            await menu(page).getByRole("menuitem", { name: "Edit channel" }).click();
            await expect(page.locator(".mx_RoomSettingsDialog")).toBeVisible();
        });

        test("opens Files in the header search and keeps the channel name readable", async ({
            page,
            app,
            roomId,
        }, testInfo) => {
            const { content_uri: url } = await app.client.uploadContent(Buffer.from("preview notes"), {
                name: "preview-notes.txt",
                type: "text/plain",
            });
            await app.client.sendMessage(roomId, { msgtype: "m.file", body: "preview-notes.txt", url });
            await channelName(page).click();
            await menu(page).getByRole("menuitem", { name: "Files", exact: true }).click();
            const results = page.getByRole("region", { name: "Search results", exact: true });
            await expect(results.getByText("preview-notes.txt").first()).toBeVisible();
            await expect(page.getByRole("button", { name: "Remove filter has:file" })).toBeVisible();
            await expect(page.locator(".mx_RoomSummaryCard")).toHaveCount(0);
            const resultBounds = await results.boundingBox();
            const headerBounds = await page.getByRole("banner").boundingBox();
            expect(resultBounds!.y).toBeGreaterThanOrEqual(headerBounds!.y + headerBounds!.height);
            const heading = channelName(page).getByRole("heading", { level: 1 });
            await expect
                .poll(() =>
                    heading.evaluate((element) => {
                        const range = document.createRange();
                        range.selectNodeContents(element);
                        return element.getBoundingClientRect().width + 1 >= range.getBoundingClientRect().width;
                    }),
                )
                .toBe(true);
            await page.screenshot({ path: testInfo.outputPath(`combined-files-${theme}.png`) });
            await page.getByRole("combobox", { name: "Search", exact: true }).focus();
            await expect
                .poll(() =>
                    heading.evaluate((element) => {
                        const range = document.createRange();
                        range.selectNodeContents(element);
                        return element.getBoundingClientRect().width + 1 >= range.getBoundingClientRect().width;
                    }),
                )
                .toBe(true);
        });

        test("copies the channel link", async ({ page, roomId }) => {
            await channelName(page).click();
            await menu(page).getByRole("menuitem", { name: "Copy link" }).click();
            await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain(roomId);
        });

        test("opens the topic dialog from the topic and returns focus", async ({ page }) => {
            const topic = page.getByRole("banner").getByRole("button", { name: TOPIC });
            await topic.click();
            const dialog = page.getByRole("dialog", { name: "general" });
            await expect(dialog).toBeVisible();
            await expect(dialog.getByRole("heading", { name: "general" })).toBeVisible();
            await expect(dialog.getByText(TOPIC)).toBeVisible();
            await expect(dialog.getByRole("button", { name: "Edit topic" })).toBeVisible();
            await page.screenshot({ path: `${CAPTURES}/topic-dialog-${theme}.png` });
            await page.keyboard.press("Escape");
            await expect(dialog).not.toBeVisible();
            await expect(topic).toBeFocused();
        });

        test("opens the same menu with a right click in the room list", async ({ page, roomId }) => {
            const row = page.getByRole("option", { name: /^Open room general/ });
            await row.click({ button: "right" });
            await expect(menu(page)).toBeVisible();
            for (const name of ["Mark as read", "Invite to channel", "Copy link", "Mute channel", "Edit channel"]) {
                await expect(menu(page).getByRole("menuitem", { name })).toBeVisible();
            }
            await expect(menu(page).getByRole("menuitem", { name: "Leave channel" })).toBeVisible();
            await page.screenshot({ path: `${CAPTURES}/context-menu-${theme}.png` });
            await page.keyboard.press("Escape");
            await expect(menu(page)).not.toBeVisible();
        });

        test("opens the person's profile from a direct message's name", async ({ page, app, bot }) => {
            const botId = bot.credentials!.userId;
            const dm = await app.client.createRoom({ name: "Robin", invite: [botId], is_direct: true });
            await app.client.evaluate(
                async (client, { botId, dm }) => {
                    await client.setAccountData("m.direct" as import("matrix-js-sdk/src/matrix").EventType.Direct, {
                        [botId]: [dm],
                    });
                },
                { botId, dm },
            );
            await app.viewRoomById(dm);
            await page.getByRole("banner").getByRole("heading", { level: 1 }).click();
            await expect(page.getByRole("dialog", { name: "Profile", exact: true })).toBeVisible();
            await expect(menu(page)).toHaveCount(0);
            await expect(page.locator(".mx_RoomSummaryCard")).toHaveCount(0);
        });

        test("opens the channel menu from Ctrl+. rather than the room info panel", async ({ page }) => {
            await page.getByRole("banner").click();
            await page.keyboard.press("Control+.");
            await expect(menu(page)).toBeVisible();
            await expect(page.locator(".mx_RoomSummaryCard")).toHaveCount(0);
        });
    });
}

test.describe("without the desktop shell", () => {
    test.beforeEach(async ({ page, user }) => dismissToasts(page));

    test("still shows the room summary card from the header", async ({ page, roomId }) => {
        await page.getByRole("banner").getByRole("button", { name: "Room info" }).first().click();
        await expect(page.locator(".mx_RoomSummaryCard")).toBeVisible();
    });
});
