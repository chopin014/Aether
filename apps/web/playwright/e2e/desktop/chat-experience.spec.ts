/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { readFile } from "node:fs/promises";
import path from "node:path";

import { closeReleaseAnnouncementIfExists, rejectToast } from "@element-hq/element-web-playwright-common";
import type { Locator, TestInfo } from "@playwright/test";

import { test, expect } from "../../element-web-test";
import { getSampleFilePath } from "../../sample-files";
import { autoJoin, createSecondBotDevice, createSharedEncryptedRoomWithUser } from "../crypto/utils";
import { bootstrapCrossSigningForClient } from "../../pages/client";

test.use({
    displayName: "Alice",
    lockLeftPanelWidth: false,
    config: {
        default_theme: "dark",
        features: { feature_desktop_shell: true },
    },
});

// Asking for the user signs in first, so the toasts below have appeared.
test.beforeEach(async ({ page, user }) => {
    await rejectToast(page, "Verify this device");
    await rejectToast(page, "Notifications");
    await closeReleaseAnnouncementIfExists(page, "Introducing Sections");
});

/**
 * Saves a picture of part of the page for review. Set AETHER_VISUAL_DIR to collect them in one place.
 */
async function capture(locator: Locator, testInfo: TestInfo, name: string): Promise<void> {
    const directory = process.env.AETHER_VISUAL_DIR;
    await locator.screenshot({ path: directory ? path.join(directory, name) : testInfo.outputPath(name) });
}

test("groups messages and shows mentions as @name with a highlight", async ({ page, app, bot, user }, testInfo) => {
    const roomId = await app.client.createRoom({ name: "geral", invite: [bot.credentials!.userId] });
    await bot.joinRoom(roomId);
    await app.viewRoomById(roomId);

    await bot.sendMessage(roomId, "hello night city");
    await bot.sendMessage(roomId, "this one joins the same group");
    await bot.sendMessage(roomId, {
        "msgtype": "m.text",
        "body": "Alice: are you around?",
        "format": "org.matrix.custom.html",
        "formatted_body": `<a href="https://matrix.to/#/${user.userId}">Alice</a>: are you around?`,
        "m.mentions": { user_ids: [user.userId] },
    });
    await app.client.sendMessage(roomId, "yes, here");

    const timeline = page.locator(".mx_RoomView_MessageList");
    await expect(timeline.getByText("yes, here")).toBeVisible();

    const pill = timeline.locator(".mx_Pill_desktopMention").first();
    await expect(pill).toHaveText("@Alice");
    await expect(pill.locator(".mx_BaseAvatar")).toHaveCount(0);

    // The mention paints the whole message with an edge bar, not just its line.
    const mentioned = timeline
        .locator("[data-event-id]")
        .filter({ has: page.locator(".mx_Pill_desktopMention") })
        .last();
    expect(await mentioned.evaluate((tile) => getComputedStyle(tile).boxShadow)).toContain("inset");

    await capture(page.locator(".mx_RoomView_body"), testInfo, "timeline-mentions.png");
});

test("puts the encryption warning after the time, clear of the avatar", async ({
    page,
    app,
    bot,
    homeserver,
}, testInfo) => {
    const roomId = await app.client.createRoom({
        name: "secure",
        invite: [bot.credentials!.userId],
        initial_state: [{ type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } }],
    });
    await bot.joinRoom(roomId);
    await app.viewRoomById(roomId);

    // A plain message in an encrypted room always carries a warning.
    await homeserver.csApi.request(
        "PUT",
        `/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/aether-plain-1`,
        bot.credentials!.accessToken,
        { msgtype: "m.text", body: "sent without encryption" },
    );

    const tile = page.locator("[data-event-id]").filter({ hasText: "sent without encryption" });
    const padlock = tile.getByTestId("e2e-padlock");
    await expect(padlock).toBeVisible();

    const [avatar, time, icon, text] = await Promise.all([
        tile.getByTestId("event-tile-slot-avatar").boundingBox(),
        tile.getByTestId("event-tile-slot-timestamp").boundingBox(),
        padlock.boundingBox(),
        tile.getByText("sent without encryption").boundingBox(),
    ]);
    expect(icon!.x).toBeGreaterThan(avatar!.x + avatar!.width);
    expect(icon!.x).toBeGreaterThanOrEqual(time!.x + time!.width);
    // On the name row, above the text rather than beside it.
    expect(icon!.y + icon!.height).toBeLessThanOrEqual(text!.y + 1);

    await capture(page.locator(".mx_RoomView_body"), testInfo, "timeline-encryption.png");
});

