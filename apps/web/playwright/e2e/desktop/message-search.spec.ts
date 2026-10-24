/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { closeReleaseAnnouncementIfExists, rejectToast } from "@element-hq/element-web-playwright-common";
import { type Page } from "@playwright/test";

import { test as base, expect } from "../../element-web-test";

const CAPTURES = "/tmp/aether-discord-search-captures";

interface Fixtures {
    spaceId: string;
    generalId: string;
    randomId: string;
}

const test = base.extend<Fixtures>({
    generalId: async ({ app, bot, user }, use) => {
        const roomId = await app.client.createRoom({ name: "general", invite: [bot.credentials!.userId] });
        await bot.joinRoom(roomId);
        await use(roomId);
    },
    randomId: async ({ app, bot, user }, use) => {
        const roomId = await app.client.createRoom({ name: "random", invite: [bot.credentials!.userId] });
        await bot.joinRoom(roomId);
        await use(roomId);
    },
    spaceId: async ({ app, user, generalId, randomId }, use) => {
        const spaceId = await app.client.createSpace({
            name: "Guizika",
            initial_state: [generalId, randomId].map((roomId) => ({
                type: "m.space.child",
                state_key: roomId,
                content: { via: [user.homeServer] },
            })),
        });
        await use(spaceId);
    },
});

test.use({ displayName: "Alice", botCreateOpts: { displayName: "Robin" } });

async function seed(
    app: Parameters<Parameters<typeof test>[2]>[0]["app"],
    bot: Parameters<Parameters<typeof test>[2]>[0]["bot"],
    generalId: string,
    randomId: string,
): Promise<void> {
    await app.client.sendMessage(generalId, "budget plan for the quarter");
    await bot.sendMessage(generalId, "budget report is ready");
    const { content_uri: url } = await app.client.uploadContent(Buffer.from("%PDF-1.4 test"), {
        name: "quarterly.pdf",
        type: "application/pdf",
    });
    await app.client.sendMessage(generalId, {
        msgtype: "m.file",
        body: "quarterly.pdf",
        url,
        info: { mimetype: "application/pdf", size: 13 },
    });
    await app.client.sendMessage(randomId, "budget jokes only");
}

const searchBox = (page: Page) => page.getByRole("combobox", { name: "Search", exact: true });
const filters = (page: Page) => page.getByRole("listbox", { name: "Search filters" });
const results = (page: Page) => page.getByRole("region", { name: "Search results", exact: true });

async function focusMessageSearch(page: Page, initialText?: string): Promise<void> {
    await page.evaluate((text) => {
        const dispatcher = (
            window as unknown as Window & {
                mxDispatcher: { dispatch(payload: { action: string; initialText?: string }): void };
            }
        ).mxDispatcher;
        dispatcher.dispatch({ action: "focus_search", initialText: text });
    }, initialText);
}

