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

for (const kind of ["text", "voice"] as const) {
    test(`deletes a ${kind} channel after confirmation, removing members before leaving`, async ({
        page,
        app,
        bot,
        user,
    }) => {
        await rejectToastIfExists(page, "Verify this device");
        await rejectToastIfExists(page, "Notifications");
        await closeReleaseAnnouncementIfExists(page, "Introducing Sections");
        const name = kind === "voice" ? "Lounge" : "discussion";
        const roomId = await app.client.createRoom({
            name,
            creation_content: kind === "voice" ? { type: "org.matrix.msc3417.call" } : undefined,
        });
        await app.client.inviteUser(roomId, bot.credentials!.userId);
        await bot.joinRoom(roomId);
        const general = await app.client.createRoom({ name: "general" });
        const spaceId = await app.client.createSpace({
            name: "Channel deletion",
            initial_state: [roomId, general].map((id) => ({
                type: "m.space.child",
                state_key: id,
                content: { via: [user.homeServer] },
            })),
        });
        await app.viewSpaceByName("Channel deletion");
        const channel = page
            .getByRole("navigation", { name: "Room list" })
            .getByRole("button", { name: `Open room ${name}`, exact: true });
        await channel.click({ button: "right" });
        await page.getByRole("menuitem", { name: "Delete channel", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Delete channel?", exact: true });
        await expect(dialog.getByText(/Previously received messages may remain/)).toBeVisible();
        await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
        await page.screenshot({ path: `/tmp/aether-delete-channel-${kind}.png` });

        await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
        await expect(dialog).not.toBeVisible();
        await expect(channel).toBeVisible();
        expect(await bot.evaluate((client, id) => client.getRoom(id)?.getMyMembership(), roomId)).toBe("join");

        await channel.click({ button: "right" });
        await page.getByRole("menuitem", { name: "Delete channel", exact: true }).click();
        if (kind === "voice") {
            // A transient failure must keep the admin joined and offer a way to finish the same operation.
            await page.route(
                "**/_matrix/client/v3/rooms/*/kick",
                (route) =>
                    route.fulfill({
                        status: 403,
                        contentType: "application/json",
                        body: JSON.stringify({ errcode: "M_FORBIDDEN", error: "Temporary test failure" }),
                    }),
                { times: 1 },
            );
        }
        await dialog.getByRole("button", { name: "Delete channel", exact: true }).click();
        if (kind === "voice") {
            await expect(dialog.getByRole("alert")).toContainText("Deletion stopped");
            expect(await app.client.evaluate((client, id) => client.getRoom(id)?.getMyMembership(), roomId)).toBe(
                "join",
            );
            await dialog.getByRole("button", { name: "Retry", exact: true }).click();
        }
        await expect(dialog).not.toBeVisible({ timeout: 20_000 });
        await expect(channel).not.toBeVisible();
        await expect
            .poll(() => bot.evaluate((client, id) => client.getRoom(id)?.getMyMembership(), roomId))
            .toBe("leave");
        const { joined_rooms: joined } = await app.client.evaluate((client) => client.getJoinedRooms());
        expect(joined).not.toContain(roomId);
        expect(await app.client.evaluate((client, id) => !!client.getRoom(id), roomId)).toBe(false);
        const link = await app.client.evaluate(
            (client, { spaceId, roomId }) => client.getStateEvent(spaceId, "m.space.child", roomId),
            { spaceId, roomId },
        );
        expect(link).toEqual({});
        await expect(page.getByTestId("aether-call-stage")).toHaveCount(0);
    });
}