test("plays video with Aether's controls and keeps audio readable", async ({ page, app }, testInfo) => {
    const roomId = await app.client.createRoom({ name: "media" });
    await app.viewRoomById(roomId);

    const video = await readFile(getSampleFilePath("5secvid.webm"));
    const videoUpload = await app.client.uploadContent(video, { name: "clip.webm", type: "video/webm" });
    await app.client.sendMessage(roomId, {
        msgtype: "m.video",
        body: "clip.webm",
        url: videoUpload.content_uri,
        info: { mimetype: "video/webm", size: video.length, w: 640, h: 360, duration: 5000 },
    });

    const audio = await readFile(getSampleFilePath("1sec.ogg"));
    const audioUpload = await app.client.uploadContent(audio, { name: "note.ogg", type: "audio/ogg" });
    await app.client.sendMessage(roomId, {
        "msgtype": "m.audio",
        "body": "Voice message.ogg",
        "url": audioUpload.content_uri,
        "info": { mimetype: "audio/ogg", size: audio.length, duration: 1000 },
        "org.matrix.msc1767.audio": { duration: 1000, waveform: [0, 300, 700, 1024, 600, 200, 900, 400, 100, 800] },
        "org.matrix.msc3245.voice": {},
    });

    const player = page.getByTestId("video-player");
    await expect(player).toBeVisible();
    await expect(player.locator("video")).not.toHaveAttribute("controls");
    await expect(player.getByRole("button", { name: "Play" }).first()).toBeVisible();

    const timeline = page.locator(".mx_RoomView_MessageList");
    await expect(timeline.locator(".mx_MVoiceMessageBody")).toBeVisible();

    await capture(timeline, testInfo, "timeline-media.png");
    await player.hover();
    await capture(player, testInfo, "video-player-hover.png");
});

test("keeps the composer's encryption icon in line with its controls", async ({ page, app }, testInfo) => {
    const roomId = await app.client.createRoom({ name: "open" });
    await app.viewRoomById(roomId);

    const composer = app.getComposer();
    const icon = composer.locator(".mx_MessageComposer_e2eIconWrapper");
    await expect(icon).toBeVisible();
    const [row, attach, shield] = await Promise.all([
        composer.locator(".mx_MessageComposer_row").boundingBox(),
        composer.locator(".mx_DesktopShell_attachment").boundingBox(),
        icon.boundingBox(),
    ]);
    // After the attach button, and centred on the row.
    expect(shield!.x).toBeGreaterThanOrEqual(attach!.x + attach!.width);
    expect(Math.abs(shield!.y + shield!.height / 2 - (row!.y + row!.height / 2))).toBeLessThanOrEqual(2);

    await capture(composer, testInfo, "composer.png");
});

test("lists a server's channels with an even rhythm", async ({ page, app, user }, testInfo) => {
    const server = user.userId.split(":").slice(1).join(":");
    const spaceId = await app.client.createSpace({ name: "Terra do boi gordo" });
    for (const name of ["geral", "memes", "jogos"]) {
        const roomId = await app.client.createRoom({ name });
        await app.client.sendStateEvent(spaceId, "m.space.child", { via: [server] }, roomId);
    }

    const rail = page.getByRole("navigation", { name: "Servers", exact: true });
    await rail.getByRole("button", { name: "Terra do boi gordo", exact: true }).click();
    // A server's channels sit in a tree grid of categories.
    const list = page.getByRole("treegrid", { name: "Room list" });
    await expect(list.getByRole("row", { name: "Open room jogos" })).toBeVisible();
    // Clear the rail's tooltip before the picture.
    await page.mouse.move(640, 360);
    await capture(page.locator(".mx_LeftPanel"), testInfo, "channel-list.png");

    // The channel names sit at an even pitch.
    const centres = await Promise.all(
        ["jogos", "memes", "geral"].map(async (name) => {
            const box = (await list.getByText(name, { exact: true }).boundingBox())!;
            return box.y + box.height / 2;
        }),
    );
    expect(Math.round(centres[1] - centres[0])).toBe(Math.round(centres[2] - centres[1]));
});

test("sends several files with text from the composer's attachment tray", async ({ page, app }, testInfo) => {
    const roomId = await app.client.createRoom({ name: "photos" });
    await app.viewRoomById(roomId);

    const composer = app.getComposer();
    const chooser = page.waitForEvent("filechooser");
    await composer.getByRole("button", { name: "Attachment", exact: true }).click();
    await (await chooser).setFiles([getSampleFilePath("riot.png"), getSampleFilePath("element.png")]);

    const tray = composer.getByRole("list", { name: "2 files to send" });
    await expect(tray.getByRole("listitem")).toHaveCount(2);
    await capture(composer, testInfo, "composer-tray.png");

    await tray.getByRole("listitem").first().hover();
    await tray.getByRole("button", { name: "Remove riot.png" }).click();
    await expect(composer.getByRole("list", { name: "1 file to send" })).toBeVisible();

    await app.getComposerField().fill("look at this");
    await page.keyboard.press("Enter");

    const timeline = page.locator(".mx_RoomView_MessageList");
    const captioned = timeline.locator(".mx_EventTile_captioned").last();
    await expect(captioned.getByText("look at this")).toBeVisible();
    await expect(composer.getByRole("list")).toHaveCount(0);

    // The text reads above the picture.
    const [text, image] = await Promise.all([
        captioned.getByText("look at this").boundingBox(),
        captioned.locator("img").first().boundingBox(),
    ]);
    expect(text!.y).toBeLessThan(image!.y);

    await capture(timeline, testInfo, "timeline-caption.png");
});

