/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { closeReleaseAnnouncementIfExists, rejectToast } from "@element-hq/element-web-playwright-common";

import { test, expect } from "../../element-web-test";
import { isDendrite } from "../../plugins/homeserver/dendrite";

test.use({
    displayName: "Alice",
    lockLeftPanelWidth: false,
    config: { default_theme: "dark", features: { feature_desktop_shell: true } },
    botCreateOpts: { displayName: "Bob", autoAcceptInvites: true },
});

test.describe("Desktop threads", () => {
    test.setTimeout(120_000);
    test.skip(isDendrite, "Dendrite does not yet implement the thread list reliably");
    test.beforeEach(async ({ page, user }) => {
        await rejectToast(page, "Verify this device");
        await rejectToast(page, "Notifications");
        await closeReleaseAnnouncementIfExists(page, "Introducing Sections");
    });

    for (const encrypted of [false, true]) {
        test(`discovers, creates and reopens ${encrypted ? "encrypted" : "plaintext"} Matrix threads`, async ({
            page,
            app,
            bot,
        }, testInfo) => {
            const roomId = await app.client.createRoom({
                name: "Thread workshop",
                invite: [bot.credentials!.userId],
                initial_state: encrypted
                    ? [
                          {
                              type: "m.room.encryption",
                              state_key: "",
                              content: { algorithm: "m.megolm.v1.aes-sha2" },
                          },
                      ]
                    : [],
            });
            await bot.joinRoom(roomId);
            await bot.awaitRoomMembership(roomId);
            await app.viewRoomById(roomId);
            const trigger = page.getByRole("button", { name: "Threads", exact: true });
            const panel = page.getByTestId("right-panel");
            await expect(panel.getByRole("listbox", { name: "Member list", exact: true })).toBeVisible();
            await trigger.click();
            const browser = page.getByRole("dialog", { name: "Threads", exact: true });
            // Like the pins popover, the browser is right-aligned to its button and sits just below it.
            const expectAnchoredToTrigger = async (): Promise<void> => {
                await expect
                    .poll(async () => {
                        const button = (await trigger.boundingBox())!;
                        const dialog = (await browser.boundingBox())!;
                        return {
                            right: Math.abs(dialog.x + dialog.width - (button.x + button.width)) <= 1,
                            below: dialog.y >= button.y + button.height,
                        };
                    })
                    .toEqual({ right: true, below: true });
            };
            await expect(browser.getByRole("heading", { name: "There are no threads." })).toBeVisible();
            await expect(panel.getByRole("listbox", { name: "Member list", exact: true })).toBeVisible();
            await expect(browser.getByRole("searchbox", { name: "Search threads" })).toBeFocused();
            await expectAnchoredToTrigger();
            await browser.screenshot({ path: testInfo.outputPath("empty-browser.png") });
            await page.screenshot({ path: testInfo.outputPath("anchored-browser.png") });
            await page.keyboard.press("Escape");
            await expect(browser).not.toBeVisible();
            await expect(trigger).toBeFocused();

            const root = await app.client.sendMessage(roomId, "Release planning");
            await bot.sendMessage(roomId, "Ready for review", root.event_id);
            await trigger.click();
            const search = browser.getByRole("searchbox", { name: "Search threads" });
            await search.fill("no matching conversation");
            await expect(browser.getByRole("heading", { name: "No matching threads" })).toBeVisible();
            await search.fill("Release planning");
            await browser.getByRole("button", { name: /Release planning/ }).click();
            await expect(browser).not.toBeVisible();
            await expect(panel.getByRole("heading", { name: "Release planning", exact: true })).toBeVisible();
            await expect(panel.getByText("Ready for review", { exact: true })).toBeVisible();
            await expect.poll(async () => (await panel.boundingBox())?.width).toBe(420);
            const threadComposer = panel.getByRole("textbox").last();
            await threadComposer.fill("Thread reply from Alice");
            await threadComposer.press("Enter");
            await expect(panel.getByText("Thread reply from Alice", { exact: true })).toBeVisible();
            await bot.sendMessage(roomId, "Reply received by Bob", root.event_id);
            await expect
                .poll(() =>
                    app.client.evaluate(
                        (client, { id, rootId }) =>
                            client
                                .getRoom(id)
                                ?.getThread(rootId)
                                ?.events.some((event) => event.getContent().body === "Reply received by Bob"),
                        { id: roomId, rootId: root.event_id },
                    ),
                )
                .toBe(true);
            await expect(panel.getByText("Reply received by Bob", { exact: true })).toBeVisible();
            await expect
                .poll(() =>
                    app.client.evaluate(
                        (client, { roomId, rootId }) =>
                            client
                                .getRoom(roomId)
                                ?.getThread(rootId)
                                ?.events.some(
                                    (event) =>
                                        event.getContent().body === "Thread reply from Alice" &&
                                        event.getRelation()?.rel_type === "m.thread" &&
                                        event.getRelation()?.event_id === rootId,
                                ),
                        { roomId, rootId: root.event_id },
                    ),
                )
                .toBe(true);

            await threadComposer.fill("A draft for this thread");
            await panel.getByRole("button", { name: "Close thread" }).click();
            await expect(panel.getByRole("listbox", { name: "Member list", exact: true })).toBeVisible();
            await expect(trigger).toBeFocused();
            await trigger.click();
            await browser.getByRole("button", { name: /Release planning/ }).click();
            await expect(threadComposer).toHaveText("A draft for this thread");
            await panel.screenshot({ path: testInfo.outputPath("thread-conversation.png") });
            await panel.getByRole("button", { name: "Close thread" }).click();

            await trigger.click();
            await browser.getByRole("button", { name: "Create", exact: true }).click();
            await browser.getByLabel("Starter message").fill("Design review");
            await browser.getByLabel("First reply").fill("First review comment");
            await browser.getByRole("button", { name: "Cancel" }).click();
            expect(
                await app.client.evaluate(
                    (client, id) =>
                        client
                            .getRoom(id)!
                            .getLiveTimeline()
                            .getEvents()
                            .some((event) => event.getContent().body === "Design review"),
                    roomId,
                ),
            ).toBe(false);
            await browser.getByRole("button", { name: "Create", exact: true }).click();
            await expect(browser.getByLabel("Starter message")).toHaveValue("Design review");
            await browser.getByRole("button", { name: "Create thread", exact: true }).click();
            await expect(panel.getByRole("heading", { name: "Design review", exact: true })).toBeVisible();
            await expect(panel.getByText("First review comment", { exact: true })).toHaveCount(1);
            const designRoot = await app.client.evaluate(
                (client, id) =>
                    client
                        .getRoom(id)!
                        .getLiveTimeline()
                        .getEvents()
                        .filter((event) => event.getContent().body === "Design review")
                        .map((event) => event.getId()),
                roomId,
            );
            expect(designRoot).toHaveLength(1);
            await expect
                .poll(() =>
                    app.client.evaluate(
                        (client, { id, rootId }) =>
                            client
                                .getRoom(id)
                                ?.getThread(rootId)
                                ?.events.some(
                                    (event) =>
                                        event.getContent().body === "First review comment" &&
                                        event.getRelation()?.rel_type === "m.thread",
                                ),
                        { id: roomId, rootId: designRoot[0]! },
                    ),
                )
                .toBe(true);
            await expect(threadComposer).toBeEmpty();
            await panel.getByRole("button", { name: "Close thread" }).click();

            const messageRoot = await app.client.sendMessage(roomId, "A message to discuss");
            await page.getByText("A message to discuss", { exact: true }).hover();
            await page.getByRole("button", { name: "Start thread", exact: true }).click();
            await expect(panel.getByRole("heading", { name: "A message to discuss", exact: true })).toBeVisible();
            await expect(threadComposer).toBeFocused();
            await threadComposer.fill("First reply on the existing message");
            await threadComposer.press("Enter");
            await expect(panel.getByText("First reply on the existing message", { exact: true })).toBeVisible();
            expect(
                await app.client.evaluate(
                    (client, { id, rootId }) =>
                        client
                            .getRoom(id)
                            ?.getLiveTimeline()
                            .getEvents()
                            .filter((event) => event.getId() === rootId).length,
                    { id: roomId, rootId: messageRoot.event_id },
                ),
            ).toBe(1);
            await panel.getByRole("button", { name: "Close thread" }).click();
            await page.getByTestId("thread-summary").filter({ hasText: "First reply on the existing message" }).click();
            await expect(panel.getByRole("heading", { name: "A message to discuss", exact: true })).toBeVisible();
            await expect(panel.getByText("First reply on the existing message", { exact: true })).toBeVisible();
            await page.setViewportSize({ width: 720, height: 720 });
            const close = panel.getByRole("button", { name: "Close thread" });
            await expect(close).toBeInViewport();
            await expect(threadComposer).toBeInViewport();
            const narrowReply = panel.getByText("First reply on the existing message", { exact: true });
            await expect(narrowReply).toBeInViewport();
            // The overlay must paint above the channel's raised status area, not only be laid out inside the viewport.
            expect(
                await narrowReply.evaluate((element) => {
                    const rect = element.getBoundingClientRect();
                    return element.contains(
                        document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2),
                    );
                }),
            ).toBe(true);
            await panel.screenshot({ path: testInfo.outputPath("narrow-conversation.png") });
            await close.click();
            // On narrow windows the button can sit left of where a full-width panel would fit, so the panel is
            // clamped to the viewport instead of aligning to the button.
            await trigger.click();
            await expect(browser).toBeInViewport({ ratio: 1 });
            const narrow = (await browser.boundingBox())!;
            expect(narrow.x).toBeGreaterThanOrEqual(8);
            expect(narrow.x + narrow.width).toBeLessThanOrEqual(720 - 8);
            expect(narrow.y).toBeGreaterThanOrEqual((await trigger.boundingBox())!.y);
            await page.screenshot({ path: testInfo.outputPath("narrow-browser.png") });
            await page.keyboard.press("Escape");
            await page.setViewportSize({ width: 1280, height: 720 });
            await trigger.click();
            await browser.getByRole("button", { name: /Release planning/ }).click();
            await expect(threadComposer).toHaveText("A draft for this thread");
            expect(await app.getCurrentRoomIdFromUrl()).toBe(roomId);
            if (encrypted) {
                const event = await app.client.evaluate(
                    (client, { id, eventId }) => client.fetchRoomEvent(id, eventId),
                    { id: roomId, eventId: designRoot[0]! },
                );
                expect(event.type).toBe("m.room.encrypted");
            }
        });
    }
});
