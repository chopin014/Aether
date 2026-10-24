/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { closeReleaseAnnouncementIfExists, rejectToast } from "@element-hq/element-web-playwright-common";

import { test, expect } from "../../element-web-test";

test.use({
    displayName: "Alice",
    config: { default_theme: "dark", features: { feature_desktop_shell: true } },
});

test.beforeEach(async ({ page, user }) => {
    await rejectToast(page, "Verify this device");
    await rejectToast(page, "Notifications");
    await closeReleaseAnnouncementIfExists(page, "Introducing Sections");
});

test("browses populated pins without replacing members, jumps, dismisses and unpins through Matrix", async ({
    page,
    app,
}, testInfo) => {
    const roomId = await app.client.createRoom({ name: "Pinned release notes" });
    const eventId = await app.client.evaluate(async (client, roomId) => {
        const result = await client.sendTextMessage(roomId, "Release notes: ready for review");
        const second = await client.sendTextMessage(roomId, "Design notes: keep the member list visible");
        const upload = await client.uploadContent(new Blob(["Release attachment"], { type: "text/plain" }), {
            name: "release.txt",
        });
        const attachment = await client.sendMessage(roomId, {
            msgtype: "m.file" as import("matrix-js-sdk/src/matrix").MsgType.File,
            body: "release.txt",
            url: upload.content_uri,
            info: { mimetype: "text/plain", size: 18 },
        });
        await client.sendStateEvent(
            roomId,
            "m.room.pinned_events" as import("matrix-js-sdk/src/matrix").EventType.RoomPinnedEvents,
            { pinned: [result.event_id, second.event_id, attachment.event_id] },
            "",
        );
        return result.event_id;
    }, roomId);
    await app.viewRoomById(roomId);
    const members = page.getByRole("listbox", { name: "Member list", exact: true });
    await expect(members).toBeVisible();
    const trigger = page.getByRole("button", { name: "Pinned messages", exact: true });
    await trigger.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Pinned messages", exact: true });
    await expect(dialog.getByText("Release notes: ready for review", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Alice", { exact: true }).first()).toBeVisible();
    await expect(dialog.getByText("release.txt", { exact: true }).first()).toBeVisible();
    await expect(dialog.locator("time").first()).toBeVisible();
    await expect(members).toBeVisible();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    const anchor = (await trigger.boundingBox())!;
    const panel = (await dialog.boundingBox())!;
    expect(panel.y).toBeGreaterThanOrEqual(anchor.y + anchor.height);
    await page.screenshot({ path: testInfo.outputPath("populated-pins.png") });
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await expect(dialog).toBeVisible();
    await trigger.click();
    await expect(dialog).not.toBeVisible();
    await trigger.click();
    await dialog
        .getByRole("listitem")
        .filter({ hasText: "Release notes: ready for review" })
        .getByRole("button", { name: "Jump to message" })
        .click();
    await expect(dialog).not.toBeVisible();
    await expect(members).toBeVisible();
    await expect.poll(() => decodeURIComponent(new URL(page.url()).hash)).toContain(eventId);
    await trigger.click();
    await dialog
        .getByRole("listitem")
        .filter({ hasText: "Release notes: ready for review" })
        .getByRole("button", { name: "Unpin", exact: true })
        .click();
    await expect(dialog.getByText("Release notes: ready for review", { exact: true })).not.toBeVisible();
    await expect
        .poll(() =>
            app.client.evaluate(async (client, roomId) => {
                const state = await client.getStateEvent(
                    roomId,
                    "m.room.pinned_events" as import("matrix-js-sdk/src/matrix").EventType.RoomPinnedEvents,
                    "",
                );
                return state.pinned;
            }, roomId),
        )
        .not.toContain(eventId);
    await page.setViewportSize({ width: 640, height: 700 });
    const narrowPanel = (await dialog.boundingBox())!;
    expect(narrowPanel.x).toBeGreaterThanOrEqual(0);
    expect(narrowPanel.x + narrowPanel.width).toBeLessThanOrEqual(640);
    await page.screenshot({ path: testInfo.outputPath("narrow-pins.png") });
    await page.getByRole("navigation", { name: "Room list", exact: true }).click({ position: { x: 16, y: 500 } });
    await expect(dialog).not.toBeVisible();
});

test("shows empty and unavailable pins, retries, and updates unpin permissions", async ({ page, app }) => {
    // Room v10 lets this disposable room's creator lower their own power level.
    const roomId = await app.client.createRoom({ name: "Pin states", room_version: "10" });
    await app.viewRoomById(roomId);
    const trigger = page.getByRole("button", { name: "Pinned messages", exact: true });
    const dialog = page.getByRole("dialog", { name: "Pinned messages", exact: true });
    await trigger.click();
    await expect(dialog.getByRole("heading", { name: "No pinned messages yet" })).toBeVisible();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(trigger).toBeFocused();
    await app.client.evaluate(
        (client, roomId) =>
            client.sendStateEvent(
                roomId,
                "m.room.pinned_events" as import("matrix-js-sdk/src/matrix").EventType.RoomPinnedEvents,
                { pinned: ["$unavailable"] },
                "",
            ),
        roomId,
    );
    await trigger.click();
    await expect(dialog.getByRole("alert")).toContainText("Some pinned messages could not be loaded");
    await expect(dialog.getByText(/This message is unavailable/)).toBeVisible();
    await dialog.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("Some pinned messages could not be loaded");
    await expect(dialog.getByRole("button", { name: "Unpin", exact: true })).toBeVisible();
    await app.client.evaluate(
        (client, roomId) =>
            client.sendStateEvent(
                roomId,
                "m.room.power_levels" as import("matrix-js-sdk/src/matrix").EventType.RoomPowerLevels,
                { users: { [client.getSafeUserId()]: 0 }, state_default: 50 },
                "",
            ),
        roomId,
    );
    await expect(dialog.getByRole("button", { name: "Unpin", exact: true })).not.toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
});