test("offers cozy and compact messages instead of Element's layouts", async ({ page, app, bot }, testInfo) => {
    const roomId = await app.client.createRoom({ name: "layout", invite: [bot.credentials!.userId] });
    await bot.joinRoom(roomId);
    await app.viewRoomById(roomId);
    await bot.sendMessage(roomId, "a message long enough to wrap onto a second line when the window is narrow");
    await app.client.sendMessage(roomId, "short reply");

    const dialog = await app.settings.openUserSettings("Appearance");
    const panel = dialog.getByTestId("messageDisplayPanel");
    await expect(panel).toBeVisible();
    await expect(dialog.getByRole("radio", { name: /Message bubbles/ })).toHaveCount(0);
    await capture(panel, testInfo, "settings-message-display.png");

    // The radios are visually hidden inside their labels, which are what a person clicks.
    await panel.locator("label").filter({ hasText: "Compact" }).click();
    await expect(panel.getByRole("radio", { name: /Compact/ })).toBeChecked();
    await panel.locator("label").filter({ hasText: "24px" }).click();
    await app.settings.closeDialog();

    const timeline = page.locator(".mx_RoomView_MessageList");
    const tile = timeline.locator("[data-event-id]").filter({ hasText: "short reply" });
    await expect(tile.getByTestId("event-tile-slot-avatar")).toBeHidden();
    await capture(page.locator(".mx_RoomView_body"), testInfo, "timeline-compact.png");

    // The text flows around the time and name, so its box spans the line: measure the glyphs instead.
    const textRect = await tile.getByText("short reply").evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const rect = range.getClientRects()[0];
        return { x: rect.x, y: rect.y, height: rect.height };
    });
    const [time, name] = await Promise.all([
        tile.getByTestId("event-tile-slot-timestamp").boundingBox(),
        tile.getByTestId("event-tile-slot-sender").boundingBox(),
    ]);
    // Time, then name, then text, on one line.
    expect(time!.x).toBeLessThan(name!.x);
    expect(name!.x + name!.width).toBeLessThanOrEqual(textRect.x + 1);
    expect(Math.abs(name!.y + name!.height / 2 - (textRect.y + textRect.height / 2))).toBeLessThanOrEqual(3);

    // A wrapped message returns under the name, not under its own first line.
    const wrapped = timeline.locator("[data-event-id]").filter({ hasText: "a message long enough" });
    const lines = await wrapped.getByText(/a message long enough/).evaluate((element) => {
        // Only the words themselves: one box per line they occupy.
        const text = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode()!;
        const range = document.createRange();
        range.selectNodeContents(text);
        return [...range.getClientRects()].map((rect) => rect.x);
    });
    const wrappedName = (await wrapped.getByTestId("event-tile-slot-sender").boundingBox())!;
    expect(lines.length).toBeGreaterThan(1);
    expect(Math.min(...lines.slice(1))).toBeLessThan(wrappedName.x + 2);
});

test("shows a changed identity as a strip across the top of the composer", async ({
    page,
    app,
    bot: bob,
    user,
    homeserver,
}, testInfo) => {
    test.slow();
    await app.client.bootstrapCrossSigning(user);
    await autoJoin(bob);
    const roomId = await createSharedEncryptedRoomWithUser(app, bob.credentials!.userId, { name: "secret" });
    await app.viewRoomById(roomId);
    await bob.sendMessage(roomId, "before the reset");
    await expect(page.getByText("before the reset")).toBeVisible();

    // Bob resets his identity from a new device.
    const bobSecondDevice = await createSecondBotDevice(page, homeserver, bob);
    await bootstrapCrossSigningForClient(await bobSecondDevice.prepareClient(), bob.credentials!, true);

    const composer = app.getComposer();
    const warning = composer.locator(".mx_UserIdentityWarning");
    await expect(warning).toBeVisible({ timeout: 30_000 });

    // The strip spans the composer box and the action sits on its row.
    const [box, strip, action] = await Promise.all([
        composer.locator(".mx_MessageComposer_wrapper").boundingBox(),
        warning.boundingBox(),
        warning.getByRole("button").boundingBox(),
    ]);
    expect(Math.abs(strip!.x - box!.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(strip!.width - box!.width)).toBeLessThanOrEqual(3);
    expect(action!.y).toBeGreaterThanOrEqual(strip!.y);
    expect(action!.y + action!.height).toBeLessThanOrEqual(strip!.y + strip!.height);

    await capture(composer, testInfo, "composer-identity-warning.png");
});
