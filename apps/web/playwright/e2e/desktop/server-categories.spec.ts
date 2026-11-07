/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { closeReleaseAnnouncementIfExists, rejectToastIfExists } from "@element-hq/element-web-playwright-common";
import { type Locator, type Page } from "@playwright/test";

import { test as base, expect } from "../../element-web-test";
import { assertRoomInSection, getSectionHeader } from "../left-panel/room-list-panel/utils";

const CAPTURES = "/tmp/aether-server-categories-captures";
const SERVER = "Servidor de Gabrielgg";
const CATEGORY_EVENT = "io.aether.space.category";
const CHANNEL_EVENT = "io.aether.space.channel";

/** A server with three text channels and a voice channel, none placed in a category yet. */
const test = base.extend<{ spaceId: string; roomIds: Record<string, string> }>({
    roomIds: async ({ app }, use) => {
        const voice = { type: "org.matrix.msc3417.call" };
        const names = ["boas-vindas", "memes", "chat-governamental"];
        const ids = await Promise.all([
            ...names.map((name) => app.client.createRoom({ name })),
            app.client.createRoom({ name: "Geral#1", creation_content: voice }),
        ]);
        await use(Object.fromEntries([...names, "Geral#1"].map((name, i) => [name, ids[i]])));
    },
    spaceId: async ({ page, app, user, roomIds }, use) => {
        await rejectToastIfExists(page, "Verify this device");
        await rejectToastIfExists(page, "Notifications");
        await closeReleaseAnnouncementIfExists(page, "Introducing Sections");
        const spaceId = await app.client.createSpace({
            name: SERVER,
            initial_state: Object.values(roomIds).map((roomId) => ({
                type: "m.space.child",
                state_key: roomId,
                content: { via: [user.homeServer] },
            })),
        });
        await app.viewSpaceByName(SERVER);
        await expect(channel(page, "Geral#1")).toBeVisible();
        await use(spaceId);
    },
});

test.use({
    displayName: "Gabriel",
    config: {
        default_theme: "dark",
        features: { feature_desktop_shell: true, feature_video_rooms: true, feature_element_call_video_rooms: true },
        element_call: { use_exclusively: true },
    },
});

const roomList = (page: Page): Locator => page.getByTestId("room-list");
const channel = (page: Page, name: string): Locator =>
    roomList(page).getByRole("button", { name: `Open room ${name}`, exact: true });

/** Right-click the empty part of the channel list, below its last channel. */
async function openChannelListMenu(page: Page): Promise<Locator> {
    const box = (await roomList(page).boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height - 12, { button: "right" });
    const menu = page.getByRole("menu", { name: "Channel list options" });
    await expect(menu).toBeVisible();
    return menu;
}

/** Drag a channel onto a category's header. Channels that need attention stay visible while categories collapse. */
async function dragChannelToCategory(page: Page, name: string, category: string): Promise<void> {
    const source = (await channel(page, name).boundingBox())!;
    const x = source.x + source.width / 2;
    await page.mouse.move(x, source.y + source.height / 2);
    await page.mouse.down();
    await page.mouse.move(x, source.y + source.height / 2 + 10, { steps: 5 });
    const target = getSectionHeader(page, category);
    await expect(target).toBeVisible();
    // Wait for the list to settle after the categories collapse.
    await page.waitForTimeout(300);
    const box = (await target.boundingBox())!;
    await page.mouse.move(x, box.y + box.height / 2, { steps: 10 });
    await page.mouse.up();
}

