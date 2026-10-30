/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { closeReleaseAnnouncementIfExists, rejectToastIfExists } from "@element-hq/element-web-playwright-common";
import { type Locator, type Page } from "@playwright/test";

import { test as base, expect } from "../../element-web-test";

const SPACE = "Terra do boi gordo";

/** A server with a text channel open, as the account dock, server header and composer are reviewed in. */
const test = base.extend<{ spaceId: string }>({
    spaceId: async ({ page, app, user }, use) => {
        await rejectToastIfExists(page, "Verify this device");
        await rejectToastIfExists(page, "Notifications");
        await closeReleaseAnnouncementIfExists(page, "Introducing Sections");
        const geral = await app.client.createRoom({ name: "geral" });
        const spaceId = await app.client.createSpace({
            name: SPACE,
            initial_state: [{ type: "m.space.child", state_key: geral, content: { via: [user.homeServer] } }],
        });
        await app.viewSpaceByName(SPACE);
        await page
            .getByRole("navigation", { name: "Room list" })
            .getByRole("button", { name: /Open room geral/ })
            .click();
        await expect(page.getByRole("heading", { name: "geral", exact: true })).toBeVisible();
        await use(spaceId);
    },
});

test.use({
    displayName: "Alice",
    lockLeftPanelWidth: false,
    config: {
        default_theme: "dark",
        features: { feature_desktop_shell: true, feature_video_rooms: true, feature_element_call_video_rooms: true },
        element_call: { use_exclusively: true },
    },
});

const dock = (page: Page): Locator => page.locator(".mx_DesktopShell_accountDock");

test("centres the account dock under the server rail and channels", async ({ page, spaceId }) => {
    const rail = await page.getByRole("navigation", { name: "Servers", exact: true }).boundingBox();
    const channels = await page.getByRole("navigation", { name: "Room list" }).boundingBox();
    const box = await dock(page).boundingBox();
    const left = box!.x - rail!.x;
    const right = channels!.x + channels!.width - (box!.x + box!.width);
    expect(Math.abs(left - right)).toBeLessThanOrEqual(1);
});

test("mutes from the dock and picks devices and volumes from its menus", async ({ page, spaceId }) => {
    const mute = dock(page).getByRole("button", { name: "Mute", exact: true });
    await mute.click();
    const unmute = dock(page).getByRole("button", { name: "Unmute", exact: true });
    await expect(unmute).toHaveAttribute("aria-pressed", "true");
    // The slash draws across the microphone, and the control turns red.
    await expect(unmute.locator("[data-off]")).toHaveAttribute("data-animate", "true");
    await expect(unmute.locator("..")).toHaveAttribute("data-muted", "true");

    await dock(page).getByRole("button", { name: "Input options" }).click();
    const input = page.getByRole("dialog", { name: "Input options" });
    await expect(input.getByRole("combobox", { name: "Input device" })).toBeVisible();
    await input.getByRole("slider", { name: "Input volume" }).fill("40");
    // The saved volume comes back when the menu opens again.
    await expect(input.getByText("40%")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(input).not.toBeVisible();
    await dock(page).getByRole("button", { name: "Input options" }).click();
    await expect(input.getByRole("slider", { name: "Input volume" })).toHaveValue("40");
    await page.keyboard.press("Escape");

    await dock(page).getByRole("button", { name: "Output options" }).click();
    const output = page.getByRole("dialog", { name: "Output options" });
    await expect(output.getByRole("combobox", { name: "Output device" })).toBeVisible();
    await output.getByRole("button", { name: "Voice settings" }).click();
    await expect(page.getByRole("dialog", { name: /Settings/ }).getByRole("tab", { name: /Voice/ })).toHaveAttribute(
        "aria-selected",
        "true",
    );
});

test("keeps the server name with its menu arrow, and invite at the header's end", async ({ page, spaceId }) => {
    const header = page.getByTestId("room-list-header");
    const name = header.getByRole("button", { name: "Open server menu" });
    const invite = header.getByRole("button", { name: "Invite" });
    const nameBox = await name.boundingBox();
    const inviteBox = await invite.boundingBox();
    const headerBox = await header.boundingBox();
    // The name only spans its text and arrow, so it does not reach the invite button.
    expect(nameBox!.x + nameBox!.width).toBeLessThan(inviteBox!.x - 8);
    expect(headerBox!.x + headerBox!.width - (inviteBox!.x + inviteBox!.width)).toBeLessThanOrEqual(16);
    await name.click();
    await expect(page.getByRole("menuitem", { name: "Server home" })).toBeVisible();
});

test("shows explore beside the search as a matching square", async ({ page, app, spaceId }) => {
    await page.getByRole("navigation", { name: "Servers", exact: true }).getByRole("button", { name: "Home" }).click();
    const search = await page
        .getByRole("search")
        .getByRole("button", { name: /Search/ })
        .boundingBox();
    const explore = page.getByRole("button", { name: "Explore rooms" });
    const box = await explore.boundingBox();
    expect(box!.height).toBeCloseTo(search!.height, 0);
    expect(box!.width).toBeCloseTo(box!.height, 0);
    const radii = await page.evaluate(
        ([a, b]) => [a, b].map((el) => getComputedStyle(el!).borderRadius),
        [
            await page
                .getByRole("search")
                .getByRole("button", { name: /Search/ })
                .elementHandle(),
            await explore.elementHandle(),
        ],
    );
    expect(radii[1]).toBe(radii[0]);
});

test("offers voice messages beside the emoji button", async ({ page, spaceId }) => {
    const composer = page.locator(".mx_MessageComposer");
    const emoji = await composer.getByRole("button", { name: "Emoji" }).boundingBox();
    const voice = await composer.getByRole("button", { name: "Voice Message" }).boundingBox();
    expect(voice!.x).toBeGreaterThan(emoji!.x);
    expect(voice!.x - (emoji!.x + emoji!.width)).toBeLessThanOrEqual(16);
});
