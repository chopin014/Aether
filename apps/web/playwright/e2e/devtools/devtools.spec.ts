/*
Copyright 2025 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { test, expect } from "../../element-web-test";
import { SettingLevel } from "../../../src/settings/SettingLevel";

test.describe("Devtools", () => {
    test.use({
        displayName: "Alice",
    });

    test("should render the devtools", { tag: "@screenshot" }, async ({ page, homeserver, user, app, axe }) => {
        // /devtools is only offered once developer mode is on.
        await app.settings.setValue("developerMode", null, SettingLevel.ACCOUNT, true);
        await app.client.createRoom({ name: "Test Room" });
        await app.viewRoomByName("Test Room");

        const composer = app.getComposer().locator("[contenteditable]");
        await composer.fill("/devtools");
        await composer.press("Enter");
        const dialog = page.locator(".mx_Dialog");
        await dialog.getByLabel("Developer mode").check();

        axe.disableRules("color-contrast"); // XXX: Inheriting colour contrast issues from room view.
        await expect(axe).toHaveNoViolations();
        await expect(dialog).toMatchScreenshot("devtools-dialog.png", {
            css: `.mx_CopyableText {
                display: none;
            }`,
        });

        // Try entering a value for the Developer.elementCallUrl setting
        const input = page.getByRole("textbox", { name: "Element Call URL" });
        await input.fill("https://example.com");
        await input.press("Enter");
        // expect EW NOT to reload
        await expect(page.getByText("Saved")).toBeVisible();
    });

    test("explores all of a room's state", async ({ page, user: _user, app }) => {
        await app.settings.setValue("developerMode", null, SettingLevel.ACCOUNT, true);
        const roomId = await app.client.createRoom({ name: "Test Room" });
        // State the app itself never reads, which sliding sync does not load.
        await app.client.sendStateEvent(roomId, "org.example.board", { pinned: true }, "first");
        await app.viewRoomByName("Test Room");

        const composer = app.getComposer().locator("[contenteditable]");
        await composer.fill("/devtools");
        await composer.press("Enter");
        const dialog = page.getByRole("dialog");
        await dialog.getByRole("button", { name: "Explore room state" }).click();
        await dialog.getByRole("button", { name: "org.example.board" }).click();
        await dialog.getByRole("button", { name: "first" }).click();

        await expect(dialog.getByText(/"pinned": true/)).toBeVisible();
    });
});
