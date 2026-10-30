/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { closeReleaseAnnouncementIfExists, rejectToastIfExists } from "@element-hq/element-web-playwright-common";
import { type Page } from "@playwright/test";

import { test as base, expect } from "../../element-web-test";
import { getSampleFilePath } from "../../sample-files";

const CAPTURES = "/tmp/aether-profile-customisation-captures";

/** A room shared with the bot. Not opened yet, so a test can set up the bot's profile before it is first read. */
const test = base.extend<{ roomId: string }>({
    roomId: async ({ app, bot }, use) => {
        const roomId = await app.client.createRoom({ name: "Showcase" });
        await app.client.inviteUser(roomId, bot.credentials!.userId);
        await bot.joinRoom(roomId);
        await bot.sendMessage(roomId, "Hello from the robot");
        await use(roomId);
    },
});

test.use({
    displayName: "Alice",
    botCreateOpts: { displayName: "Robin" },
    config: { default_theme: "dark", features: { feature_desktop_shell: true } },
});

const popout = (page: Page) => page.getByRole("dialog", { name: "Profile", exact: true });
const members = (page: Page) => page.getByRole("listbox", { name: "Member list", exact: true });
const robinRow = (page: Page) => members(page).getByRole("option", { name: /Robin/ });

test.describe("Profile customisation", () => {
    test.beforeEach(async ({ page }) => {
        await rejectToastIfExists(page, "Verify this device");
        await rejectToastIfExists(page, "Notifications");
        await closeReleaseAnnouncementIfExists(page, "Introducing Sections");
    });

    test("edits a profile with a live preview, stores it on the homeserver and shows it to the owner", async ({
        page,
        app,
        user,
    }) => {
        test.setTimeout(90_000);
        const roomId = await app.client.createRoom({ name: "Showcase" });
        await app.viewRoomById(roomId);
        await app.settings.openUserSettings("Profile");
        const dialog = page.locator(".mx_UserSettingsDialog");
        await expect(dialog.getByText(/Your profile is public/)).toBeVisible();

        // Nothing is stored until Save, but the preview follows every change.
        await dialog.getByLabel("About me").fill("Hello from Aether\nhttps://example.org/about");
        await dialog.getByLabel("Pronouns").fill("she/her");
        await dialog.getByLabel("Status", { exact: true }).fill("Testing profiles");
        await dialog.getByRole("radio", { name: "Flame crown" }).check({ force: true });
        await dialog.getByRole("radio", { name: "Snow" }).check({ force: true });
        await dialog.getByRole("radio", { name: "Moonlit" }).check({ force: true });
        await dialog.getByRole("radio", { name: "Pixel" }).check({ force: true });
        await dialog.getByRole("button", { name: "#14163a #7b2fd0" }).click();
        const preview = dialog.getByRole("complementary", { name: "Preview" });
        await expect(preview.getByText("Testing profiles").first()).toBeVisible();
        await expect(preview.getByText("she/her")).toBeVisible();
        await expect(page.getByText("Careful, you have unsaved changes.")).toBeVisible();
        const unsaved = await app.client.evaluate((client, id) => client.getExtendedProfile(id), user.userId);
        expect(unsaved["io.aether.profile"]).toBeUndefined();
        await page.screenshot({ path: `${CAPTURES}/editor.png`, fullPage: true });

        // Images only leave this computer on Save, and then have to come back through the real media API.
        const sample = getSampleFilePath("riot.png");
        await dialog.locator("input[type=file][aria-label='Change banner']").setInputFiles(sample);
        await expect(preview.locator("img[src^='blob:']")).toBeVisible();
        await dialog.locator("input[type=file][aria-label='Add picture']").setInputFiles(sample);
        await dialog.getByLabel("Title").fill("Riot");

        await dialog.getByRole("button", { name: "Save changes" }).click();
        await expect(page.getByText("Your profile is saved.")).toBeVisible();

        const stored = await app.client.evaluate((client, id) => client.getExtendedProfile(id), user.userId);
        expect(stored["io.aether.profile"]).toMatchObject({
            decoration: "flame-crown",
            effect: "snow",
            nameplate: { preset: "moonlit" },
            name: { font: "pixel" },
            theme: { primary: "#14163a", accent: "#7b2fd0" },
        });
        expect(stored["io.fsky.nyx.pronouns"]).toEqual([expect.objectContaining({ summary: "she/her" })]);
        expect(stored["gay.fomx.biography"]).toEqual({
            "m.text": [{ body: "Hello from Aether\nhttps://example.org/about", mimetype: "text/plain" }],
        });
        expect(stored["org.matrix.msc4426.status"]).toMatchObject({ text: "Testing profiles" });
        expect(stored["chat.commet.profile_banner"]).toMatch(/^mxc:\/\//);
        expect(stored["io.aether.profile"]).toMatchObject({ board: { items: [{ title: "Riot" }] } });

        // The owner sees it straight away on their own card, with a way back to the editor.
        await page.keyboard.press("Escape");
        const ownRow = members(page).getByRole("option", { name: /Alice/ });
        await expect(ownRow.locator('[data-nameplate="moonlit"]')).toBeVisible();
        await ownRow.click();
        await expect(popout(page).getByText("Hello from Aether")).toBeVisible();
        const banner = popout(page).locator("img[src*='thumbnail']").first();
        await expect.poll(() => banner.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
        // Past the card's opening animation, so the capture shows it at full opacity.
        await page.waitForTimeout(400);
        await page.screenshot({ path: `${CAPTURES}/own-card.png` });
        await popout(page).getByRole("button", { name: "Edit profile" }).click();
        await expect(dialog.getByLabel("Pronouns")).toBeVisible();
        await page.keyboard.press("Escape");

        // Clearing the status removes the field outright, rather than storing an empty value.
        await app.settings.openUserSettings("Profile");
        await dialog.getByLabel("Status", { exact: true }).fill("");
        await dialog.getByRole("button", { name: "Save changes" }).click();
        await expect(page.getByText("Your profile is saved.")).toBeVisible();
        const cleared = await app.client.evaluate((client, id) => client.getExtendedProfile(id), user.userId);
        expect(cleared).not.toHaveProperty(["org.matrix.msc4426.status"]);
        await dialog.getByLabel("Status", { exact: true }).fill("Testing profiles");
        await dialog.getByRole("button", { name: "Save changes" }).click();
        await expect(page.getByText("Your profile is saved.")).toBeVisible();
        await page.keyboard.press("Escape");

        // A reload reads it all back: the draft starts from the server, and it starts clean.
        await page.reload();
        await app.settings.openUserSettings("Profile");
        await expect(dialog.getByLabel("Pronouns")).toHaveValue("she/her");
        await expect(dialog.getByRole("radio", { name: "Flame crown" })).toBeChecked();
        await expect(page.getByText("Careful, you have unsaved changes.")).toHaveCount(0);
    });

    test("shows another person's profile everywhere it appears", async ({ page, app, bot, roomId }) => {
        test.setTimeout(90_000);
        await bot.evaluate(async (client) => {
            await client.setExtendedProfileProperty("io.aether.profile", {
                v: 1,
                theme: { primary: "#1b0a0a", accent: "#c8102e" },
                decoration: "flame-crown",
                effect: "embers",
                nameplate: { preset: "embers" },
                name: { font: "pixel", effect: "neon", colour: "#ff3a6a", colour_end: "#ff0044" },
                links: [{ label: "Portfolio", url: "https://example.org/" }],
                board: { title: "Games I like", items: [{ title: "Squad", caption: "brrr" }] },
            });
            await client.setExtendedProfileProperty("gay.fomx.biography", {
                "m.text": [{ body: "Skunk Works.", mimetype: "text/plain" }],
            });
            await client.setExtendedProfileProperty("io.fsky.nyx.pronouns", [{ language: "en", summary: "they/them" }]);
            await client.setExtendedProfileProperty("org.matrix.msc4426.status", { emoji: "🦨", text: "Skunk Works" });
        });
        await app.viewRoomById(roomId);

        // Member list: nameplate, decoration, status line and styled name.
        const row = robinRow(page);
        await expect(row.locator('[data-nameplate="embers"]')).toBeVisible();
        await expect(row.locator('[data-decoration="flame-crown"]')).toBeVisible();
        await expect(row.getByText("Skunk Works")).toBeVisible();
        await expect(row.locator('[data-font="pixel"]')).toBeVisible();
        await members(page).screenshot({ path: `${CAPTURES}/member-list.png` });

        // A styled name stays on the row's centre line, like the plain names around it.
        const centreOffset = await row.evaluate((option) => {
            const centre = (element: Element): number => {
                const { top, height } = element.getBoundingClientRect();
                return top + height / 2;
            };
            const name = option.querySelector(".mx_MemberTileView_text, .mx_MemberTileView_name")!;
            return {
                avatar: centre(option.querySelector(".mx_MemberTileView_avatar")!) - centre(option),
                name: centre(name) - centre(option),
            };
        });
        expect(Math.abs(centreOffset.avatar)).toBeLessThanOrEqual(1);
        expect(Math.abs(centreOffset.name)).toBeLessThanOrEqual(1);
        await expect(row.locator(".mx_PresenceIconView svg[data-presence]")).toBeVisible();

        // Timeline: decoration on the avatar, styled name beside it.
        const tile = page.locator(".mx_EventTile", { hasText: "Hello from the robot" });
        await expect(tile.locator('[data-decoration="flame-crown"]')).toBeVisible();
        await expect(tile.locator('[data-font="pixel"]')).toBeVisible();
        // A decorated avatar stays round, and hovering lightens the row rather than cutting a dark hole in the page.
        const wrapper = tile.locator(".mx_EventTileAvatar_decorated");
        const avatarBox = (await wrapper.locator("> :first-child").boundingBox())!;
        const frameBox = (await wrapper.locator("[data-decoration]").boundingBox())!;
        expect(Math.abs(avatarBox.width - avatarBox.height)).toBeLessThanOrEqual(1);
        // A decorated avatar is the same size as everyone else's: the desktop timeline's 40px.
        expect(avatarBox.width).toBe(40);
        // The decoration is centred on the avatar, whatever size the tile's avatar slot is.
        expect(Math.abs(frameBox.x + frameBox.width / 2 - (avatarBox.x + avatarBox.width / 2))).toBeLessThanOrEqual(1);
        expect(Math.abs(frameBox.y + frameBox.height / 2 - (avatarBox.y + avatarBox.height / 2))).toBeLessThanOrEqual(
            1,
        );
        await tile.hover();
        await page.screenshot({ path: `${CAPTURES}/timeline-hover.png` });

        // Popout.
        await row.click();
        const card = popout(page);
        await expect(card.getByText("Skunk Works.")).toBeVisible();
        await expect(card.getByText("they/them")).toBeVisible();
        await expect(card.locator('[data-tone="dark"]')).toBeVisible();
        await page.waitForTimeout(400);
        await page.screenshot({ path: `${CAPTURES}/popout.png` });

        // Full profile: board first, the link's real destination shown, and a private note.
        await card.getByRole("button", { name: /View full profile of/ }).click();
        const full = page.locator(".mx_DesktopFullProfileDialog");
        await expect(full.getByRole("tab", { name: "Games I like", selected: true })).toBeVisible();
        await expect(full.getByText("Squad")).toBeVisible();
        await expect(full.getByRole("link", { name: /Portfolio/ })).toHaveAttribute("href", "https://example.org/");
        await page.waitForTimeout(400);
        await page.screenshot({ path: `${CAPTURES}/full.png` });

        const note = full.getByLabel(/only you and your homeserver/);
        await note.fill("Met at FOSDEM");
        await full.getByRole("tab", { name: "Games I like" }).focus();
        await expect
            .poll(() =>
                app.client.evaluate((client) =>
                    (client.getAccountData("io.aether.user_notes" as never) as any)?.getContent(),
                ),
            )
            .toMatchObject({ notes: { [bot.credentials!.userId]: "Met at FOSDEM" } });
    });

    test("draws nothing from a hostile profile", async ({ page, app, bot, roomId }) => {
        test.setTimeout(60_000);
        await bot.evaluate(async (client) => {
            await client.setExtendedProfileProperty("io.aether.profile", {
                theme: { primary: "red;background:url(https://tracker.example/t.png)", accent: "#000000" },
                decoration: "<script>alert(1)</script>",
                nameplate: { mxc: "https://tracker.example/n.png" },
                links: [{ label: "Click", url: "javascript:alert(1)" }],
                board: { items: [{ title: "x", mxc: "https://tracker.example/b.png" }] },
            });
            await client.setExtendedProfileProperty("chat.commet.profile_banner", "https://tracker.example/banner.png");
            await client.setExtendedProfileProperty(
                "moe.sable.app.bio",
                '<img src="https://tracker.example/bio.png">Hi',
            );
        });
        const tracker: string[] = [];
        page.on("request", (request) => {
            if (request.url().includes("tracker.example")) tracker.push(request.url());
        });
        await app.viewRoomById(roomId);
        await robinRow(page).click();
        const card = popout(page);
        await expect(card.getByText("Hi")).toBeVisible();
        await expect(card.locator("img[src*='tracker']")).toHaveCount(0);
        await expect(card.locator("[data-tone]")).toHaveCount(0);
        await card.getByRole("button", { name: /View full profile of/ }).click();
        const full = page.locator(".mx_DesktopFullProfileDialog");
        await expect(full.getByRole("heading", { name: "Robin" })).toBeVisible();
        await expect(full.getByRole("link", { name: /Click/ })).toHaveCount(0);
        expect(tracker).toEqual([]);
    });
});
