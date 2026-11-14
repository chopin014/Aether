/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../../element-web-test";

/**
 * The room timeline host lab (`feature_retained_room_timeline`): the main room view lends its timeline's place to a
 * host that draws the timeline there. Rooms should open, and their timelines behave, as without it.
 */

/** The row the timeline draws for an event. Rows are keyed by event id. */
const timelineRow = (page: Page, eventId: string): Locator =>
    page.locator(`.mx_TimelineView_tile[data-key="${eventId}"]`);

/** How far the timeline is from its live end, in pixels. */
const distanceFromLiveEnd = (page: Page): Promise<number> =>
    page.evaluate(() => {
        const scroller = document.querySelector('[data-testid="timeline-scroller"]');
        if (!(scroller instanceof HTMLElement)) return Number.MAX_SAFE_INTEGER;
        return scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
    });

test.describe("Room timeline host", () => {
    test.use({
        displayName: "Alice",
        labsFlags: ["feature_retained_room_timeline"],
    });

    test("draws the room's timeline in the room's timeline area", async ({ page, app, user }) => {
        const roomId = await app.client.createRoom({ name: "Hosted" });
        const message = await app.client.sendMessage(roomId, "Hello from the host");

        await app.viewRoomById(roomId);

        const area = page.locator(`main[data-room-id="${roomId}"]`);
        await expect(area.locator(".mx_RoomTimelineSlot .mx_NewTimelinePanel")).toBeVisible();
        await expect(timelineRow(page, message.event_id)).toContainText("Hello from the host");
        await expect(page.locator(".mx_NewTimelinePanel")).toHaveCount(1);
    });

    test("shows each room's own messages as rooms are opened one after another, and on coming back", async ({
        page,
        app,
        user,
    }) => {
        const first = await app.client.createRoom({ name: "First" });
        const second = await app.client.createRoom({ name: "Second" });
        const inFirst = await app.client.sendMessage(first, "In the first room");
        const inSecond = await app.client.sendMessage(second, "In the second room");

        for (const [roomId, message, text] of [
            [first, inFirst, "In the first room"],
            [second, inSecond, "In the second room"],
            [first, inFirst, "In the first room"],
        ] as const) {
            await app.viewRoomById(roomId);
            await expect(timelineRow(page, message.event_id)).toContainText(text);
            await expect(page.locator(`main[data-room-id="${roomId}"] .mx_NewTimelinePanel`)).toHaveCount(1);
            await expect(page.locator(".mx_NewTimelinePanel")).toHaveCount(1);
        }
    });

    test("opens a room at a linked message", async ({ page, app, user }) => {
        const roomId = await app.client.createRoom({ name: "Linked" });
        const linked = await app.client.sendMessage(roomId, "The linked message");
        for (let i = 1; i <= 20; i++) {
            await app.client.sendMessage(roomId, `Later message ${i}. ${"Padding. ".repeat(30)}`);
        }

        await page.goto(`/#/room/${roomId}/${linked.event_id}`);

        await expect(timelineRow(page, linked.event_id)).toBeInViewport();
    });

    test("hands the room view the keys pressed in its timeline, and the app the ones it leaves", async ({
        page,
        app,
        user,
    }) => {
        const roomId = await app.client.createRoom({ name: "Keys" });
        for (let i = 1; i <= 20; i++) {
            await app.client.sendMessage(roomId, `Message ${i}. ${"Padding. ".repeat(30)}`);
        }
        const newest = await app.client.sendMessage(roomId, "The newest message");
        await app.viewRoomById(roomId);
        await expect(timelineRow(page, newest.event_id)).toBeVisible();

        // Scrolled away from the newest message, with the timeline focused.
        const scroller = page.getByTestId("timeline-scroller");
        await scroller.hover();
        await page.mouse.wheel(0, -3000);
        await expect.poll(() => distanceFromLiveEnd(page)).toBeGreaterThan(500);
        await scroller.focus();

        // Escape is the room view's: it goes back to the newest message.
        await page.keyboard.press("Escape");
        await expect.poll(() => distanceFromLiveEnd(page), { timeout: 15_000 }).toBeLessThanOrEqual(4);

        // A letter is the app's: it starts a message in the composer.
        await scroller.focus();
        await page.keyboard.type("h");
        await expect(app.getComposerField()).toBeFocused();
        await expect(app.getComposerField()).toHaveText("h");
    });

    test("sends a message from the composer into the hosted timeline", async ({ page, app, user }) => {
        const roomId = await app.client.createRoom({ name: "Send" });
        await app.viewRoomById(roomId);
        await expect(page.locator(".mx_RoomTimelineSlot .mx_NewTimelinePanel")).toBeVisible();

        const composer = app.getComposerField();
        await composer.fill("Sent through the host");
        await composer.press("Enter");

        await expect(page.locator(".mx_TimelineView_tile", { hasText: "Sent through the host" })).toHaveCount(1);
    });
});
