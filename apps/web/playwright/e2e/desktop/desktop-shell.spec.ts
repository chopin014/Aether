/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { closeReleaseAnnouncementIfExists, rejectToast } from "@element-hq/element-web-playwright-common";
import type { Preset, Visibility } from "matrix-js-sdk/src/matrix";

import { test, expect } from "../../element-web-test";

test.use({
    displayName: "Alice",
    lockLeftPanelWidth: false,
    config: {
        default_theme: "dark",
        features: { feature_desktop_shell: true, feature_video_rooms: true, feature_element_call_video_rooms: true },
        element_call: { disable: false, use_exclusively: true },
    },
});

test.beforeEach(async ({ page, user }) => {
    await rejectToast(page, "Verify this device");
    await rejectToast(page, "Notifications");
    await closeReleaseAnnouncementIfExists(page, "Introducing Sections");
});

test("discovers and joins public Spaces from a separate rail button", async ({ page, app, bot }, testInfo) => {
    const name = "Aether discovery test space";
    const roomName = "Aether discovery test room";
    const spaceId = await bot.createRoom({
        name,
        visibility: "public" as Visibility,
        preset: "public_chat" as Preset,
        creation_content: { type: "m.space" },
        initial_state: [
            { type: "m.room.history_visibility", state_key: "", content: { history_visibility: "joined" } },
        ],
    });
    await bot.createRoom({ name: roomName, visibility: "public" as Visibility, preset: "public_chat" as Preset });

    const rail = page.getByRole("navigation", { name: "Spaces", exact: true });
    await rail.getByRole("button", { name: "Create a space", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Create a space", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");

    const create = rail.getByRole("button", { name: "Create a space", exact: true });
    const discover = rail.getByRole("button", { name: "Discover public spaces", exact: true });
    await discover.hover();
    await expect(page.getByRole("tooltip")).toHaveText("Discover public spaces");
    const createBounds = await create.boundingBox();
    const discoverBounds = await discover.boundingBox();
    expect(discoverBounds!.y).toBeGreaterThan(createBounds!.y + createBounds!.height - 1);
    await rail.screenshot({ path: testInfo.outputPath("discover-rail.png") });
    await discover.click();

    const dialog = page.getByRole("dialog", { name: "Search Dialog" });
    await expect(dialog.getByText("Public spaces", { exact: true })).toBeVisible();
    await dialog.getByRole("textbox", { name: "Search", exact: true }).fill("Aether discovery test");
    const result = dialog.getByRole("option", { name, exact: true });
    await expect(result).toBeVisible();
    await expect(dialog.getByRole("option", { name: roomName, exact: true })).not.toBeAttached();
    await result.getByRole("button", { name: "Join", exact: true }).click();

    await expect(dialog).not.toBeVisible();
    await expect
        .poll(() => app.client.evaluate((client, id) => client.getRoom(id)?.getMyMembership(), spaceId))
        .toBe("join");
    await expect(rail.getByRole("button", { name, exact: true })).toBeVisible();
});

test("sends through Matrix, receives another member's message and preserves room drafts", async ({
    page,
    app,
    bot,
}, testInfo) => {
    const first = await app.client.createRoom({ name: "General", invite: [bot.credentials!.userId] });
    const second = await app.client.createRoom({ name: "Design" });
    await app.viewRoomById(first);
    const composer = page.getByRole("textbox", { name: "Send an unencrypted message…" });
    await composer.fill("Hello from the desktop shell");
    await composer.press("Enter");
    await expect(page.getByRole("status", { name: "Your message was sent" })).toBeVisible();
    await expect
        .poll(() =>
            app.client.evaluate(
                (client, roomId) =>
                    client
                        .getRoom(roomId)!
                        .getLiveTimeline()
                        .getEvents()
                        .some(
                            (event) =>
                                event.getContent().body === "Hello from the desktop shell" &&
                                event.getId()?.startsWith("$"),
                        ),
                first,
            ),
        )
        .toBe(true);
    const eventId = await app.client.evaluate(
        (client, roomId) =>
            client
                .getRoom(roomId)!
                .getLiveTimeline()
                .getEvents()
                .find((event) => event.getContent().body === "Hello from the desktop shell")
                ?.getId(),
        first,
    );
    const onServer = await app.client.evaluate(
        (client, { roomId, eventId }) => client.fetchRoomEvent(roomId, eventId),
        { roomId: first, eventId: eventId! },
    );
    expect(onServer.content?.body).toBe("Hello from the desktop shell");

    await bot.sendMessage(first, "Reply from another Matrix member");
    await expect(page.getByText("Reply from another Matrix member", { exact: true })).toBeVisible();
    await composer.fill("Draft for General");
    await page.getByRole("option", { name: "Open room Design", exact: true }).click();
    await expect(composer).toBeEmpty();
    await composer.fill("Draft for Design");
    await page.getByRole("option", { name: /^Open room General(?: with|$)/ }).click();
    await expect(composer).toHaveText("Draft for General");
    await page.getByRole("option", { name: "Open room Design", exact: true }).click();
    await expect(composer).toHaveText("Draft for Design");
    expect(await app.getCurrentRoomIdFromUrl()).toBe(second);
    await page.getByRole("option", { name: /^Open room General(?: with|$)/ }).click();
    await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
    await page.mouse.move(1200, 15);
    await page.screenshot({ path: testInfo.outputPath("desktop-shell.png") });
});

test("keeps end-to-end encryption in the real Matrix client", async ({ page, app, bot }) => {
    const roomId = await app.client.createRoom({
        name: "Encrypted room",
        invite: [bot.credentials!.userId],
        initial_state: [{ type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } }],
    });
    await app.viewRoomById(roomId);
    await expect.poll(() => bot.evaluate((client, id) => client.getRoom(id)?.getMyMembership(), roomId)).toBe("join");
    const composer = page.getByRole("textbox", { name: "Send a message…" });
    await composer.fill("Encrypted desktop message");
    await composer.press("Enter");
    await expect(page.getByRole("status", { name: "Your message was sent" })).toBeVisible();
    await expect
        .poll(() =>
            bot.evaluate(async (client, id) => {
                const events = client.getRoom(id)!.getLiveTimeline().getEvents();
                for (const event of events) await client.decryptEventIfNeeded(event);
                return events.some((event) => event.getContent().body === "Encrypted desktop message");
            }, roomId),
        )
        .toBe(true);
    const eventId = await app.client.evaluate(
        (client, id) =>
            client
                .getRoom(id)!
                .getLiveTimeline()
                .getEvents()
                .find((event) => event.getContent().body === "Encrypted desktop message")!
                .getId()!,
        roomId,
    );
    const onServer = await app.client.evaluate(
        (client, { roomId, eventId }) => client.fetchRoomEvent(roomId, eventId),
        { roomId, eventId },
    );
    expect(onServer.type).toBe("m.room.encrypted");
    expect(onServer.content?.body).toBeUndefined();
    await bot.sendMessage(roomId, "Encrypted reply");
    await expect(page.getByText("Encrypted reply", { exact: true })).toBeVisible();
});

