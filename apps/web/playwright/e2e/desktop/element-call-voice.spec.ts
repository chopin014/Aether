/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type Page, type Request } from "@playwright/test";
import {
    closeReleaseAnnouncementIfExists,
    populateLocalStorageWithCredentials,
    rejectToast,
    routeConfigJson,
} from "@element-hq/element-web-playwright-common";

import { test, expect } from "../../element-web-test";

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
test.skip(({ homeserverType }) => homeserverType !== "synapse", "Needs a real MatrixRTC transport");

async function settle(page: Page): Promise<void> {
    await rejectToast(page, "Verify this device");
    await rejectToast(page, "Notifications");
    await closeReleaseAnnouncementIfExists(page, "Introducing Sections");
}

/** Observe actual inbound audio rather than treating a participant tile as proof of media. */
async function observePeers(page: Page): Promise<void> {
    const instrument = (): void => {
        if ("__desktopVoicePeers" in window) return;
        const peers: RTCPeerConnection[] = [];
        Object.defineProperty(window, "__desktopVoicePeers", { value: peers });
        const Original = window.RTCPeerConnection;
        window.RTCPeerConnection = class extends Original {
            public constructor(configuration?: RTCConfiguration) {
                super(configuration);
                peers.push(this);
            }
        };
    };
    await page.addInitScript(instrument);
    await page.evaluate(instrument);
}

async function receivedAudioBytes(page: Page): Promise<number> {
    return page.evaluate(async () => {
        const peers = (window as Window & { __desktopVoicePeers?: RTCPeerConnection[] }).__desktopVoicePeers ?? [];
        let bytes = 0;
        for (const peer of peers) {
            const stats = await peer.getStats();
            stats.forEach((entry) => {
                if (entry.type === "inbound-rtp" && entry.kind === "audio") bytes += entry.bytesReceived ?? 0;
            });
        }
        return bytes;
    });
}

