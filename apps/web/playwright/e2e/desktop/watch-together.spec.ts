/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type BrowserContext, type Page } from "@playwright/test";
import {
    closeReleaseAnnouncementIfExists,
    rejectToastIfExists,
    populateLocalStorageWithCredentials,
    routeConfigJson,
} from "@element-hq/element-web-playwright-common";

import { test, expect } from "../../element-web-test";
import { ElementAppPage } from "../../pages/ElementAppPage";
import { getSampleFilePath } from "../../sample-files";

/**
 * Watch together in a real encrypted voice channel: two users, the real Element Call engine under Aether's call
 * stage, and a real MatrixRTC backend. The shared player's state travels over the call's encrypted data channel,
 * which a stand-in call cannot show.
 *
 * The shared item is a media file at a made-up address that both browsers are routed to a local sample, so the
 * test does not depend on YouTube.
 */
test.use({
    matrixRTC: true,
    lockLeftPanelWidth: false,
    displayName: "Alice",
    permissions: ["microphone", "camera"],
    config: {
        default_theme: "dark",
        features: {
            feature_desktop_shell: true,
            feature_video_rooms: true,
            feature_element_call_video_rooms: true,
            feature_element_call_react: true,
        },
        element_call: { disable: false, use_exclusively: true },
    },
});

test.skip(({ homeserverType }) => homeserverType !== "synapse", "Needs Synapse's matrix_rtc configuration");

const CLIP_URL = "https://media.example.org/clips/Sunset%20loop.webm";

async function serveClip(context: BrowserContext): Promise<void> {
    await context.route(CLIP_URL, (route) =>
        route.fulfill({ path: getSampleFilePath("30secvid.webm"), contentType: "video/webm" }),
    );
}

async function settle(page: Page): Promise<void> {
    for (const message of ["Verify this device", "Notifications"]) await rejectToastIfExists(page, message);
    await closeReleaseAnnouncementIfExists(page, "Introducing Sections");
}

/** Where the shared video is on a page, in seconds. */
const videoTime = (page: Page): Promise<number> =>
    page
        .getByTestId("watch-together-player")
        .locator("video")
        .evaluate((video: HTMLVideoElement) => video.currentTime);
const videoPaused = (page: Page): Promise<boolean> =>
    page
        .getByTestId("watch-together-player")
        .locator("video")
        .evaluate((video: HTMLVideoElement) => video.paused);

test("two people in a voice channel watch a video together and control it", async ({
    page,
    app,
    user,
    browser,
    homeserver,
    config,
    context,
}, testInfo) => {
    test.setTimeout(180_000);
    await settle(page);
    await serveClip(context);
    // The homeserver is shared across repeats, so each run needs its own Bob.
    const bob = await homeserver.registerUser(`bob-watch-together-${testInfo.repeatEachIndex}`, "password", "Bob");
    const bobContext = await browser.newContext({
        baseURL: new URL(page.url()).origin,
        permissions: ["microphone", "camera"],
    });
    try {
        await serveClip(bobContext);
        const bobPage = await bobContext.newPage();
        await routeConfigJson(bobContext, homeserver.baseUrl, config);
        await populateLocalStorageWithCredentials(bobPage, bob);
        await bobPage.goto("/");
        await bobPage.waitForSelector(".mx_MatrixChat");
        await settle(bobPage);
        const bobApp = new ElementAppPage(bobPage);

        const roomId = await app.client.createRoom({
            name: "Cinema",
            creation_content: { type: "org.matrix.msc3417.call" },
            power_level_content_override: { events: { "org.matrix.msc3401.call.member": 0 } },
            initial_state: [
                { type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } },
            ],
            invite: [bob.userId],
        });
        const spaceId = await app.client.createSpace({
            name: "Movie night",
            initial_state: [{ type: "m.space.child", state_key: roomId, content: { via: [user.homeServer] } }],
            invite: [bob.userId],
        });
        await homeserver.csApi.request("POST", `/v3/join/${roomId}`, bob.accessToken, {});
        await homeserver.csApi.request("POST", `/v3/join/${spaceId}`, bob.accessToken, {});
        for (const id of [spaceId, roomId]) {
            await expect
                .poll(() => bobApp.client.evaluate((client, room) => client.getRoom(room)?.getMyMembership(), id), {
                    timeout: 15_000,
                })
                .toBe("join");
        }

        // Both open the voice channel, which joins its call.
        await app.viewSpaceByName("Movie night");
        await bobApp.viewSpaceByName("Movie night");
        await page.getByRole("button", { name: "Open room Cinema", exact: true }).click();
        await bobPage.getByRole("button", { name: "Open room Cinema", exact: true }).click();
        for (const memberPage of [page, bobPage]) {
            await expect(memberPage.getByTestId("videoTile")).toHaveCount(2, { timeout: 60_000 });
        }

        // Alice shares a link from the call controls; it starts for both of them.
        await page.getByTestId("call-control-watch-together").click();
        await page.getByLabel("Watch or listen together").fill(CLIP_URL);
        await page.getByRole("button", { name: "Play for everyone" }).click();
        for (const memberPage of [page, bobPage]) {
            await expect(memberPage.getByTestId("call-tile-watch-together")).toBeVisible({ timeout: 15_000 });
            await expect(memberPage.getByRole("region", { name: "Shared player: Sunset loop" })).toBeVisible();
            await expect.poll(() => videoTime(memberPage), { timeout: 15_000 }).toBeGreaterThan(0.5);
        }
        await expect(bobPage.getByText("Alice started Sunset loop")).toBeVisible();
        // Each plays on its own device, close enough that nobody notices.
        const [alicePlaying, bobPlaying] = await Promise.all([videoTime(page), videoTime(bobPage)]);
        expect(Math.abs(alicePlaying - bobPlaying)).toBeLessThan(1);

        // Bob pauses for everyone; Alice is told who did it, and both stop at the same moment.
        await bobPage.getByTestId("watch-together-player").hover();
        await bobPage.getByTestId("watch-together-toggle").click();
        await expect(page.getByText("Bob paused")).toBeVisible({ timeout: 10_000 });
        for (const memberPage of [page, bobPage]) {
            await expect.poll(() => videoPaused(memberPage), { timeout: 10_000 }).toBe(true);
        }
        await expect
            .poll(async () => Math.abs((await videoTime(page)) - (await videoTime(bobPage))), { timeout: 5_000 })
            .toBeLessThan(0.5);

        // Bob ends the activity; the player goes away for Alice too.
        await bobPage.getByTestId("watch-together-player").hover();
        await bobPage.getByRole("button", { name: "End for everyone" }).click();
        await expect(page.getByTestId("watch-together-player")).toHaveCount(0, { timeout: 10_000 });
    } finally {
        await bobContext.close();
    }
});