test("uses Matrix conversations, invitations and blocked users in the desktop contacts page", async ({
    page,
    app,
    bot,
    user,
}, testInfo) => {
    const botId = bot.credentials!.userId;
    const roomId = await app.client.createRoom({ name: "Bob", invite: [botId], is_direct: true });
    await app.client.evaluate(
        async (client, { botId, roomId }) => {
            await client.setAccountData("m.direct" as import("matrix-js-sdk/src/matrix").EventType.Direct, {
                [botId]: [roomId],
            });
        },
        { botId, roomId },
    );
    await app.viewRoomById(roomId);
    await page.getByRole("button", { name: "Friends", exact: true }).click();
    const navigation = page.getByRole("navigation", { name: "Friends" });
    await navigation.getByRole("button", { name: "All", exact: true }).click();
    await expect(page.getByRole("button", { name: "Message", exact: true })).toBeVisible();
    await page.getByRole("searchbox", { name: "Search", exact: true }).fill("does-not-exist");
    await expect(page.getByText("No one matches your search.", { exact: true })).toBeVisible();
    await page.getByRole("searchbox", { name: "Search", exact: true }).fill("");
    await page.mouse.move(1200, 15);
    await page.screenshot({ path: testInfo.outputPath("desktop-contacts.png") });
    await page.getByRole("button", { name: "Message", exact: true }).click();
    await page.waitForURL((url) => url.hash === `#/room/${roomId}`);
    expect(await app.getCurrentRoomIdFromUrl()).toBe(roomId);
    const inviteId = await bot.evaluate(
        async (client, userId) =>
            (await client.createRoom({ name: "Incoming conversation", invite: [userId], is_direct: true })).room_id,
        user.userId,
    );
    await page.getByRole("button", { name: /^Friends/ }).click();
    await navigation.getByRole("button", { name: /^Pending/ }).click();
    await expect(page.getByRole("button", { name: "Accept", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Accept", exact: true }).click();
    await expect
        .poll(() => app.client.evaluate((client, id) => client.getRoom(id)?.getMyMembership(), inviteId))
        .toBe("join");
    await app.client.evaluate((client, id) => client.setIgnoredUsers([id]), botId);
    await page.getByRole("button", { name: /^Friends/ }).click();
    await navigation.getByRole("button", { name: "Blocked", exact: true }).click();
    await expect(page.getByRole("button", { name: "Unblock", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Unblock", exact: true }).click();
    await expect.poll(() => app.client.evaluate((client) => client.getIgnoredUsers())).toEqual([]);
    await page.getByRole("button", { name: "Add Friend", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
});

test("opens native account settings and room search using the existing actions", async ({ page, app, user }) => {
    const roomId = await app.client.createRoom({ name: "Desktop controls" });
    await app.viewRoomById(roomId);
    await page.getByRole("button", { name: "Notifications", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "Mute room", exact: true }).click();
    await expect
        .poll(() =>
            app.client.evaluate(async (client, id) => {
                const rules = await client.getPushRules();
                return rules.global.override?.some(
                    (rule) =>
                        rule.rule_id === id && rule.enabled && rule.actions.some((action) => action === "dont_notify"),
                );
            }, roomId),
        )
        .toBe(true);
    const account = page.getByRole("group", { name: "User menu" });
    await expect(account.getByText(user.userId, { exact: true })).toBeVisible();
    await account.getByRole("button", { name: "All settings" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect
        .poll(() => page.getByRole("dialog").evaluate((dialog) => dialog.contains(document.activeElement)))
        .toBe(true);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await account.getByRole("button", { name: "User menu" }).click();
    await expect(page.getByRole("menuitem", { name: "Security & Privacy" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(account.getByRole("button", { name: "User menu" })).toBeFocused();
    const separator = page.getByRole("separator", { name: "Click or drag to expand" });
    const position = await separator.boundingBox();
    if (!position) throw new Error("Missing sidebar separator");
    await page.mouse.move(position.x + position.width / 2, position.y + position.height / 2);
    await page.mouse.down();
    await page.mouse.move(position.x - 350, position.y + position.height / 2, { steps: 15 });
    await page.mouse.up();
    await expect(account).not.toBeVisible();
    await page.getByRole("button", { name: "User menu" }).click();
    await expect(page.getByRole("menuitem", { name: "Security & Privacy" })).toBeVisible();
    await page.keyboard.press("Escape");
    await separator.click();
    await expect(account).toBeVisible();
    await expect(page.getByRole("button", { name: "User menu" })).toHaveCount(1);
});
