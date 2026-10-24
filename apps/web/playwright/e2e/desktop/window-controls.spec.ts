/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { mkdir } from "node:fs/promises";
import { closeReleaseAnnouncementIfExists, rejectToast } from "@element-hq/element-web-playwright-common";
import type { EventType, MsgType } from "matrix-js-sdk/src/matrix";
import type { Page } from "@playwright/test";

import { test, expect } from "../../element-web-test";
import { readSampleFileSync } from "../../sample-files";

// The browser has no native window controls, so emulate the desktop overlay: the minimise, maximise and close
// buttons (138x48) in the top right corner, which Electron paints above all web content. The shell reads the
// overlay from two variables, which resolve to this in the desktop app.
const CONTROLS_WIDTH = 138;
const CONTROLS_HEIGHT = 48;
const CAPTURES = process.env.AETHER_CAPTURE_DIR;

async function emulateWindowControls(page: Page): Promise<void> {
    await page.evaluate(
        ({ width, height }) => {
            document.body.style.setProperty("--mx-window-controls-inline-size", `${width}px`);
            document.body.style.setProperty("--mx-window-controls-block-size", `${height}px`);
        },
        { width: CONTROLS_WIDTH, height: CONTROLS_HEIGHT },
    );
}

/** The visible interactive elements inside `rootSelector` that overlap the area the window controls cover. */
async function controlsOverlaps(page: Page, rootSelector = "body"): Promise<string[]> {
    return page.evaluate(
        ({ width, height, rootSelector, viewportWidth }) => {
            const hits: string[] = [];
            const selector =
                "button, a[href], input, select, textarea, summary, [role=button], [role=menuitem], [role=option], [role=tab], [role=checkbox]";
            const left = viewportWidth - width;
            for (const el of document.querySelector(rootSelector)!.querySelectorAll(selector)) {
                const rect = el.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0) continue;
                if (getComputedStyle(el).visibility === "hidden") continue;
                if (rect.top < height && rect.right > left && rect.bottom > 0 && rect.left < viewportWidth) {
                    hits.push(
                        `${el.getAttribute("aria-label") ?? el.textContent?.slice(0, 30)} @ ${rect.x},${rect.y} ${rect.width}x${rect.height} ${el.className}`,
                    );
                }
            }
            return hits;
        },
        { width: CONTROLS_WIDTH, height: CONTROLS_HEIGHT, rootSelector, viewportWidth: page.viewportSize()!.width },
    );
}

test.describe("window controls", () => {
    test.use({
        displayName: "Alice",
        botCreateOpts: { displayName: "Robin" },
        config: { default_theme: "dark", features: { feature_desktop_shell: true } },
    });

    test.beforeEach(async ({ page, user }) => {
        await rejectToast(page, "Verify this device");
        await rejectToast(page, "Notifications");
        await closeReleaseAnnouncementIfExists(page, "Introducing Sections");
        await page.setViewportSize({ width: 1280, height: 720 });
    });

    const capture = async (page: Page, name: string): Promise<void> => {
        if (!CAPTURES) return;
        await mkdir(CAPTURES, { recursive: true });
        await page.screenshot({ path: `${CAPTURES}/${name}.png` });
    };

    test("keeps overlays clear of the window controls", async ({ page, app, bot }) => {
        const roomId = await app.client.createRoom({ name: "Window controls" });
        await app.client.inviteUser(roomId, bot.credentials!.userId);
        await bot.joinRoom(roomId);
        const upload = await app.client.uploadContent(readSampleFileSync("element.png", null), {
            name: "image.png",
            type: "image/png",
        });
        await app.client.sendEvent(roomId, null, "m.room.message" as EventType, {
            msgtype: "m.image" as MsgType,
            body: "image.png",
            url: upload.content_uri,
        });
        await app.viewRoomById(roomId);
        await expect(page.getByRole("listbox", { name: "Member list", exact: true })).toBeVisible();
        await emulateWindowControls(page);
        await expect.poll(() => controlsOverlaps(page)).toEqual([]);

        // The image viewer's toolbar sits left of the controls.
        await page.locator(".mx_ImageBody").first().click();
        const viewer = page.locator(".mx_ImageView");
        const close = viewer.getByRole("button", { name: "Close" });
        await expect(close).toBeVisible();
        expect(await controlsOverlaps(page)).toEqual([]);
        expect((await close.boundingBox())!.x + (await close.boundingBox())!.width).toBeLessThanOrEqual(
            1280 - CONTROLS_WIDTH,
        );
        await capture(page, "image-viewer");
        await page.keyboard.press("Escape");
        await expect(viewer).not.toBeAttached();

        // A menu opened from the header, next to the controls.
        await page
            .locator(".mx_RoomHeader")
            .getByRole("button", { name: /notification/i })
            .click();
        const menu = page.getByRole("menu");
        await expect(menu).toBeVisible();
        expect(await controlsOverlaps(page)).toEqual([]);
        await capture(page, "header-menu");
        await page.keyboard.press("Escape");
        await expect(menu).not.toBeAttached();

        // The pins popover.
        await page.getByRole("button", { name: "Pinned messages", exact: true }).click();
        const pins = page.getByRole("dialog", { name: "Pinned messages", exact: true });
        await expect(pins).toBeVisible();
        expect(await controlsOverlaps(page)).toEqual([]);
        await page.keyboard.press("Escape");
        await expect(pins).not.toBeVisible();

        // The threads popover.
        await page.locator(".mx_RoomHeader").getByRole("button", { name: "Threads", exact: true }).click();
        await expect(page.getByRole("dialog", { name: /threads/i })).toBeVisible();
        expect(await controlsOverlaps(page)).toEqual([]);
        await page.keyboard.press("Escape");

        // The profile popout from the first member in the list.
        const members = page.getByRole("listbox", { name: "Member list", exact: true });
        await members.getByRole("option").first().click();
        await expect(page.getByRole("dialog", { name: "Profile", exact: true })).toBeVisible();
        expect(await controlsOverlaps(page)).toEqual([]);
        await page.keyboard.press("Escape");

        // Spotlight.
        await app.openSpotlight();
        await expect(page.getByRole("dialog", { name: "Search Dialog" })).toBeVisible();
        expect(await controlsOverlaps(page)).toEqual([]);
        await page.keyboard.press("Escape");

        // A settings dialog, also in a window short enough for it to reach the corner.
        await app.settings.openUserSettings("Account");
        await expect(page.locator(".mx_Dialog").first()).toBeVisible();
        expect(await controlsOverlaps(page)).toEqual([]);
        await capture(page, "settings");
        await page.setViewportSize({ width: 560, height: 300 });
        await expect.poll(() => controlsOverlaps(page, ".mx_Dialog_wrapper")).toEqual([]);
        const dialogBox = (await page.locator(".mx_Dialog_border").first().boundingBox())!;
        expect(dialogBox.y).toBeGreaterThanOrEqual(CONTROLS_HEIGHT);
        await capture(page, "settings-small-window");
    });
});