test("organises a server's channels into categories everyone sees", async ({ page, app, bot, spaceId, roomIds }) => {
    // The built-in categories hold every channel by its kind until someone changes the layout.
    await assertRoomInSection(page, "Text Channels", "memes");
    await assertRoomInSection(page, "Voice Channels", "Geral#1");

    // Right-clicking the empty sidebar offers what Discord offers.
    const menu = await openChannelListMenu(page);
    await page.screenshot({ path: `${CAPTURES}/channel-list-menu.png` });
    await expect(menu.getByRole("menuitemcheckbox", { name: "Hide muted channels" })).not.toBeChecked();
    await expect(menu.getByRole("menuitem", { name: "Create channel" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Invite to server" })).toBeVisible();
    await menu.getByRole("menuitem", { name: "Create category" }).click();

    const dialog = page.getByRole("dialog", { name: "Create category" });
    await dialog.getByRole("textbox", { name: "Category name" }).fill("Governo");
    await dialog.getByRole("button", { name: "Create category" }).click();
    await expect(dialog).not.toBeVisible();
    // An empty category shows to the people who can fill it.
    await expect(getSectionHeader(page, "Governo")).toBeVisible();

    await dragChannelToCategory(page, "chat-governamental", "Governo");
    await assertRoomInSection(page, "Governo", "chat-governamental");
    await page.mouse.move(0, 0);
    await page.locator(".mx_LeftPanel").screenshot({ path: `${CAPTURES}/categories.png` });

    // The layout lives in the server's state, so every member gets it.
    const categoryId = await app.client.evaluate(
        (client, { spaceId, type }) =>
            client
                .getRoom(spaceId)!
                .currentState.getStateEvents(type)
                .find((event) => event.getContent().name === "Governo")!
                .getStateKey()!,
        { spaceId, type: CATEGORY_EVENT },
    );
    const botId = bot.credentials!.userId;
    await app.client.evaluate((client, { spaceId, botId }) => client.invite(spaceId, botId), { spaceId, botId });
    await bot.joinRoom(spaceId);
    await expect
        .poll(() =>
            bot.evaluate((client, { spaceId, type, roomId }) => client.getStateEvent(spaceId, type, roomId), {
                spaceId,
                type: CHANNEL_EVENT,
                roomId: roomIds["chat-governamental"],
            }),
        )
        .toMatchObject({ v: 1, category: categoryId });

    // It survives a reload, read back from the server.
    await page.reload();
    await rejectToastIfExists(page, "Verify this device");
    await app.viewSpaceByName(SERVER);
    await assertRoomInSection(page, "Governo", "chat-governamental");

    // Renaming from the category's own menu.
    await getSectionHeader(page, "Governo").click({ button: "right" });
    await page.screenshot({ path: `${CAPTURES}/category-menu.png` });
    await page.getByRole("menuitem", { name: "Edit category" }).click();
    const edit = page.getByRole("dialog", { name: "Edit category" });
    await edit.getByRole("textbox", { name: "Category name" }).fill("Governo federal");
    await edit.getByRole("button", { name: "Save" }).click();
    await assertRoomInSection(page, "Governo federal", "chat-governamental");

    // A muted channel can be hidden, and comes back when the option is turned off.
    await channel(page, "memes").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Mute channel" }).click();
    await channel(page, "boas-vindas").click();
    await (await openChannelListMenu(page)).getByRole("menuitemcheckbox", { name: "Hide muted channels" }).click();
    await expect(channel(page, "memes")).toHaveCount(0);
    await page.mouse.move(0, 0);
    await page.locator(".mx_LeftPanel").screenshot({ path: `${CAPTURES}/muted-hidden.png` });
    await expect
        .poll(() =>
            app.client.evaluate(
                (client, spaceId) => client.getRoom(spaceId)!.getAccountData("io.aether.space.sidebar")?.getContent(),
                spaceId,
            ),
        )
        .toMatchObject({ hide_muted: true });
    await (await openChannelListMenu(page)).getByRole("menuitemcheckbox", { name: "Hide muted channels" }).click();
    await expect(channel(page, "memes")).toBeVisible();

    // Deleting a category keeps its channels, at the top of the list.
    await getSectionHeader(page, "Governo federal").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Delete category" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete category" }).click();
    await expect(getSectionHeader(page, "Governo federal")).toHaveCount(0);
    await expect(channel(page, "chat-governamental")).toBeVisible();
    await expect(roomList(page).getByRole("row", { name: "Open room chat-governamental" })).toHaveAttribute(
        "aria-level",
        "2",
    );
});
