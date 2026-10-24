/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { closeReleaseAnnouncementIfExists, rejectToast } from "@element-hq/element-web-playwright-common";
import { type Page } from "@playwright/test";

import { test as base, expect } from "../../element-web-test";

const CAPTURES = "/tmp/aether-profile-popout-captures";

const test = base.extend<{ roomId: string }>({
    roomId: async ({ app, bot, user }, use) => {
        const roomId = await app.client.createRoom({ name: "Profile popout" });
        await app.client.inviteUser(roomId, bot.credentials!.userId);
        await bot.joinRoom(roomId);
        await bot.sendMessage(roomId, "Hello from the robot");
        await app.viewRoomById(roomId);
        await use(roomId);
    },
});

test.use({ displayName: "Alice", botCreateOpts: { displayName: "Robin" } });

for (const theme of ["dark", "light"] as const) {
    test.describe(`${theme} theme`, () => {
        test.use({ config: { default_theme: theme, features: { feature_desktop_shell: true } } });

        test.beforeEach(async ({ page, user }) => {
            await rejectToast(page, "Verify this device");
            await rejectToast(page, "Notifications");
            await closeReleaseAnnouncementIfExists(page, "Introducing Sections");
        });

        const popout = (page: Page) => page.getByRole("dialog", { name: "Profile", exact: true });
        const members = (page: Page) => page.getByRole("listbox", { name: "Member list", exact: true });
        const robinRow = (page: Page) => members(page).getByRole("option", { name: /Robin/ });

        test("opens a profile card from the member list and the timeline, messages from it and opens the full profile", async ({
            page,
            app,
            bot,
            roomId,
        }) => {
            await expect(members(page)).toBeVisible();

            // Member list: a card beside the row instead of the right-panel user info.
            const row = robinRow(page);
            await row.click();
            const card = popout(page);
            await expect(card).toBeVisible();
            await expect(card.getByRole("heading", { name: "Robin" })).toBeVisible();
            await expect(card.getByText(bot.credentials!.userId)).toBeVisible();
            await expect(page.locator(".mx_UserInfo")).toHaveCount(0);
            const cardBox = (await card.boundingBox())!;
            const rowBox = (await row.boundingBox())!;
            expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(rowBox.x);
            const viewport = page.viewportSize()!;
            expect(cardBox.y).toBeGreaterThanOrEqual(0);
            expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(viewport.height);
            await page.screenshot({ path: `${CAPTURES}/popout-member-list-${theme}.png` });

            // Escape closes it and returns focus to the row.
            await page.keyboard.press("Escape");
            await expect(card).not.toBeVisible();
            await expect(row).toBeFocused();

            // Clicking the same row again toggles the card, and an outside click closes it.
            await row.click();
            await expect(card).toBeVisible();
            await row.click();
            await expect(card).not.toBeVisible();
            await row.click();
            await page.getByRole("heading", { name: "Profile popout", level: 1 }).click();
            await expect(card).not.toBeVisible();

            // Timeline author: the card sits to the right of the avatar.
            const tile = page.locator(".mx_EventTile").filter({ hasText: "Hello from the robot" });
            const avatar = tile.getByRole("button", { name: "Profile picture" }).first();
            await avatar.click();
            await expect(card).toBeVisible();
            await expect(card.getByRole("heading", { name: "Robin" })).toBeVisible();
            const avatarBox = (await avatar.boundingBox())!;
            expect((await card.boundingBox())!.x).toBeGreaterThanOrEqual(avatarBox.x + avatarBox.width);
            await page.screenshot({ path: `${CAPTURES}/popout-message-author-${theme}.png` });
            await page.keyboard.press("Escape");
            await expect(avatar).toBeFocused();

            // The more menu offers real actions and does not close the card.
            await avatar.click();
            await card.getByRole("button", { name: "More actions" }).click();
            await expect(page.getByRole("menuitem", { name: "Copy link" })).toBeVisible();
            await expect(page.getByRole("menuitem", { name: "Ignore" })).toBeVisible();
            await expect(page.getByRole("menuitem", { name: "View full profile" })).toBeVisible();
            await page.keyboard.press("Escape");
            await expect(card).toBeVisible();

            // Message field: opens the DM with the draft, which the real composer then sends.
            await card.getByLabel("Message Robin").fill("hello from the card");
            await page.keyboard.press("Enter");
            await expect(card).not.toBeVisible();
            const composer = page.getByRole("textbox", { name: /^Send a/ });
            await expect(composer).toContainText("hello from the card");
            await composer.press("Enter");
            await expect(page.locator(".mx_EventTile").filter({ hasText: "hello from the card" })).toBeVisible();
            await expect(page.getByRole("heading", { name: "Robin", level: 1 })).toBeVisible();
            await expect
                .poll(() =>
                    app.client.evaluate((client, userId) => {
                        const dm = Object.values(client.getAccountData("m.direct")?.getContent() ?? {}).flat();
                        return dm.some((id) => client.getRoom(id as string)?.getMember(userId));
                    }, bot.credentials!.userId),
                )
                .toBe(true);

            // Back in the channel, the full profile opens as a modal and returns focus on Escape.
            await app.viewRoomById(roomId);
            if (!(await members(page).isVisible())) await page.getByRole("button", { name: "2 members" }).click();
            await robinRow(page).click();
            await card.getByRole("button", { name: "Robin", exact: true }).click();
            const modal = page.getByRole("dialog", { name: "Profile", exact: true });
            await expect(modal.getByRole("heading", { name: "Robin" })).toBeVisible();
            await expect(modal.getByText("Member since")).toBeVisible();
            await expect(modal.getByRole("tab", { name: /mutual space/ })).toBeVisible();
            const supportsMutualRooms = await app.client.evaluate((client) => client.doesServerSupportMutualRooms());
            if (supportsMutualRooms) {
                await expect(modal.getByRole("tab", { name: /mutual room/ })).toBeVisible();
                await expect(modal.getByRole("button", { name: /Profile popout/ })).toBeVisible();
            } else {
                await expect(modal.getByRole("tab", { name: /mutual room/ })).toHaveCount(0);
            }
            await expect(modal.getByText("Not verified · 1 session")).toBeVisible();
            await page.screenshot({ path: `${CAPTURES}/full-profile-${theme}.png` });
            await page.keyboard.press("Escape");
            await expect(modal).not.toBeVisible();
            await expect(robinRow(page)).toBeFocused();
        });
    });
}

test.describe("without the desktop shell", () => {
    test.use({ config: { default_theme: "dark" } });

    test.beforeEach(async ({ page, user }) => {
        await rejectToast(page, "Verify this device");
        await rejectToast(page, "Notifications");
        await closeReleaseAnnouncementIfExists(page, "Introducing Sections");
    });

    test("keeps opening the right-panel user info", async ({ page, roomId }) => {
        await page.getByRole("button", { name: "Profile picture", exact: true }).nth(1).click();
        await expect(page.locator(".mx_UserInfo")).toBeVisible();
        await expect(page.getByRole("dialog", { name: "Profile", exact: true })).toHaveCount(0);
    });
});
