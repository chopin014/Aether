/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { closeReleaseAnnouncementIfExists, rejectToastIfExists } from "@element-hq/element-web-playwright-common";
import { type Page } from "@playwright/test";

import { test as base, expect } from "../../element-web-test";
import { readSampleFileSync } from "../../sample-files";
import { SettingLevel } from "../../../src/settings/SettingLevel";

const CAPTURES = "/tmp/aether-channel-kinds-captures";
const SPACE = "Terra do boi gordo";
const SECTION = "element.io.section.voz";

/**
 * A Space whose text and voice channels share one custom icon, with a custom "Voz" section holding two voice
 * channels, as people set them up.
 */
const test = base.extend<{ spaceId: string }>({
    spaceId: async ({ page, app, user }, use) => {
        await settle(page);
        const { content_uri: icon } = await app.client.uploadContent(readSampleFileSync("element.png", null), {
            name: "icon.png",
            type: "image/png",
        });
        const avatar = [{ type: "m.room.avatar", state_key: "", content: { url: icon } }];
        const voice = { type: "org.matrix.msc3417.call" };
        const rooms = await Promise.all([
            app.client.createRoom({ name: "geral", initial_state: avatar }),
            app.client.createRoom({ name: "memes" }),
            app.client.createRoom({ name: "Lounge", creation_content: voice, initial_state: avatar }),
            app.client.createRoom({ name: "Geral#1", creation_content: voice, initial_state: avatar }),
            app.client.createRoom({ name: "Geral#2", creation_content: voice }),
        ]);
        const spaceId = await app.client.createSpace({
            name: SPACE,
            initial_state: rooms.map((roomId) => ({
                type: "m.space.child",
                state_key: roomId,
                content: { via: [user.homeServer] },
            })),
        });
        await page.evaluate(
            async ({ tag, spaceId, level }) => {
                await window.mxSettingsStore.setValue("RoomList.CustomSectionData", null, level, {
                    [tag]: { tag, name: "Voz", spaceId },
                });
                await window.mxSettingsStore.setValue("RoomList.OrderedCustomSections", null, level, [tag, "chats"]);
            },
            { tag: SECTION, spaceId, level: SettingLevel.ACCOUNT },
        );
        await app.client.evaluate(
            (client, { rooms, tag }) => Promise.all(rooms.map((id) => client.setRoomTag(id, tag, {}))),
            { rooms: rooms.slice(3), tag: SECTION },
        );
        await app.viewSpaceByName(SPACE);
        await expect(roomList(page).getByRole("button", { name: /Open room Geral#2/ })).toBeVisible();
        await use(spaceId);
    },
});

test.use({
    displayName: "Alice",
    config: {
        default_theme: "dark",
        features: { feature_desktop_shell: true, feature_video_rooms: true, feature_element_call_video_rooms: true },
        element_call: { use_exclusively: true },
    },
});

async function settle(page: Page): Promise<void> {
    await rejectToastIfExists(page, "Verify this device");
    await rejectToastIfExists(page, "Notifications");
    await closeReleaseAnnouncementIfExists(page, "Introducing Sections");
}

const roomList = (page: Page) => page.getByRole("navigation", { name: "Room list" });
const channel = (page: Page, name: string) =>
    roomList(page).getByRole("button", { name: `Open room ${name}`, exact: true });
const dialog = (page: Page) => page.getByRole("dialog", { name: "Create channel" });

async function settleAnimations(page: Page): Promise<void> {
    await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));
}

test("marks every channel with its kind, beside its custom icon", { tag: "@screenshot" }, async ({ page, spaceId }) => {
    for (const name of ["geral", "memes"]) {
        await expect(channel(page, name).getByTestId("channel-kind-text")).toBeVisible();
    }
    for (const name of ["Lounge", "Geral#1", "Geral#2"]) {
        await expect(channel(page, name).getByTestId("channel-kind-voice")).toBeVisible();
    }
    // The shared icon still shows, after the kind symbol.
    await expect(channel(page, "geral").locator("img")).toBeVisible();
    await expect(channel(page, "Geral#1").locator("img")).toBeVisible();

    await channel(page, "geral").click();
    await expect(page.getByRole("heading", { name: "geral", exact: true })).toBeVisible();
    await page.mouse.move(0, 0);
    await page.locator(".mx_LeftPanel").screenshot({ path: `${CAPTURES}/list.png` });
    await page.locator(".mx_RoomHeader").screenshot({ path: `${CAPTURES}/header.png` });
});

test("creates a channel of either kind from any section", async ({ page, app, spaceId }) => {
    // A custom section of voice channels offers another voice channel, and keeps the one created in it.
    await roomList(page).getByRole("button", { name: "Create channel in Voz" }).click();
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page).getByText("in Voz")).toBeVisible();
    await expect(dialog(page).getByRole("radio", { name: "Voice" })).toBeChecked();
    await settleAnimations(page);
    await page.screenshot({ path: `${CAPTURES}/dialog-voice.png` });
    await dialog(page).getByRole("textbox", { name: "Channel name" }).fill("Geral#3");
    await dialog(page).getByRole("button", { name: "Create channel" }).click();
    await expect(dialog(page)).not.toBeVisible();
    await expect(channel(page, "Geral#3").getByTestId("channel-kind-voice")).toBeVisible({ timeout: 15_000 });
    await expect
        .poll(() =>
            app.client.evaluate((client) => {
                const room = client.getRooms().find((room) => room.name === "Geral#3");
                return room && [room.getType(), Object.keys(room.tags)];
            }),
        )
        .toEqual(["org.matrix.msc3417.call", [SECTION]]);
    // Creating a voice channel does not join its call.
    await expect(page.getByTestId("aether-call-stage")).toHaveCount(0);

    // The Text category starts on text, but the dialog can still make a voice channel.
    await roomList(page).getByRole("button", { name: "Create channel in Text Channels" }).click();
    await expect(dialog(page).getByRole("radio", { name: "Text" })).toBeChecked();
    await dialog(page).getByRole("textbox", { name: "Channel name" }).fill("anúncios");
    await settleAnimations(page);
    await page.screenshot({ path: `${CAPTURES}/dialog-text.png` });
    await dialog(page).getByRole("radio", { name: "Voice" }).check();
    await dialog(page).getByRole("radio", { name: "Text" }).check();
    await dialog(page).getByRole("button", { name: "Create channel" }).click();
    await expect(channel(page, "anúncios").getByTestId("channel-kind-text")).toBeVisible({ timeout: 15_000 });

    await page.mouse.move(0, 0);
    await page.locator(".mx_LeftPanel").screenshot({ path: `${CAPTURES}/list-after.png` });
});
