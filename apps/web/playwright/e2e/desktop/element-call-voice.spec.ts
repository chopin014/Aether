/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type Page, type Request, type Response } from "@playwright/test";
import { fileURLToPath } from "node:url";
import {
    closeReleaseAnnouncementIfExists,
    populateLocalStorageWithCredentials,
    rejectToast,
    routeConfigJson,
} from "@element-hq/element-web-playwright-common";

import { test, expect } from "../../element-web-test";
import { ElementAppPage } from "../../pages/ElementAppPage";

test.use({
    matrixRTC: true,
    lockLeftPanelWidth: false,
    displayName: "Alice",
    permissions: ["microphone", "camera"],
    launchOptions: {
        args: [
            "--use-fake-ui-for-media-stream",
            "--use-fake-device-for-media-stream",
            "--mute-audio",
            // A synthetic speech fixture exercises suppression without relying on Chromium's test tone.
            `--use-file-for-fake-audio-capture=${fileURLToPath(
                new URL("../../../src/audio/__fixtures__/speech.wav", import.meta.url),
            )}`,
        ],
    },
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
        const processedTracks = new Set<MediaStreamTrack>();
        Object.defineProperty(window, "__desktopVoiceProcessedTracks", { value: processedTracks });
        const createDestination = AudioContext.prototype.createMediaStreamDestination;
        AudioContext.prototype.createMediaStreamDestination = function () {
            const destination = createDestination.call(this);
            for (const track of destination.stream.getAudioTracks()) processedTracks.add(track);
            return destination;
        };
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

/** Check the Web Audio output actually reaches the microphone sender, rather than only loading a filter. */
async function hasProcessedMicrophone(page: Page): Promise<boolean> {
    return page.evaluate(() => {
        const state = window as Window & {
            __desktopVoicePeers?: RTCPeerConnection[];
            __desktopVoiceProcessedTracks?: Set<MediaStreamTrack>;
        };
        return (state.__desktopVoicePeers ?? []).some((peer) =>
            peer
                .getSenders()
                .some(
                    (sender) =>
                        sender.track?.kind === "audio" &&
                        sender.track.readyState === "live" &&
                        state.__desktopVoiceProcessedTracks?.has(sender.track),
                ),
        );
    });
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

/** Encrypted packets can arrive while decryption fails and every speaker remains silent. */
async function decodedAudioEnergy(page: Page): Promise<number> {
    return page.evaluate(async () => {
        const peers = (window as Window & { __desktopVoicePeers?: RTCPeerConnection[] }).__desktopVoicePeers ?? [];
        let energy = 0;
        for (const peer of peers) {
            const stats = await peer.getStats();
            stats.forEach((entry) => {
                if (entry.type === "inbound-rtp" && entry.kind === "audio") energy += entry.totalAudioEnergy ?? 0;
            });
        }
        return energy;
    });
}

/** Count decoded remote video frames: encrypted packets alone do not prove a working screen share. */
async function decodedVideoFrames(page: Page): Promise<number> {
    return page.evaluate(async () => {
        const peers = (window as Window & { __desktopVoicePeers?: RTCPeerConnection[] }).__desktopVoicePeers ?? [];
        let frames = 0;
        for (const peer of peers) {
            const stats = await peer.getStats();
            stats.forEach((entry) => {
                if (entry.type === "inbound-rtp" && entry.kind === "video") frames += entry.framesDecoded ?? 0;
            });
        }
        return frames;
    });
}

test(
    "publishes a noise-suppressed microphone and preserves mute and disconnect controls",
    { tag: ["@no-firefox", "@no-webkit"] },
    async ({ page, app, user }) => {
        test.setTimeout(90_000);
        await settle(page);
        await observePeers(page);
        const roomId = await app.client.createRoom({
            name: "Noise suppression",
            creation_content: { type: "org.matrix.msc3417.call" },
        });
        await app.viewRoomById(roomId);
        const dock = page.getByRole("group", { name: "User menu" });
        await expect(dock.getByText("Voice Connected", { exact: true })).toBeVisible({ timeout: 30_000 });
        await expect.poll(() => hasProcessedMicrophone(page), { timeout: 30_000 }).toBe(true);
        await expect
            .poll(() =>
                page.evaluate(async () => {
                    const peers =
                        (window as Window & { __desktopVoicePeers?: RTCPeerConnection[] }).__desktopVoicePeers ?? [];
                    let bytes = 0;
                    for (const peer of peers) {
                        const stats = await peer.getStats();
                        stats.forEach((entry) => {
                            if (entry.type === "outbound-rtp" && entry.kind === "audio") bytes += entry.bytesSent ?? 0;
                        });
                    }
                    return bytes;
                }),
            )
            .toBeGreaterThan(0);
        await dock.getByRole("button", { name: "Mute", exact: true }).click();
        await expect(dock.getByRole("button", { name: "Unmute", exact: true })).toBeVisible();
        await dock.getByRole("button", { name: "Unmute", exact: true }).click();
        await expect(dock.getByRole("button", { name: "Mute", exact: true })).toBeVisible();
        await expect.poll(() => hasProcessedMicrophone(page)).toBe(true);
        await dock.getByRole("button", { name: "Disconnect", exact: true }).click();
        await expect.poll(() => hasProcessedMicrophone(page)).toBe(false);
    },
);

test(
    "two members use a persistent Element Call voice room without Jitsi",
    { tag: ["@no-firefox", "@no-webkit"] },
    async ({ page, app, user, browser, homeserver, config }, testInfo) => {
        test.setTimeout(180_000);
        const jitsiRequests: string[] = [];
        const soundResponses = new Map<string, number>();
        const onSound = (response: Response): void => {
            if (response.url().endsWith(".wav")) soundResponses.set(response.url(), response.status());
        };
        page.on("response", onSound);
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
            // Keep the desktop call layout wide enough to show both tiles alongside the room chat.
            viewport: { width: 1600, height: 900 },
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
            const bobApp = new ElementAppPage(bobPage);
            // Reproduce existing Element clients: a per-join key UUID with a legacy membership/backend ID.
            await bobApp.client.evaluate((client) => {
                const send = client.encryptAndSendToDevice.bind(client);
                const legacyJoinId = crypto.randomUUID();
                client.encryptAndSendToDevice = async (eventType, targets, content) => {
                    if (eventType === "io.element.call.encryption_keys") {
                        const legacy: typeof content = { ...content, member: { ...content.member, id: legacyJoinId } };
                        delete legacy.member_id;
                        return send(eventType, targets, legacy);
                    }
                    return send(eventType, targets, content);
                };
            });

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
            await expect
                .poll(() => bobApp.client.evaluate((client, id) => client.getRoom(id)?.getType(), roomId))
                .toBe("org.matrix.msc3417.call");
            await bobPage.goto(`/#/room/${roomId}`);
            for (const memberPage of [page, bobPage]) {
                const memberDock = memberPage.getByRole("group", { name: "User menu" });
                await expect(memberDock.getByText("Voice Connected", { exact: true })).toBeVisible({ timeout: 60_000 });
                await memberDock.getByRole("button", { name: /Voice Connected/ }).click();
                await expect(memberPage.getByTestId("videoTile")).toHaveCount(2, { timeout: 30_000 });
                await expect(memberPage.locator("video").filter({ visible: true })).toHaveCount(0);
                await expect.poll(() => receivedAudioBytes(memberPage), { timeout: 30_000 }).toBeGreaterThan(0);
                await expect.poll(() => decodedAudioEnergy(memberPage), { timeout: 30_000 }).toBeGreaterThan(0);
                await expect.poll(() => hasProcessedMicrophone(memberPage)).toBe(true);
                await expect
                    .poll(() =>
                        memberPage.locator("audio").evaluateAll((elements) => {
                            const audio = elements as HTMLAudioElement[];
                            return audio.length > 0 && audio.every((a) => !a.paused && !a.muted && a.volume > 0);
                        }),
                    )
                    .toBe(true);
            }
            // Reproduce an abandoned login's advertised membership without a corresponding media connection.
            const staleMembershipKey = await app.client.evaluate(async (client, roomId) => {
                const eventType =
                    "org.matrix.msc3401.call.member" as import("matrix-js-sdk").EventType.GroupCallMemberPrefix;
                const ownEvent = client
                    .getRoom(roomId)!
                    .currentState.getStateEvents(eventType)
                    .find((event) => event.getContent().device_id === client.getDeviceId())!;
                const content = ownEvent.getContent() as import("matrix-js-sdk/src/matrixrtc").SessionMembershipData;
                const deviceId = "AETHER_STALE";
                const stateKey = `_${client.getUserId()}_${deviceId}_m.call`;
                await client.sendStateEvent(
                    roomId,
                    eventType,
                    {
                        ...content,
                        device_id: deviceId,
                        membershipID: `${client.getUserId()}:${deviceId}`,
                        created_ts: Date.now(),
                    },
                    stateKey,
                );
                return stateKey;
            }, roomId);

            for (const memberApp of [app, bobApp]) {
                await expect
                    .poll(() =>
                        memberApp.client.evaluate(
                            (client, roomId) =>
                                client.matrixRTC.getRoomSession(client.getRoom(roomId)!).memberships.length,
                            roomId,
                        ),
                    )
                    .toBe(3);
                await expect(memberApp.page.getByTestId("videoTile")).toHaveCount(2);
                await expect(memberApp.page.getByText("Waiting for media...", { exact: true })).toHaveCount(0);
            }
            await app.client.evaluate(
                (client, { roomId, stateKey }) =>
                    client.sendStateEvent(
                        roomId,
                        "org.matrix.msc3401.call.member" as import("matrix-js-sdk").EventType.GroupCallMemberPrefix,
                        {},
                        stateKey,
                    ),
                { roomId, stateKey: staleMembershipKey },
            );

            // Supply changing screen content without depending on the host's desktop capture picker.
            // Publishing, encryption, transport, decryption and rendering still use the real call stack.
            await bobPage.evaluate(() => {
                navigator.mediaDevices.getDisplayMedia = async () => {
                    const canvas = document.createElement("canvas");
                    canvas.width = 640;
                    canvas.height = 360;
                    const context = canvas.getContext("2d")!;
                    let frame = 0;
                    const draw = (): void => {
                        context.fillStyle = frame++ % 2 ? "#008080" : "#800080";
                        context.fillRect(0, 0, canvas.width, canvas.height);
                    };
                    draw();
                    const stream = canvas.captureStream(10);
                    const timer = window.setInterval(draw, 100);
                    const track = stream.getVideoTracks()[0];
                    const stop = track.stop.bind(track);
                    track.stop = (): void => {
                        window.clearInterval(timer);
                        stop();
                    };
                    return stream;
                };
            });
            const shareScreen = bobPage.getByRole("switch", { name: /^(Share screen|Sharing screen)$/ });
            await shareScreen.click();
            await expect(shareScreen).toBeChecked();
            const remoteScreen = page.locator("video").filter({ visible: true });
            await expect(remoteScreen).toHaveCount(1, { timeout: 30_000 });
            await expect.poll(() => remoteScreen.evaluate((video: HTMLVideoElement) => video.videoWidth)).toBe(640);
            await expect
                .poll(() => remoteScreen.evaluate((video: HTMLVideoElement) => video.currentTime))
                .toBeGreaterThan(0);
            await expect.poll(() => decodedVideoFrames(page), { timeout: 30_000 }).toBeGreaterThan(0);
            const firstFrames = await decodedVideoFrames(page);
            await expect.poll(() => decodedVideoFrames(page)).toBeGreaterThan(firstFrames);
            await shareScreen.click();
            await expect(shareScreen).not.toBeChecked();
            await expect(remoteScreen).toHaveCount(0);

            const participants = page.getByRole("group", { name: "People in Lounge" });
            await expect(participants.getByRole("button", { name: "Alice (speaking)", exact: true })).toBeVisible();
            await expect(participants.getByRole("button", { name: "Bob (speaking)", exact: true })).toBeVisible();
            for (const name of ["Alice", "Bob"]) {
                const tile = page.getByTestId("videoTile").filter({ has: page.getByText(name, { exact: true }) });
                await expect(tile).toHaveAttribute("data-speaking", "true");
            }
            expect(jitsiRequests).toEqual([]);
            const dock = page.getByRole("group", { name: "User menu" });
            await expect(dock.getByText("Voice Connected", { exact: true })).toBeVisible();
            await dock.getByRole("button", { name: "Mute", exact: true }).click();
            await expect(dock.getByRole("button", { name: "Unmute", exact: true })).toHaveAttribute(
                "aria-pressed",
                "true",
            );
            await expect(participants.getByRole("button", { name: "Alice", exact: true })).toBeVisible();
            await dock.getByRole("button", { name: "Unmute", exact: true }).click();
            await dock.getByRole("button", { name: "Deafen", exact: true }).click();
            await expect(dock.getByRole("button", { name: "Undeafen", exact: true })).toHaveAttribute(
                "aria-pressed",
                "true",
            );
            await expect(dock.getByRole("button", { name: "Unmute", exact: true })).toBeVisible();
            await dock.getByRole("button", { name: "Undeafen", exact: true }).click();
            await expect(dock.getByRole("button", { name: "Mute", exact: true })).toBeVisible();
            const energyAfterUndeafen = await decodedAudioEnergy(page);
            await expect.poll(() => decodedAudioEnergy(page), { timeout: 15_000 }).toBeGreaterThan(energyAfterUndeafen);
            await expect.poll(() => soundResponses.size).toBeGreaterThanOrEqual(5);
            expect([...soundResponses.values()].every((status) => status === 200 || status === 206)).toBe(true);
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
            page.off("response", onSound);
            bobContext.off("request", onRequest);
            await bobContext.close();
        }
    },
);
