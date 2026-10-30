/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { closeReleaseAnnouncementIfExists, rejectToastIfExists } from "@element-hq/element-web-playwright-common";

import { test, expect } from "../../element-web-test";

test.use({
    displayName: "Alice",
    botCreateOpts: { displayName: "Robin" },
    config: {
        default_theme: "dark",
        features: { feature_desktop_shell: true, feature_video_rooms: true, feature_element_call_video_rooms: true },
        element_call: { use_exclusively: true },
    },
});

for (const populated of [false, true]) {
    test(`deletes ${populated ? "all channels and nested servers" : "an empty server"} from server settings`, async ({
        page,
        app,
        user,
        bot,
    }) => {
        await rejectToastIfExists(page, "Verify this device");
        await rejectToastIfExists(page, "Notifications");
        await closeReleaseAnnouncementIfExists(page, "Introducing Sections");
        const roomIds: string[] = [];
        const via = [user.homeServer];
        const children = (ids: string[]) =>
            ids.map((id) => ({ type: "m.space.child", state_key: id, content: { via } }));
        if (populated) {
            const text = await app.client.createRoom({ name: "general" });
            const voice = await app.client.createRoom({
                name: "Lounge",
                creation_content: { type: "org.matrix.msc3417.call" },
            });
            const nested = await app.client.createSpace({ name: "Projects", initial_state: children([voice]) });
            roomIds.push(text, voice, nested);
        }
        const spaceId = await app.client.createSpace({
            name: "Delete this server",
            initial_state: children(populated ? [roomIds[0], roomIds[2]] : []),
        });
        const all = [...roomIds, spaceId];
        for (const id of all) {
            await app.client.inviteUser(id, bot.credentials!.userId);
            await bot.joinRoom(id);
        }
        await app.viewSpaceByName("Delete this server");
        await page.getByRole("button", { name: "Open server menu", exact: true }).click();
        await page.getByRole("menuitem", { name: "Server settings", exact: true }).click();
        const settings = page.getByRole("dialog", { name: "Settings - Delete this server", exact: true });
        await settings.getByRole("button", { name: "Delete server", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Delete server?", exact: true });
        const input = dialog.getByRole("textbox", { name: "Type Delete this server to confirm", exact: true });
        await expect(input).toBeVisible();
        await expect(dialog.getByRole("button", { name: "Delete server", exact: true })).toBeDisabled();
        if (populated) {
            const list = dialog.getByRole("list", { name: "Channels and nested servers to delete" });
            for (const name of ["general", "Lounge", "Projects"])
                await expect(list.getByText(name, { exact: true })).toBeVisible();
        }
        await page.mouse.click(5, 5);
        await expect(dialog).toBeVisible();
        await page.screenshot({ path: `/tmp/aether-delete-server-${populated ? "populated" : "empty"}.png` });
        await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
        expect((await app.client.evaluate((client) => client.getJoinedRooms())).joined_rooms).toEqual(
            expect.arrayContaining(all),
        );
        await settings.getByRole("button", { name: "Delete server", exact: true }).click();
        await input.fill("Delete this server");
        if (populated) {
            await page.route(
                "**/_matrix/client/v3/rooms/*/kick",
                (route) =>
                    route.fulfill({
                        status: 403,
                        contentType: "application/json",
                        body: JSON.stringify({ errcode: "M_FORBIDDEN", error: "Test failure" }),
                    }),
                { times: 1 },
            );
        }
        await dialog.getByRole("button", { name: "Delete server", exact: true }).click();
        if (populated) {
            await expect(dialog.getByRole("alert")).toContainText("Deletion stopped");
            expect((await app.client.evaluate((client) => client.getJoinedRooms())).joined_rooms).toEqual(
                expect.arrayContaining(all),
            );
            await dialog.getByRole("button", { name: "Retry", exact: true }).click();
        }
        await expect(dialog).not.toBeVisible({ timeout: 30_000 });
        await expect(settings).not.toBeVisible();
        await expect(
            page
                .getByRole("navigation", { name: "Servers" })
                .getByRole("button", { name: "Delete this server", exact: true }),
        ).toHaveCount(0);
        const joined = (await app.client.evaluate((client) => client.getJoinedRooms())).joined_rooms;
        for (const id of all) {
            expect(joined).not.toContain(id);
            await expect
                .poll(() => bot.evaluate((client, roomId) => client.getRoom(roomId)?.getMyMembership(), id))
                .toBe("leave");
            expect(await app.client.evaluate((client, roomId) => !!client.getRoom(roomId), id)).toBe(false);
        }
    });
}
