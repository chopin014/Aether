/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { closeReleaseAnnouncementIfExists, rejectToast } from "@element-hq/element-web-playwright-common";

import { test, expect } from "../../element-web-test";

for (const desktopShell of [true, false]) {
    test.describe(`Timeline anchoring with desktop shell ${desktopShell ? "enabled" : "disabled"}`, () => {
        test.use({
            displayName: "Reader",
            botCreateOpts: { displayName: "Writer", bootstrapCrossSigning: false },
            config: { features: { feature_desktop_shell: desktopShell, feature_new_timeline: false } },
        });

        test("keeps the reading position through pagination and remote updates, then follows latest", async ({
            page,
            app,
            user,
            bot,
        }) => {
            test.setTimeout(90_000);
            const roomId = await app.client.createRoom({ name: "Scroll anchoring", invite: [bot.credentials!.userId] });
            await bot.joinRoom(roomId);
            const eventIds = await bot.evaluate(async (client, roomId) => {
                const ids: string[] = [];
                for (let i = 0; i < 90; i++) {
                    const { event_id } = await client.sendTextMessage(
                        roomId,
                        `Scroll message ${i}\nFirst line\nSecond line\nThird line`,
                    );
                    ids.push(event_id);
                }
                return ids;
            }, roomId);
            await app.viewRoomById(roomId);
            await rejectToast(page, "Verify this device");
            await rejectToast(page, "Notifications");
            await closeReleaseAnnouncementIfExists(page, "Introducing Sections");
            await expect(page.getByText("Scroll message 89", { exact: false })).toBeVisible();

            // A real permalink opens an older section, including both pagination directions.
            await page.goto(`/#/room/${roomId}/${eventIds[40]}`);
            let anchor = page.getByTestId("event-tile-slot-body").filter({ hasText: /^Scroll message 40\n/ });
            await expect(anchor).toBeInViewport();
            const list = page.getByRole("list").filter({ has: page.getByTestId("event-tile-slot-body") });
            await expect(list).toHaveCount(1);
            const y = async (): Promise<number> => (await anchor.boundingBox())!.y;
            await page.waitForTimeout(300);

            const box = (await anchor.boundingBox())!;
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await page.mouse.wheel(0, -1400);
            await expect(page.getByText("Scroll message 15", { exact: false })).toBeAttached();
            await page.waitForTimeout(300);
            const readingIndex = await list.getByTestId("event-tile-slot-body").evaluateAll((nodes) => {
                const scroller = nodes[0].closest(".mx_ScrollPanel")!;
                const viewport = scroller.getBoundingClientRect();
                const visible = nodes.find((node) => {
                    const rect = node.getBoundingClientRect();
                    return (
                        /Scroll message \d+/.test(node.textContent ?? "") &&
                        rect.top >= viewport.top + 40 &&
                        rect.bottom <= viewport.bottom - 40
                    );
                });
                return Number(visible!.textContent!.match(/Scroll message (\d+)/)![1]);
            });
            anchor = page
                .getByTestId("event-tile-slot-body")
                .filter({ hasText: new RegExp(`^Scroll message ${readingIndex}\\n`) });
            await expect(anchor).toBeInViewport();
            const readingY = await y();
            await bot.sendMessage(roomId, "A new remote message while reading history");
            const replacement = `Scroll message ${readingIndex + 1}\n${"Expanded remote edit\n".repeat(30)}`;
            await bot.sendEvent(roomId, null, "m.room.message", {
                "msgtype": "m.text",
                "body": `* ${replacement}`,
                "m.new_content": { msgtype: "m.text", body: replacement },
                "m.relates_to": { rel_type: "m.replace", event_id: eventIds[readingIndex + 1] },
            });
            await expect(page.getByText(/Expanded remote edit/).first()).toBeAttached();
            // Let native scroll delivery, ResizeObserver and the idle height adjustment all finish.
            await page.waitForTimeout(500);
            expect(Math.abs((await y()) - readingY)).toBeLessThanOrEqual(2);

            // Returning to the live end should retain the normal follow-new-messages behaviour.
            await page.getByRole("button", { name: "Scroll to most recent messages", exact: true }).click();
            await expect(page.getByText("A new remote message while reading history", { exact: true })).toBeVisible();
            await bot.sendMessage(roomId, "A new remote message at the live end");
            await expect(page.getByText("A new remote message at the live end", { exact: true })).toBeVisible();
            await page.waitForTimeout(200);
            expect(
                await list.evaluate((node) => {
                    const scroller = node.closest(".mx_ScrollPanel")!;
                    return scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
                }),
            ).toBeLessThanOrEqual(1);
        });
    });
}