for (const theme of ["dark", "light"] as const) {
    test.describe(`${theme} theme`, () => {
        test.describe.configure({ timeout: 60_000 });
        test.use({ config: { default_theme: theme, features: { feature_desktop_shell: true } } });

        test.beforeEach(async ({ page, app, bot, generalId, randomId, spaceId }) => {
            await rejectToast(page, "Verify this device");
            await rejectToast(page, "Notifications");
            await closeReleaseAnnouncementIfExists(page, "Introducing Sections");
            await seed(app, bot, generalId, randomId);
            await app.viewSpaceByName("Guizika");
            await app.viewRoomById(generalId);
            await expect(page.getByText("budget report is ready")).toBeVisible();
            await expect(page.getByRole("button", { name: "Pinned messages", exact: true })).toHaveCount(1);
        });

        test("focusing the header input shows the filters, and from: user narrows the results", async ({ page }) => {
            const input = searchBox(page);
            await expect(input).toHaveAttribute("placeholder", "Search Guizika");
            await input.click();
            await expect(filters(page)).toBeVisible();
            await expect(filters(page).getByRole("option", { name: /Sent in a specific channel/ })).toBeVisible();
            await expect(filters(page).getByRole("option", { name: /Mentions a specific user/ })).toBeVisible();
            await page.screenshot({ path: `${CAPTURES}/filters-${theme}.png` });

            await filters(page)
                .getByRole("option", { name: /From a specific user/ })
                .click();
            await expect(input).toHaveValue("from:");
            await page.keyboard.type("Rob");
            await filters(page).getByRole("option", { name: /Robin/ }).click();

            await expect(page.getByRole("button", { name: "Remove filter from:Robin" })).toBeVisible();
            const panel = results(page);
            await expect(panel.getByRole("heading", { level: 2 })).toHaveText("1 result");
            await expect(panel.getByText("budget report is ready")).toBeVisible();
            await expect(panel.getByText("budget plan for the quarter")).not.toBeVisible();

            await page.keyboard.type("budget");
            await page.keyboard.press("Enter");
            await expect(panel.getByText("budget report is ready")).toBeVisible();
            await expect(panel.locator("mark", { hasText: "budget" })).toBeVisible();
            await expect(panel.getByRole("heading", { level: 2 })).toHaveText("1 result");
            await page.screenshot({ path: `${CAPTURES}/results-${theme}.png` });
        });

        test("searches the whole space, and in: narrows to one channel", async ({ page }) => {
            const input = searchBox(page);
            await input.fill("budget");
            await input.press("Enter");
            const panel = results(page);
            await expect(panel.getByRole("region", { name: "general" })).toBeVisible();
            await expect(panel.getByRole("region", { name: "random" })).toBeVisible();

            await input.fill("in:");
            await filters(page).getByRole("option", { name: "random" }).click();
            await expect(panel.getByRole("region", { name: "random" })).toBeVisible();
            await expect(panel.getByRole("region", { name: "general" })).not.toBeVisible();
            await expect(panel.getByText("budget jokes only")).toBeVisible();
        });

        test("has:file returns only the file messages", async ({ page }) => {
            const input = searchBox(page);
            await input.fill("has:");
            await filters(page).getByRole("option", { name: "Attachment or file" }).click();
            const panel = results(page);
            await expect(panel.getByRole("heading", { level: 2 })).toHaveText("1 result");
            await expect(panel.getByText("quarterly.pdf").first()).toBeVisible();
            await expect(panel.getByText("budget report is ready")).not.toBeVisible();
        });

        test("has:image searches encrypted history and the result card opens the message", async ({ page, app }) => {
            const roomId = await app.client.createRoom({
                name: "Encrypted photos",
                initial_state: [
                    { type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } },
                ],
            });
            await app.viewRoomById(roomId);
            await expect
                .poll(() =>
                    app.client.evaluate((client, id) => client.getCrypto()!.isEncryptionEnabledInRoom(id), roomId),
                )
                .toBe(true);
            const { content_uri: url } = await app.client.uploadContent(
                Buffer.from(
                    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
                    "base64",
                ),
                { name: "encrypted-photo.png", type: "image/png" },
            );
            const { event_id: eventId } = await app.client.sendMessage(roomId, {
                msgtype: "m.image",
                body: "encrypted-photo.png",
                url,
                info: { mimetype: "image/png", w: 1, h: 1 },
            });
            // Confirm that the server stored ciphertext, rather than only testing a room marked encrypted.
            await expect
                .poll(() =>
                    app.client.evaluate(
                        async (client, { roomId, eventId }) => {
                            const raw = await client.fetchRoomEvent(roomId, eventId);
                            return raw.type;
                        },
                        { roomId, eventId },
                    ),
                )
                .toBe("m.room.encrypted");
            const input = searchBox(page);
            await input.fill("has:image");
            await input.press("Enter");
            const panel = results(page);
            const result = panel.getByText("encrypted-photo.png", { exact: true }).first();
            await expect(result).toBeVisible();
            await expect(panel.getByText(/skip encrypted rooms|Some filters are applied/)).toHaveCount(0);
            await page.screenshot({ path: `${CAPTURES}/encrypted-images-${theme}.png` });
            await result.click();
            await expect(
                page
                    .getByRole("main")
                    .getByRole("listitem")
                    .filter({ has: page.getByRole("link", { name: "encrypted-photo.png", exact: true }) }),
            ).toHaveClass(/stateSelected/);
            await expect(panel).toBeVisible();
            const jump = panel.getByRole("button", { name: /Jump to message from Alice/ });
            await jump.focus();
            await jump.press("Enter");
            await expect(panel).toBeVisible();
        });

        test("opens the results for FocusMessageSearch with has:file", async ({ page }) => {
            await focusMessageSearch(page, "has:file");
            await expect(page.getByRole("button", { name: "Remove filter has:file" })).toBeVisible();
            await expect(results(page).getByText("quarterly.pdf").first()).toBeVisible();
            await expect(results(page).getByText("budget report is ready")).not.toBeVisible();
            await expect(page.locator(".mx_RoomSummaryCard")).toHaveCount(0);
        });

        test("jumps to a result in its room, highlights it and keeps the results open", async ({ page }) => {
            const input = searchBox(page);
            await input.fill("budget jokes");
            await input.press("Enter");
            const panel = results(page);
            await panel.getByRole("button", { name: /Jump to message from Alice/ }).click();

            await expect(
                page
                    .getByRole("gridcell")
                    .filter({ has: page.getByRole("button", { name: "Open room random", exact: true }) }),
            ).toHaveAttribute("aria-selected", "true");
            const message = page.getByRole("main").getByRole("listitem").filter({ hasText: "budget jokes only" });
            await expect(message).toBeVisible();
            // Navigation marks the target as selected; stateHighlighted is reserved for push-rule mentions.
            await expect(message).toHaveClass(/stateSelected/);
            await expect(panel.getByText("budget jokes only")).toBeVisible();
        });

        test("Escape closes the filters, then the results", async ({ page }) => {
            const input = searchBox(page);
            await page.keyboard.press("ControlOrMeta+f");
            await expect(input).toBeFocused();
            await expect(filters(page)).toBeVisible();
            await page.keyboard.press("Escape");
            await expect(filters(page)).not.toBeVisible();

            await input.fill("budget");
            await input.press("Enter");
            await expect(results(page)).toBeVisible();
            await page.keyboard.press("Escape");
            await expect(results(page)).not.toBeVisible();
            await expect(input).toHaveValue("");
        });

        test("clearing the box closes the results", async ({ page }) => {
            const input = searchBox(page);
            await input.fill("budget");
            await input.press("Enter");
            await expect(results(page)).toBeVisible();
            await page.getByRole("button", { name: "Clear search" }).click();
            await expect(results(page)).not.toBeVisible();
        });
    });
}

test.describe("flag off", () => {
    test.use({ config: { default_theme: "dark" } });

    test("keeps upstream's search in the room summary", async ({ page, app, generalId }) => {
        await rejectToast(page, "Verify this device");
        await rejectToast(page, "Notifications");
        await closeReleaseAnnouncementIfExists(page, "Introducing Sections");
        await app.viewRoomById(generalId);
        await expect(searchBox(page)).toHaveCount(0);
        await focusMessageSearch(page);
        await expect(page.getByPlaceholder("Search messages…")).toBeVisible();
    });
});