test(
    "two members use a persistent Element Call voice room without Jitsi",
    { tag: ["@no-firefox", "@no-webkit"] },
    async ({ page, app, user, browser, homeserver, config }, testInfo) => {
        test.setTimeout(180_000);
        const jitsiRequests: string[] = [];
        const checkRequest = (url: string): void => {
            if (/jitsi|meet\.element\.io/.test(url)) jitsiRequests.push(url);
        };
        const onRequest = (request: Request): void => checkRequest(request.url());
        page.on("request", onRequest);
        await settle(page);
        await observePeers(page);
        const bob = await homeserver.registerUser("bob-desktop-voice", "password", "Bob");
        const bobContext = await browser.newContext({
            baseURL: new URL(page.url()).origin,
            permissions: ["microphone", "camera"],
        });
        bobContext.on("request", onRequest);
        try {
            const bobPage = await bobContext.newPage();
            await routeConfigJson(bobContext, homeserver.baseUrl, config);
            await populateLocalStorageWithCredentials(bobPage, bob);
            await bobPage.goto("/");
            await bobPage.waitForSelector(".mx_MatrixChat");
            await settle(bobPage);
            await observePeers(bobPage);

            const spaceId = await app.client.createRoom({
                name: "Voice studio",
                creation_content: { type: "m.space" },
            });
            const textId = await app.client.createRoom({ name: "chat" });
            await app.client.evaluate(
                async (client, { spaceId, textId }) => {
                    await client.sendStateEvent(
                        spaceId,
                        "m.space.child" as import("matrix-js-sdk/src/matrix").EventType.SpaceChild,
                        { via: [client.getDomain()!] },
                        textId,
                    );
                    await client.sendStateEvent(
                        textId,
                        "m.space.parent" as import("matrix-js-sdk/src/matrix").EventType.SpaceParent,
                        { via: [client.getDomain()!], canonical: true },
                        spaceId,
                    );
                },
                { spaceId, textId },
            );
            await app.viewSpaceByName("Voice studio");
            await page.getByRole("button", { name: "Open space menu", exact: true }).click();
            await page.getByRole("menuitem", { name: "New voice room" }).click();
            await page.getByRole("textbox", { name: "Name", exact: true }).fill("Lounge");
            await page.getByRole("button", { name: "Create voice room", exact: true }).click();
            await expect(page.getByTestId("videoTile")).toHaveCount(1, { timeout: 60_000 });
            const roomId = await app.getCurrentRoomIdFromUrl();
            expect(await app.client.evaluate((client, id) => client.getRoom(id)!.getType(), roomId)).toBe(
                "org.matrix.msc3417.call",
            );
            await app.client.evaluate((client, { roomId, userId }) => client.invite(roomId, userId), {
                roomId,
                userId: bob.userId,
            });
            await homeserver.csApi.request("POST", `/v3/join/${roomId}`, bob.accessToken, {});
            await bobPage.goto(`/#/room/${roomId}`);
            for (const memberPage of [page, bobPage]) {
                await expect(memberPage.getByTestId("videoTile")).toHaveCount(2, { timeout: 30_000 });
                await expect(memberPage.locator("video").filter({ visible: true })).toHaveCount(0);
                await expect.poll(() => receivedAudioBytes(memberPage), { timeout: 30_000 }).toBeGreaterThan(0);
            }
            const participants = page.getByRole("group", { name: "People in Lounge" });
            await expect(participants.getByRole("button", { name: "Alice", exact: true })).toBeVisible();
            await expect(participants.getByRole("button", { name: "Bob", exact: true })).toBeVisible();
            expect(jitsiRequests).toEqual([]);
            const dock = page.getByRole("group", { name: "User menu" });
            await expect(dock.getByText("Voice Connected", { exact: true })).toBeVisible();
            await dock.getByRole("button", { name: "Mute", exact: true }).click();
            await expect(dock.getByRole("button", { name: "Unmute", exact: true })).toHaveAttribute(
                "aria-pressed",
                "true",
            );
            await dock.getByRole("button", { name: "Unmute", exact: true }).click();
            await dock.getByRole("button", { name: "Deafen", exact: true }).click();
            await expect(dock.getByRole("button", { name: "Undeafen", exact: true })).toHaveAttribute(
                "aria-pressed",
                "true",
            );
            await expect(dock.getByRole("button", { name: "Unmute", exact: true })).toBeVisible();
            await dock.getByRole("button", { name: "Undeafen", exact: true }).click();
            await expect(dock.getByRole("button", { name: "Mute", exact: true })).toBeVisible();
            await page.getByRole("button", { name: "Open room chat", exact: true }).click();
            await expect(page.getByRole("heading", { name: "chat", exact: true })).toBeVisible();
            await expect(dock.getByText("Voice Connected", { exact: true })).toBeVisible();
            const bytesBeforeNavigation = await receivedAudioBytes(page);
            await expect.poll(() => receivedAudioBytes(page)).toBeGreaterThan(bytesBeforeNavigation);
            await dock.getByRole("button", { name: /Voice Connected/ }).click();
            await expect(page.getByTestId("videoTile")).toHaveCount(2);
            await expect
                .poll(async () => {
                    const tiles = await page.getByTestId("videoTile").all();
                    const widths = await Promise.all(tiles.map(async (tile) => (await tile.boundingBox())?.width ?? 0));
                    return Math.max(...widths);
                })
                .toBeGreaterThan(300);
            await page.screenshot({ path: testInfo.outputPath("element-call-voice.png") });
            const bounds = await participants.boundingBox();
            expect(bounds?.width).toBeGreaterThan(180);
            await dock.getByRole("button", { name: "Disconnect", exact: true }).click();
            await expect(page.getByTestId("lobby_joinCall")).toBeVisible();
            await expect(participants.getByRole("button", { name: "Bob", exact: true })).toBeVisible();
            await expect(participants.getByRole("button", { name: "Alice", exact: true })).toHaveCount(0);
            await page.getByTestId("lobby_joinCall").click();
            await expect(page.getByTestId("videoTile")).toHaveCount(2, { timeout: 30_000 });
            await bobPage.getByTestId("incall_leave").click();
            await expect(page.getByTestId("videoTile")).toHaveCount(1, { timeout: 30_000 });
            await expect(participants.getByRole("button", { name: "Bob", exact: true })).toHaveCount(0);
            await dock.getByRole("button", { name: "Disconnect", exact: true }).click();
            await expect(page.getByTestId("lobby_joinCall")).toBeVisible();
            await page.getByRole("button", { name: "User menu", exact: true }).click();
            await page.getByRole("menuitem", { name: "All settings", exact: true }).click();
            await expect(page.getByRole("dialog")).toBeVisible();
        } finally {
            page.off("request", onRequest);
            bobContext.off("request", onRequest);
            await bobContext.close();
        }
    },
);
