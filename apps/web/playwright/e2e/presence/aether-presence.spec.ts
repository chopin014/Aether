/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { closeReleaseAnnouncementIfExists, rejectToast } from "@element-hq/element-web-playwright-common";
import { type Page } from "@playwright/test";
import { type MatrixClient } from "matrix-js-sdk/src/matrix";

import { test, expect } from "../../element-web-test";
import { type Bot } from "../../pages/bot";
import { type ElementAppPage } from "../../pages/ElementAppPage";

const EVENT_TYPE = "io.aether.presence";

// The matrix.org case: the homeserver provides no presence, so everything shown comes from Aether signals or
// seen activity.
test.use({
    displayName: "Janet",
    botCreateOpts: { displayName: "Bob" },
    disablePresence: true,
    lockLeftPanelWidth: false,
    config: { default_theme: "dark", features: { feature_desktop_shell: true } },
});

test.beforeEach(async ({ page, user }) => {
    await rejectToast(page, "Verify this device");
    await rejectToast(page, "Notifications");
    await closeReleaseAnnouncementIfExists(page, "Introducing Sections");
});

/** Send an Olm-encrypted `io.aether.presence` from the bot to every device of the user, like a real Aether client. */
async function sendSignal(bot: Bot, userId: string, presence: string, ttlMs = 12 * 60 * 1000): Promise<void> {
    await bot.evaluate(
        async (client, { userId, presence, ttlMs, type }) => {
            const crypto = client.getCrypto()!;
            const devices = await crypto.getUserDeviceInfo([userId], true);
            const targets = [...(devices.get(userId)?.keys() ?? [])].map((deviceId) => ({ userId, deviceId }));
            const batch = await crypto.encryptToDeviceMessages(type, targets, {
                v: 1,
                presence,
                ttl_ms: ttlMs,
                ts: Date.now(),
            });
            await client.queueToDevice(batch);
        },
        { userId, presence, ttlMs, type: EVENT_TYPE },
    );
}

// Encryption keys are only tracked for people we share an encrypted room with, which is who Aether can reach.
const ENCRYPTED = [{ type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } }];

/** A direct chat with the bot, and a two-person room (which has the member list) shared with it. */
async function createRooms(app: ElementAppPage, bot: Bot): Promise<{ dmId: string; groupId: string }> {
    const botId = bot.credentials!.userId;
    const dmId = await app.client.createRoom({
        name: "Bob",
        invite: [botId],
        is_direct: true,
        initial_state: ENCRYPTED,
    });
    await app.client.evaluate(
        async (client: MatrixClient, { botId, dmId }) => {
            await client.setAccountData("m.direct" as never, { [botId]: [dmId] } as never);
        },
        { botId, dmId },
    );
    await bot.joinRoom(dmId);
    const groupId = await app.client.createRoom({ name: "Presence room", invite: [botId], initial_state: ENCRYPTED });
    await bot.joinRoom(groupId);
    return { dmId, groupId };
}

async function openMemberList(page: Page) {
    const members = page.locator(".mx_MemberListView");
    // The panel opens by itself on wide windows; only click the toggle if it has not appeared.
    await members.waitFor({ state: "visible", timeout: 3000 }).catch(async () => {
        await page.getByRole("button", { name: "2 members", exact: true }).click();
    });
    await expect(members).toBeVisible();
    return members;
}

test("shows another Aether client's encrypted signal in the member list and on the DM avatar", async ({
    page,
    app,
    bot,
    user,
}, testInfo) => {
    const { groupId } = await createRooms(app, bot);
    await app.viewRoomById(groupId);
    const members = await openMemberList(page);
    const bobTile = members.getByRole("option").filter({ hasText: "Bob" });
    const dmEntry = page.getByRole("button", { name: /^Open room Bob/ });
    const dot = bobTile.locator(".mx_PresenceIconView");

    await expect(bobTile).toBeVisible();

    await sendSignal(bot, user.userId, "online");
    await expect(dot.locator(".mx_PresenceIconView_online")).toBeVisible();
    await expect(dmEntry.getByLabel("Online", { exact: true })).toBeVisible();
    await expect(members.getByRole("heading", { name: /^Offline/ })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("aether-online.png") });

    await sendSignal(bot, user.userId, "unavailable");
    await expect(dot.locator(".mx_PresenceIconView_unavailable")).toBeVisible();
    await expect(dmEntry.getByLabel("Away", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("aether-away.png") });

    await sendSignal(bot, user.userId, "offline");
    await expect(dot.locator(".mx_PresenceIconView_offline")).toBeVisible();
    await expect(dmEntry.getByLabel("Offline", { exact: true })).toBeVisible();
    await expect(members.getByRole("heading", { name: /^Offline/ })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("aether-offline.png") });
});

