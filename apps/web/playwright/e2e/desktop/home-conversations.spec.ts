/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import path from "node:path";

import { closeReleaseAnnouncementIfExists, rejectToastIfExists } from "@element-hq/element-web-playwright-common";
import type { Locator, Page, TestInfo } from "@playwright/test";

import { test, expect } from "../../element-web-test";

test.use({
    displayName: "Alice",
    config: {
        default_theme: "dark",
        features: { feature_desktop_shell: true, feature_video_rooms: true, feature_element_call_video_rooms: true },
        element_call: { use_exclusively: true },
    },
});

test.beforeEach(async ({ page, user }) => {
    await rejectToastIfExists(page, "Verify this device");
    await rejectToastIfExists(page, "Notifications");
    await closeReleaseAnnouncementIfExists(page, "Introducing Sections");
});

/** Saves a picture of part of the page for review. Set AETHER_VISUAL_DIR to collect them in one place. */
async function capture(locator: Locator | Page, testInfo: TestInfo, name: string): Promise<void> {
    const directory = process.env.AETHER_VISUAL_DIR;
    await locator.screenshot({ path: directory ? path.join(directory, name) : testInfo.outputPath(name) });
}

const rail = (page: Page): Locator => page.getByRole("tree", { name: "Servers" });
const homeButton = (page: Page): Locator => rail(page).getByRole("button", { name: "Home", exact: true }).first();
const unread = (page: Page): Locator => rail(page).getByRole("group", { name: "Unread conversations" });
const row = (page: Page, name: string): Locator =>
    page.getByTestId("room-list").getByRole("option", { name: `Open room ${name}`, exact: true });

test("keeps conversations in Home, servers' channels in servers, and unread conversations under Home", async ({
    page,
    app,
    bot,
    user,
}, testInfo) => {
    const botId = bot.credentials!.userId;

    // A server Alice joined, with a channel she is invited to: both stay in the server.
    const channelId = await bot.evaluate(
        async (client, userId) => (await client.createRoom({ name: "bob-chat", invite: [userId] })).room_id,
        user.userId,
    );
    const serverId = await bot.evaluate(
        async (client, { userId, channelId, server }) =>
            (
                await client.createRoom({
                    name: "Bob's server",
                    invite: [userId],
                    creation_content: { type: "m.space" },
                    initial_state: [{ type: "m.space.child", state_key: channelId, content: { via: [server] } }],
                })
            ).room_id,
        { userId: user.userId, channelId, server: user.homeServer },
    );
    await app.client.joinRoom(serverId);

    // A new conversation is an invitation, which Home counts, as Discord counts friend requests.
    const dmId = await bot.evaluate(
        async (client, userId) => (await client.createRoom({ name: "Bob", invite: [userId], is_direct: true })).room_id,
        user.userId,
    );
    await expect(homeButton(page).locator("..")).toContainText("1");
    await app.client.joinRoom(dmId);
    await app.client.evaluate(
        async (client, { botId, dmId }) => {
            await client.setAccountData("m.direct" as import("matrix-js-sdk/src/matrix").EventType.Direct, {
                [botId]: [dmId],
            });
        },
        { botId, dmId },
    );

    // A group conversation outside any server.
    const groupId = await app.client.createRoom({ name: "Weekend plans", invite: [botId] });
    await bot.joinRoom(groupId);

    // Home lists the conversations together, each row the same size, and leaves the server's invitation to it.
    await homeButton(page).click();
    await expect(row(page, "Bob")).toBeVisible();
    await expect(row(page, "Weekend plans")).toContainText("2 members");
    await expect(row(page, "bob-chat")).toHaveCount(0);
    const [dmBox, groupBox] = await Promise.all([
        row(page, "Bob").boundingBox(),
        row(page, "Weekend plans").boundingBox(),
    ]);
    expect(dmBox!.height).toBe(groupBox!.height);
    await capture(page.getByRole("navigation", { name: "Room list" }), testInfo, "home-list.png");

    // While Alice is in the server, Bob's messages show under Home with their count.
    await app.viewSpaceByName("Bob's server");
    // The invitation to the server's channel waits in the server.
    await expect(page.getByRole("button", { name: "Toggle Invites section with unread rooms" })).toBeVisible();
    await bot.sendMessage(dmId, "are you around?");
    await bot.sendMessage(dmId, "the server is ready");
    const bob = unread(page).getByRole("button", { name: "Bob, 2 unread messages" });
    await expect(bob).toBeVisible();
    await capture(page.getByRole("navigation", { name: "Servers" }), testInfo, "rail-unread.png");

    // Right-clicking the server opens its Discord-style menu.
    await rail(page).getByRole("button", { name: "Bob's server" }).click({ button: "right" });
    const menu = page.getByRole("menu", { name: "Bob's server" });
    await expect(menu.getByRole("menuitem", { name: "Leave server" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Mark as read" })).toBeVisible();
    await capture(page, testInfo, "server-menu.png");
    await page.keyboard.press("Escape");

    // Opening the conversation from the rail goes to Home and reads it, so it leaves the rail.
    await bob.click();
    await page.waitForURL((url) => url.hash === `#/room/${dmId}`);
    await expect(unread(page)).toHaveCount(0);
    await expect(row(page, "Bob")).toBeVisible();
});
