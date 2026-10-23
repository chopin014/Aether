/*
Copyright 2024 New Vector Ltd.
Copyright 2023 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { test, expect } from "../../element-web-test";

test.describe("Presence tests", () => {
    test.use({
        displayName: "Janet",
        botCreateOpts: { displayName: "Bob" },
    });

    test("changes presence from the account profile and retains invisible intent across reload", async ({
        page,
        app,
        user,
    }) => {
        await expect(page.getByRole("button", { name: "User menu", exact: true })).toBeVisible();
        await app.client.createRoom({ name: `Presence controls for ${user.displayName}` });
        await page.getByRole("button", { name: "User menu", exact: true }).click();
        await page.getByRole("menuitem", { name: "Requested: Online (automatic)" }).click();
        const request = page.waitForResponse((response) => {
            const request = response.request();
            return (
                request.method() === "PUT" &&
                request.url().includes("/presence/") &&
                request.postDataJSON().presence === "offline"
            );
        });
        await page.getByRole("menuitemradio", { name: "Appear offline" }).click();
        expect((await request).ok()).toBe(true);
        await expect(page.getByRole("menuitemradio", { name: "Appear offline" })).toHaveAttribute(
            "aria-checked",
            "true",
        );
        await page.keyboard.press("Escape");
        await page.keyboard.press("Escape");
        await page.getByRole("button", { name: "User menu", exact: true }).click();
        await expect(page.getByRole("menuitem", { name: "Requested: Appear offline" })).toBeVisible();
        await page.reload();
        await page.getByRole("button", { name: "User menu", exact: true }).click();
        await page.getByRole("menuitem", { name: "Requested: Appear offline" }).click();
        await page.getByRole("menuitemradio", { name: "Away" }).click();
        await expect(page.getByRole("menuitemradio", { name: "Away" })).toHaveAttribute("aria-checked", "true");
    });

    test.describe("bob unreachable", () => {
        // This is failing on CI (https://github.com/element-hq/element-web/issues/27270)
        // but not locally, so debugging this is going to be tricky. Let's disable it for now.
        test.skip("renders unreachable presence state correctly", async ({ page, app, user, bot: bob }) => {
            await app.client.createRoom({ name: "My Room", invite: [bob.credentials!.userId] });
            await app.viewRoomByName("My Room");

            await bob.evaluate(async (client) => {
                client.stopClient();
            });

            await page.route(
                `**/sync*`,
                async (route) => {
                    const response = await route.fetch();
                    await route.fulfill({
                        json: {
                            ...(await response.json()),
                            presence: {
                                events: [
                                    {
                                        type: "m.presence",
                                        sender: bob.credentials!.userId,
                                        content: {
                                            presence: "io.element.unreachable",
                                            currently_active: false,
                                        },
                                    },
                                ],
                            },
                        },
                    });
                },
                { times: 1 },
            );
            await app.client.createRoom({}); // trigger sync

            await app.toggleRoomInfoPanel();
            await page.locator(".mx_RightPanel").getByText("People").click();
            await expect(page.locator(".mx_EntityTile_unreachable")).toContainText("Bob");
            await expect(page.locator(".mx_EntityTile_unreachable")).toContainText("User's server unreachable");
        });
    });
});