test("falls back to offline, with when it was last seen, once an Aether signal expires", async ({
    page,
    app,
    bot,
    user,
}) => {
    const { groupId } = await createRooms(app, bot);
    await app.viewRoomById(groupId);
    const members = await openMemberList(page);
    const dot = members.getByRole("option").filter({ hasText: "Bob" }).locator(".mx_PresenceIconView");

    // A receiver never believes a signal for longer than the sender said it should.
    await sendSignal(bot, user.userId, "online", 4000);
    await expect(dot.locator(".mx_PresenceIconView_online")).toBeVisible();
    await expect(dot.locator(".mx_PresenceIconView_offline")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: /^Open room Bob/ }).getByLabel(/^Offline · last seen/)).toBeVisible();
});

test("labels a non-Aether user's recent message as activity, never as online", async ({ page, app, bot }) => {
    const { groupId } = await createRooms(app, bot);
    await app.viewRoomById(groupId);
    const members = await openMemberList(page);
    const bobTile = members.getByRole("option").filter({ hasText: "Bob" });

    await bot.sendMessage(groupId, "hello from a client with no Aether");
    await expect(page.getByText("hello from a client with no Aether")).toBeVisible();

    const dmEntry = page.getByRole("button", { name: /^Open room Bob/ });
    await expect(dmEntry.getByLabel("Active now", { exact: true })).toBeVisible();
    await expect(dmEntry.getByLabel("Online", { exact: true })).toHaveCount(0);
    await expect(bobTile.locator(".mx_PresenceIconView_online")).toBeVisible();
    // Seen activity says nothing certain, so it must not put someone in the Online group.
    await expect(members.getByRole("heading", { name: /^Offline/ })).toHaveCount(0);
});

test("sends its own encrypted presence on start and when the preference changes", async ({ page, app, bot, user }) => {
    test.setTimeout(120_000);
    // Registered before any room exists, so the first send after the page loads is captured.
    const sent: { type: string; messages: Record<string, Record<string, unknown>> }[] = [];
    await page.route("**/_matrix/client/v3/sendToDevice/**", async (route) => {
        const type = decodeURIComponent(
            new URL(route.request().url()).pathname.split("/sendToDevice/")[1].split("/")[0],
        );
        sent.push({ type, messages: route.request().postDataJSON().messages });
        await route.continue();
    });

    await createRooms(app, bot);
    await page.reload();
    await expect(page.getByRole("button", { name: "User menu", exact: true })).toBeVisible();

    // Presence is never sent in the clear: the wire type is m.room.encrypted.
    await expect.poll(() => sent.map((s) => s.type), { timeout: 60_000 }).toContain("m.room.encrypted");
    expect(sent.some((s) => s.type === EVENT_TYPE)).toBe(false);
    const botId = bot.credentials!.userId;
    expect(sent.some((s) => botId in s.messages)).toBe(true);

    // Changing the preference sends again straight away.
    const before = sent.length;
    await page.getByRole("button", { name: "User menu", exact: true }).click();
    await page.getByRole("menuitem", { name: "Online" }).click();
    await page.getByRole("menuitemradio", { name: "Appear offline" }).click();
    await expect.poll(() => sent.length).toBeGreaterThan(before);
});

test("keeps our member-row status in sync with local presence without a server echo", async ({ page, app, bot }) => {
    const { groupId } = await createRooms(app, bot);
    await app.viewRoomById(groupId);
    const members = await openMemberList(page);
    const self = members.getByRole("option").filter({ hasText: "Janet" });
    await expect(self.locator(".mx_PresenceIconView_online")).toBeVisible();
    const account = page.getByRole("button", { name: "User menu", exact: true });

    for (const { previous, next, icon } of [
        { previous: "Online", next: "Away", icon: "unavailable" },
        { previous: "Away", next: "Appear offline", icon: "offline" },
        { previous: "Appear offline", next: "Online", icon: "online" },
    ]) {
        await account.click();
        await page.getByRole("menuitem", { name: previous, exact: true }).click();
        await page.getByRole("menuitemradio", { name: next, exact: true }).click();
        await page.keyboard.press("Escape");
        await page.keyboard.press("Escape");
        await expect(self.locator(`.mx_PresenceIconView_${icon}`)).toBeVisible();
        await expect(account.getByRole("img", { name: next, exact: true })).toBeVisible();
        await expect(members.getByRole("heading", { name: /^Offline/ })).toHaveCount(icon === "offline" ? 1 : 0);
    }
});
