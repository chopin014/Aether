/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type Page, type Request, type Response, type Route } from "@playwright/test";
import {
    closeReleaseAnnouncementIfExists,
    populateLocalStorageWithCredentials,
    rejectToastIfExists,
    routeConfigJson,
} from "@element-hq/element-web-playwright-common";

import { test, expect } from "../../element-web-test";
import { ElementAppPage } from "../../pages/ElementAppPage";
import { SettingLevel } from "../../../src/settings/SettingLevel";

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
    await rejectToastIfExists(page, "Verify this device");
    await rejectToastIfExists(page, "Notifications");
    await closeReleaseAnnouncementIfExists(page, "Introducing Sections");
}

/**
 * Sends Chromium's fake microphone without noise suppression. Its beep is not speech, so Voice Isolation would
 * rightly keep it out of the call, while these tests need sound to arrive.
 */
async function sendMicrophoneUnprocessed(page: Page): Promise<void> {
    await page.evaluate(async (level) => {
        await window.mxSettingsStore.setValue("desktopInputProfile", null, level, "custom");
        await window.mxSettingsStore.setValue("desktopNoiseSuppression", null, level, "none");
    }, SettingLevel.DEVICE);
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

/** Supply only the OS capture boundary; publication, transport, encryption and remote decoding remain real. */
async function syntheticDisplayCapture(page: Page): Promise<void> {
    await page.evaluate(() => {
        navigator.mediaDevices.getDisplayMedia = async (options) => {
            const canvas = document.createElement("canvas");
            canvas.width = 1280;
            canvas.height = 720;
            const context = canvas.getContext("2d")!;
            let tick = 0;
            const draw = (): void => {
                context.fillStyle = tick++ % 2 ? "#5865f2" : "#3ba55d";
                context.fillRect(0, 0, canvas.width, canvas.height);
                context.fillStyle = "white";
                context.font = "48px sans-serif";
                context.fillText(`Aether screen-share test ${tick}`, 64, 120);
            };
            draw();
            const timer = window.setInterval(draw, 33);
            const stream = canvas.captureStream(30);
            let audio: AudioContext | undefined;
            if (options?.audio) {
                audio = new AudioContext();
                const oscillator = audio.createOscillator();
                const destination = audio.createMediaStreamDestination();
                oscillator.frequency.value = 330;
                oscillator.connect(destination);
                oscillator.start();
                await audio.resume();
                stream.addTrack(destination.stream.getAudioTracks()[0]);
            }
            const video = stream.getVideoTracks()[0];
            const stop = video.stop.bind(video);
            video.stop = () => {
                window.clearInterval(timer);
                void audio?.close();
                stop();
            };
            return stream;
        };
    });
}

async function decodedVideoFrames(page: Page): Promise<number> {
    return page.evaluate(async () => {
        const peers = (window as Window & { __desktopVoicePeers?: RTCPeerConnection[] }).__desktopVoicePeers ?? [];
        let frames = 0;
        for (const peer of peers) {
            for (const entry of (await peer.getStats()).values()) {
                if (entry.type === "inbound-rtp" && entry.kind === "video") frames += entry.framesDecoded ?? 0;
            }
        }
        return frames;
    });
}

/** Inspect the actual audio renderer elements, tracking the pre-existing microphone separately from a new stream. */
async function playbackGains(page: Page): Promise<{ microphone: number[]; stream: number[]; muted: boolean[] }> {
    return page.evaluate(() => {
        const elements = Array.from(document.querySelectorAll("audio")).filter(
            (audio) => audio.srcObject instanceof MediaStream,
        );
        return {
            microphone: elements
                .filter((audio) => audio.dataset.microphoneProof === "true")
                .map((audio) => audio.volume),
            stream: elements.filter((audio) => audio.dataset.microphoneProof !== "true").map((audio) => audio.volume),
            muted: elements.map((audio) => audio.muted),
        };
    });
}

test(
    "two members use a persistent Element Call voice room without Jitsi",
    { tag: ["@no-firefox", "@no-webkit"] },
    async ({ page, app, user, browser, homeserver, config }, testInfo) => {
        test.setTimeout(300_000);
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
        await sendMicrophoneUnprocessed(page);
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
            await sendMicrophoneUnprocessed(bobPage);
            await observePeers(bobPage);
            const bobApp = new ElementAppPage(bobPage);
            await bobApp.client.evaluate(async (client) => {
                await client.setExtendedProfileProperty("io.aether.profile", {
                    v: 1,
                    theme: { primary: "#b87852", accent: "#dfa875" },
                    decoration: "neon-ring",
                });
            });
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
            await page.getByRole("button", { name: "Open server menu", exact: true }).click();
            await page.getByRole("menuitem", { name: "New voice room" }).click();
            await page.getByRole("textbox", { name: "Channel name", exact: true }).fill("Lounge");
            await page.getByRole("button", { name: "Create channel", exact: true }).click({ timeout: 15_000 });
            await page.getByRole("button", { name: "Open room Lounge", exact: true }).click();
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
            await bobPage.evaluate(
                (roomId) =>
                    (
                        window as unknown as Window & {
                            mxDispatcher: {
                                dispatch(payload: {
                                    action: string;
                                    room_id: string;
                                    view_call: boolean;
                                    skipLobby: boolean;
                                    voiceOnly: boolean;
                                }): void;
                            };
                        }
                    ).mxDispatcher.dispatch({
                        action: "view_room",
                        room_id: roomId,
                        view_call: true,
                        skipLobby: true,
                        voiceOnly: true,
                    }),
                roomId,
            );
            for (const memberPage of [page, bobPage]) {
                const memberDock = memberPage.getByRole("group", { name: "User menu" });
                await expect(memberDock.getByText("Voice Connected", { exact: true })).toBeVisible({ timeout: 60_000 });
                await memberDock.getByRole("button", { name: /Voice Connected/ }).click();
                // Element Call renders the local preview separately in its one-to-one layout.
                await expect(memberPage.getByTestId("videoTile").first()).toBeVisible({ timeout: 30_000 });
                await expect(memberPage.locator("video").filter({ visible: true })).toHaveCount(0);
                await expect.poll(() => receivedAudioBytes(memberPage), { timeout: 30_000 }).toBeGreaterThan(0);
                await expect.poll(() => decodedAudioEnergy(memberPage), { timeout: 30_000 }).toBeGreaterThan(0);
                await expect
                    .poll(() =>
                        memberPage.locator("audio").evaluateAll((elements) => {
                            const audio = elements as HTMLAudioElement[];
                            return audio.length > 0 && audio.every((a) => !a.paused && !a.muted && a.volume > 0);
                        }),
                    )
                    .toBe(true);
            }

            // Exercise camera and screen media through the real encrypted MatrixRTC/LiveKit connection.
            await page.getByRole("button", { name: "Reactions", exact: true }).click();
            await page.getByRole("button", { name: "Raise hand", exact: true }).click();
            await expect(bobPage.getByLabel("Hand raised", { exact: true })).toBeVisible();
            await page.getByRole("button", { name: "Lower hand", exact: true }).click();
            await expect(bobPage.getByLabel("Hand raised", { exact: true })).toHaveCount(0);
            await page.getByRole("button", { name: "Send reaction 🎉", exact: true }).click();
            await expect(
                bobPage.getByTestId("videoTile").filter({ hasText: "Alice" }).getByText("🎉", { exact: true }),
            ).toBeVisible();
            await page.getByRole("button", { name: "Turn On Camera", exact: true }).click();
            const remoteCamera = bobPage.getByTestId(`participant-video-${user.userId}`);
            await expect(remoteCamera).toBeVisible();
            await expect
                .poll(() =>
                    remoteCamera.evaluate(
                        (element: HTMLVideoElement) => element.getVideoPlaybackQuality().totalVideoFrames,
                    ),
                )
                .toBeGreaterThan(3);
            await expect.poll(() => decodedVideoFrames(bobPage)).toBeGreaterThan(3);
            await syntheticDisplayCapture(page);
            await bobPage.locator("audio").evaluateAll((elements) => {
                elements.forEach((node) => {
                    const element = node as HTMLAudioElement;
                    if (element.srcObject instanceof MediaStream) element.dataset.microphoneProof = "true";
                });
            });
            await page.getByRole("button", { name: "Stream Quality", exact: true }).click();
            await page.getByRole("checkbox").check();
            await page.getByRole("button", { name: "Go Live", exact: true }).click();
            const remoteScreen = bobPage.getByTestId(`screenshare-video-${user.userId}`);
            await expect(remoteScreen).toBeVisible({ timeout: 30_000 });
            await expect
                .poll(() =>
                    remoteScreen.evaluate(
                        (element: HTMLVideoElement) => element.getVideoPlaybackQuality().totalVideoFrames,
                    ),
                )
                .toBeGreaterThan(3);
            await expect
                .poll(() =>
                    bobPage.evaluate(async () => {
                        const audio = Array.from(document.querySelectorAll("audio")).find(
                            (element) =>
                                element.srcObject instanceof MediaStream && element.dataset.microphoneProof !== "true",
                        );
                        const trackId = (audio?.srcObject as MediaStream | undefined)?.getAudioTracks()[0]?.id;
                        const peers =
                            (window as Window & { __desktopVoicePeers?: RTCPeerConnection[] }).__desktopVoicePeers ??
                            [];
                        let energy = 0;
                        for (const peer of peers) {
                            for (const receiver of peer.getReceivers()) {
                                if (receiver.track.id !== trackId) continue;
                                (await receiver.getStats()).forEach((entry) => {
                                    if (entry.type === "inbound-rtp" && entry.kind === "audio")
                                        energy += entry.totalAudioEnergy ?? 0;
                                });
                            }
                        }
                        return energy;
                    }),
                )
                .toBeGreaterThan(0);
            await expect.poll(() => playbackGains(bobPage)).toMatchObject({ microphone: [1], stream: [1] });
            await page.getByRole("button", { name: "Stream Quality", exact: true }).click();
            await page.getByTestId("screenshare-res-720p").click();
            await page.getByTestId("screenshare-fps-15").click();
            const localScreenTrackId = await page
                .getByTestId(`screenshare-video-${user.userId}`)
                .evaluate((video: HTMLVideoElement) => (video.srcObject as MediaStream).getVideoTracks()[0].id);
            await expect
                .poll(() =>
                    page.evaluate(async (screenTrackId) => {
                        const peers =
                            (window as Window & { __desktopVoicePeers?: RTCPeerConnection[] }).__desktopVoicePeers ??
                            [];
                        for (const peer of peers) {
                            for (const sender of peer.getSenders()) {
                                if (sender.track?.id === screenTrackId) {
                                    const settings = sender.track.getSettings();
                                    return (
                                        settings.frameRate! <= 15 &&
                                        settings.height! <= 720 &&
                                        sender
                                            .getParameters()
                                            .encodings.every(
                                                (encoding) =>
                                                    encoding.maxFramerate! <= 15 && encoding.maxBitrate! <= 5_000_000,
                                            )
                                    );
                                }
                            }
                        }
                        return false;
                    }, localScreenTrackId),
                )
                .toBe(true);
            await page.keyboard.press("Escape");
            await bobPage.getByRole("button", { name: "Stream volume for Alice", exact: true }).click();
            const streamVolume = bobPage.getByRole("slider", { name: "Stream volume for Alice", exact: true });
            await streamVolume.press("Home");
            for (let i = 0; i < 5; ++i) await streamVolume.press("ArrowRight");
            await expect.poll(() => playbackGains(bobPage)).toMatchObject({ microphone: [1], stream: [0.05] });
            await bobPage.keyboard.press("Escape");
            await bobPage.getByRole("button", { name: "Audio options for Alice", exact: true }).click();
            const microphoneVolume = bobPage.getByRole("slider", { name: "Volume for Alice", exact: true });
            await microphoneVolume.press("Home");
            for (let i = 0; i < 8; ++i) await microphoneVolume.press("ArrowRight");
            await expect.poll(() => playbackGains(bobPage)).toMatchObject({ microphone: [0.08], stream: [0.05] });
            await bobPage.keyboard.press("Escape");
            const bobDock = bobPage.getByRole("group", { name: "User menu" });
            await bobPage.evaluate(async (level) => {
                await window.mxSettingsStore.setValue("desktopSpeakerVolume", null, level, 50);
            }, SettingLevel.DEVICE);
            await expect.poll(() => playbackGains(bobPage)).toMatchObject({ microphone: [0.04], stream: [0.025] });
            await bobPage.evaluate(async (level) => {
                await window.mxSettingsStore.setValue("desktopSpeakerVolume", null, level, 100);
            }, SettingLevel.DEVICE);
            await bobDock.getByRole("button", { name: "Deafen", exact: true }).click();
            await expect.poll(() => playbackGains(bobPage)).toMatchObject({ muted: [true, true] });
            await bobDock.getByRole("button", { name: "Undeafen", exact: true }).click();
            await expect
                .poll(() => playbackGains(bobPage))
                .toMatchObject({ microphone: [0.08], stream: [0.05], muted: [false, false] });
            for (const memberPage of [page, bobPage]) {
                await settle(memberPage);
                await memberPage.mouse.move(0, 0);
            }
            await page.screenshot({ path: testInfo.outputPath("aether-camera-and-screen-local.png") });
            await remoteScreen.hover({ force: true });
            await bobPage.screenshot({ path: testInfo.outputPath("aether-camera-and-screen-remote.png") });
            await bobPage.getByRole("button", { name: "Close", exact: true }).click();
            await remoteScreen.hover({ force: true });
            await bobPage.screenshot({ path: testInfo.outputPath("aether-focused-stream.png") });
            const framesBeforeNavigation = await decodedVideoFrames(bobPage);
            const peersBeforeNavigation = await page.evaluate(
                () => (window as Window & { __desktopVoicePeers?: RTCPeerConnection[] }).__desktopVoicePeers?.length,
            );
            await page.getByRole("button", { name: "Open room chat", exact: true }).click();
            await expect.poll(() => decodedVideoFrames(bobPage)).toBeGreaterThan(framesBeforeNavigation + 3);
            await page
                .getByRole("group", { name: "User menu" })
                .getByRole("button", { name: /Voice Connected/ })
                .click();
            expect(
                await page.evaluate(
                    () =>
                        (window as Window & { __desktopVoicePeers?: RTCPeerConnection[] }).__desktopVoicePeers?.length,
                ),
            ).toBe(peersBeforeNavigation);
            await page.getByRole("button", { name: "Stop Streaming", exact: true }).click();
            await expect(remoteScreen).toHaveCount(0);
            await expect.poll(() => playbackGains(bobPage)).toMatchObject({ microphone: [0.08], stream: [] });
            await page.getByRole("button", { name: "Turn Off Camera", exact: true }).click();
            await expect(remoteCamera).toHaveCount(0);
            const participants = page.getByRole("group", { name: "People in Lounge" });
            await expect(participants.getByRole("button", { name: "Alice (speaking)", exact: true })).toBeVisible();
            await expect(participants.getByRole("button", { name: "Bob (speaking)", exact: true })).toBeVisible();
            // Measure the other participant's decoded audio, not just a local meter or sent packet count.
            const remoteEnergyDelta = (): Promise<number> =>
                bobPage.evaluate(async () => {
                    const energy = async (): Promise<number> => {
                        const peers =
                            (window as Window & { __desktopVoicePeers?: RTCPeerConnection[] }).__desktopVoicePeers ??
                            [];
                        let total = 0;
                        for (const peer of peers) {
                            const stats = await peer.getStats();
                            stats.forEach((entry) => {
                                if (entry.type === "inbound-rtp" && entry.kind === "audio")
                                    total += entry.totalAudioEnergy ?? 0;
                            });
                        }
                        return total;
                    };
                    const before = await energy();
                    await new Promise((resolve) => setTimeout(resolve, 500));
                    return (await energy()) - before;
                });
            await page.evaluate(async (level) => {
                await window.mxSettingsStore.setValue("desktopPushToTalkKey", null, level, "KeyV");
                await window.mxSettingsStore.setValue("desktopPushToTalkReleaseDelay", null, level, 0);
                await window.mxSettingsStore.setValue("desktopInputMode", null, level, "push_to_talk");
            }, SettingLevel.DEVICE);
            await expect.poll(remoteEnergyDelta, { timeout: 15_000 }).toBeLessThan(0.000001);
            // Synthetic DOM key events exercise the browser fallback. Native OS events have a separate Electron test.
            await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyV" })));
            await expect.poll(remoteEnergyDelta, { timeout: 15_000 }).toBeGreaterThan(0.000001);
            await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyV" })));
            await expect.poll(remoteEnergyDelta, { timeout: 15_000 }).toBeLessThan(0.000001);
            await page.evaluate(async (level) => {
                await window.mxSettingsStore.setValue("desktopInputMode", null, level, "voice_activity");
                await window.mxSettingsStore.setValue("desktopMicrophoneVolume", null, level, 0);
            }, SettingLevel.DEVICE);
            await expect.poll(remoteEnergyDelta, { timeout: 15_000 }).toBeLessThan(0.000001);
            await page.evaluate(
                (level) => window.mxSettingsStore.setValue("desktopMicrophoneVolume", null, level, 100),
                SettingLevel.DEVICE,
            );
            await expect.poll(remoteEnergyDelta, { timeout: 15_000 }).toBeGreaterThan(0.000001);
            expect(jitsiRequests).toEqual([]);
            const dock = page.getByRole("group", { name: "User menu" });
            await expect(dock.getByText("Voice Connected", { exact: true })).toBeVisible();
            await dock.getByRole("button", { name: "Mute", exact: true }).click();
            await expect(dock.getByRole("button", { name: "Unmute", exact: true })).toHaveAttribute(
                "aria-pressed",
                "true",
            );
            await expect(participants.getByRole("button", { name: "Alice (muted)", exact: true })).toBeVisible();
            await dock.getByRole("button", { name: "Unmute", exact: true }).click();
            await expect(participants.getByRole("button", { name: "Alice (speaking)", exact: true })).toBeVisible();
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

            await dock.getByRole("button", { name: "Advanced noise suppression", exact: true }).click();
            const noisePanel = page.getByRole("dialog", { name: "Advanced noise suppression", exact: true });
            const suppression = noisePanel.getByRole("switch", { name: "Noise suppression", exact: true });
            await expect(suppression).not.toBeChecked();
            const denoiser = page.waitForResponse((response) => /aether-denoiser\.[^/]+\.wasm$/.test(response.url()));
            await suppression.check();
            expect((await denoiser).status()).toBe(200);
            const strength = noisePanel.getByRole("slider", { name: "Suppression strength", exact: true });
            await expect(strength).toBeEnabled();
            await strength.press("End");
            for (let value = 99; value >= 80; value--) {
                await strength.press("ArrowLeft");
                await expect(strength).toHaveValue(String(value));
            }
            await expect(noisePanel.getByText("80%", { exact: true })).toBeVisible();
            await expect
                .poll(() =>
                    page.evaluate(() => {
                        // The fixture declares only writes; read these two settings from the app's exposed store.
                        const settings = window.mxSettingsStore as typeof window.mxSettingsStore & {
                            getValue: (name: string) => unknown;
                        };
                        return {
                            suppression: settings.getValue("desktopNoiseSuppression"),
                            strength: settings.getValue("desktopNoiseSuppressionStrength"),
                        };
                    }),
                )
                .toEqual({ suppression: "enhanced", strength: 80 });
            await noisePanel.getByRole("button", { name: "Let's check", exact: true }).click();
            await expect(noisePanel.getByRole("meter", { name: "Microphone level", exact: true })).toBeVisible();
            await expect(dock.getByRole("button", { name: "Undeafen", exact: true })).toHaveAttribute(
                "aria-pressed",
                "true",
            );
            await expect(noisePanel.getByRole("alert")).toHaveCount(0);
            await noisePanel.getByRole("button", { name: "Stop testing", exact: true }).click();
            await expect(dock.getByRole("button", { name: "Deafen", exact: true })).toHaveAttribute(
                "aria-pressed",
                "false",
            );
            await expect(dock.getByRole("button", { name: "Mute", exact: true })).toBeVisible();
            // Restore the unprocessed synthetic beep for the rest of the real-media checks.
            await suppression.uncheck();
            await page.keyboard.press("Escape");
            await expect(noisePanel).toHaveCount(0);
            await expect(dock.getByRole("button", { name: "Advanced noise suppression", exact: true })).toBeFocused();

            await dock.getByRole("button", { name: "Connection", exact: true }).click();
            const connectionPanel = page.getByRole("dialog", { name: "Connection", exact: true });
            await expect(connectionPanel.getByRole("img", { name: "Recent ping", exact: true })).toBeVisible();
            await expect(connectionPanel.getByText("Last ping", { exact: true })).toBeVisible();
            await expect(connectionPanel.getByRole("definition").nth(1)).toHaveText(/^\d+ ms$/, { timeout: 30_000 });
            await expect(connectionPanel.getByRole("definition").first()).toHaveText(/^\d+ ms$/);
            // The displayed samples come from these real call transports, without a fabricated telemetry source.
            await expect
                .poll(() =>
                    page.evaluate(async () => {
                        const peers =
                            (window as Window & { __desktopVoicePeers?: RTCPeerConnection[] }).__desktopVoicePeers ??
                            [];
                        for (const peer of peers) {
                            const stats = await peer.getStats();
                            for (const entry of stats.values()) {
                                if (
                                    entry.type === "candidate-pair" &&
                                    entry.state === "succeeded" &&
                                    typeof entry.currentRoundTripTime === "number"
                                ) {
                                    return true;
                                }
                            }
                        }
                        return false;
                    }),
                )
                .toBe(true);
            await page.keyboard.press("Escape");
            await expect(connectionPanel).toHaveCount(0);

            await page.getByRole("button", { name: "Open room chat", exact: true }).click();
            await expect(page.getByRole("heading", { name: "chat", exact: true })).toBeVisible();
            await expect(dock.getByText("Voice Connected", { exact: true })).toBeVisible();
            const bytesBeforeNavigation = await receivedAudioBytes(page);
            await expect.poll(() => receivedAudioBytes(page)).toBeGreaterThan(bytesBeforeNavigation);
            await dock.getByRole("button", { name: /Voice Connected/ }).click();
            await expect(page.getByTestId("videoTile").first()).toBeVisible();
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
            // Hold the server-side leave to prove the sidebar responds to the click itself.
            const releaseLeave = Promise.withResolvers<void>();
            const leaveSent = Promise.withResolvers<void>();
            let leaveHeld = false;
            const holdLeave = async (route: Route): Promise<void> => {
                const request = route.request();
                const url = decodeURIComponent(request.url());
                const body = request.postDataJSON();
                const membershipLeave =
                    request.method() === "PUT" &&
                    url.includes(`/rooms/${roomId}/state/org.matrix.msc3401.call.member/`) &&
                    body &&
                    Object.keys(body).length === 0;
                const delayedLeave =
                    request.method() === "POST" &&
                    url.includes("/delayed_events/") &&
                    (url.endsWith("/send") || body?.action === "send");
                if (membershipLeave || delayedLeave) {
                    leaveHeld = true;
                    await releaseLeave.promise;
                    try {
                        await route.continue();
                    } finally {
                        leaveSent.resolve();
                    }
                } else {
                    await route.fallback();
                }
            };
            await page.route("**/_matrix/client/**", holdLeave);
            try {
                await dock.getByRole("button", { name: "Disconnect", exact: true }).click();
                await expect.poll(() => leaveHeld).toBe(true);
                await expect(dock.getByRole("button", { name: "Disconnect", exact: true })).toHaveCount(0);
                await expect(participants.getByRole("button", { name: /^Alice(?: \(speaking\))?$/ })).toHaveCount(0);
                await expect(participants.getByRole("button", { name: "Bob", exact: true })).toBeVisible();
            } finally {
                releaseLeave.resolve();
                if (leaveHeld) await leaveSent.promise;
                await page.unroute("**/_matrix/client/**", holdLeave);
            }
            await expect(page.getByTestId("lobby_joinCall")).toBeVisible();
            await expect(participants.getByRole("button", { name: "Bob", exact: true })).toBeVisible();
            await expect(participants.getByRole("button", { name: /^Alice(?: \(speaking\))?$/ })).toHaveCount(0);
            await page.getByTestId("lobby_joinCall").click();
            await expect(dock.getByText("Voice Connected", { exact: true })).toBeVisible({ timeout: 30_000 });
            const bytesAfterRejoin = await receivedAudioBytes(page);
            await expect.poll(() => receivedAudioBytes(page)).toBeGreaterThan(bytesAfterRejoin);
            await bobPage.getByTestId("incall_leave").click();
            await expect(page.getByTestId("videoTile")).toHaveCount(1, { timeout: 30_000 });
            await expect(participants.getByRole("button", { name: /^Bob(?: \(speaking\))?$/ })).toHaveCount(0);
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

for (const camera of [false, true]) {
    test(
        `conversation ${camera ? "video" : "voice"} call stays above chat and publishes the requested media`,
        { tag: ["@no-firefox", "@no-webkit"] },
        async ({ page, app, user, browser, homeserver, config }, testInfo) => {
            test.setTimeout(180_000);
            await settle(page);
            await sendMicrophoneUnprocessed(page);
            const bob = await homeserver.registerUser(`bob-conversation-${camera}`, "password", "Bob");
            const context = await browser.newContext({
                baseURL: new URL(page.url()).origin,
                permissions: ["microphone", "camera"],
            });
            try {
                const bobPage = await context.newPage();
                await routeConfigJson(context, homeserver.baseUrl, config);
                await populateLocalStorageWithCredentials(bobPage, bob);
                await bobPage.goto("/");
                await bobPage.waitForSelector(".mx_MatrixChat");
                await settle(bobPage);
                await sendMicrophoneUnprocessed(bobPage);
                await observePeers(bobPage);
                const bobApp = new ElementAppPage(bobPage);
                const roomId = await app.client.createRoom({
                    name: "Conversation",
                    is_direct: !camera,
                    invite: [bob.userId],
                    power_level_content_override: { events: { "org.matrix.msc3401.call.member": 0 } },
                });
                if (!camera) {
                    await app.client.evaluate(
                        async (client, { id, peer }) => {
                            await client.setAccountData(
                                "m.direct" as import("matrix-js-sdk/src/matrix").EventType.Direct,
                                { [peer]: [id] },
                            );
                        },
                        { id: roomId, peer: bob.userId },
                    );
                }
                await homeserver.csApi.request("POST", `/v3/join/${roomId}`, bob.accessToken, {});
                await expect
                    .poll(() => bobApp.client.evaluate((client, id) => client.getRoom(id)?.getMyMembership(), roomId))
                    .toBe("join");
                await app.viewRoomById(roomId);
                await bobApp.viewRoomById(roomId);
                await page.getByRole("button", { name: camera ? "Video call" : "Voice call", exact: true }).click();
                const stage = page.getByTestId("aether-call-stage");
                await expect(stage).toHaveAttribute("data-presentation", "conversation");
                await expect(stage).toHaveAttribute("data-phase", "in_call", { timeout: 60_000 });
                await expect(page.getByTestId("timeline")).toBeVisible();
                await expect(page.getByRole("region", { name: "Message composer" }).getByRole("textbox")).toBeVisible();
                const stageBounds = await stage.boundingBox();
                const timelineBounds = await page.getByTestId("timeline").boundingBox();
                expect(stageBounds!.y + stageBounds!.height).toBeLessThanOrEqual(timelineBounds!.y + 1);
                expect(stageBounds!.height).toBeLessThan(400);
                await expect(stage.getByTestId("call-control-camera")).toHaveAttribute("aria-pressed", String(camera));
                // Bob is rung as a faded, pulsing avatar until he answers.
                await expect(stage.getByRole("img", { name: "Calling Bob" })).toBeVisible({ timeout: 30_000 });
                await page.screenshot({ path: testInfo.outputPath("conversation-before-answer.png") });
                await testInfo.attach("recipient-before-answer", {
                    body: await bobPage.locator("body").ariaSnapshot(),
                    contentType: "text/plain",
                });
                await bobPage.getByTestId("join-call-button").click({ timeout: 15_000 });
                await expect(bobPage.getByTestId("aether-call-stage")).toHaveAttribute("data-phase", "in_call", {
                    timeout: 60_000,
                });
                await expect.poll(() => decodedAudioEnergy(bobPage), { timeout: 30_000 }).toBeGreaterThan(0);
                await expect(stage.getByRole("img", { name: "Calling Bob" })).toHaveCount(0);
                if (camera) {
                    await expect.poll(() => decodedVideoFrames(bobPage), { timeout: 30_000 }).toBeGreaterThan(0);
                    const tileBounds = await stage.getByTestId("videoTile").first().boundingBox();
                    expect(tileBounds!.height).toBeGreaterThan(tileBounds!.width / 2);
                } else {
                    await expect(stage.locator("video")).toHaveCount(0);
                }
                await page.screenshot({
                    path: testInfo.outputPath(`conversation-${camera ? "video" : "voice"}.png`),
                });
                await stage.getByTestId("incall_leave").click();
                await expect(page.getByTestId("timeline")).toBeVisible();
            } finally {
                await context.close();
            }
        },
    );
}

test("startup restores the last text channel while clicking voice still joins", async ({ page, app, user }) => {
    test.setTimeout(120_000);
    await settle(page);
    const firstTextId = await app.client.createRoom({ name: "general" });
    const lastTextId = await app.client.createRoom({ name: "off-topic" });
    const voiceId = await app.client.createRoom({
        name: "Lounge",
        creation_content: { type: "org.matrix.msc3417.call" },
    });
    const spaceId = await app.client.createSpace({
        name: "Startup space",
        initial_state: [firstTextId, lastTextId, voiceId].map((roomId) => ({
            type: "m.space.child",
            state_key: roomId,
            content: { via: [user.homeServer] },
        })),
    });
    await app.viewSpaceByName("Startup space");
    await page.getByRole("button", { name: "Open room off-topic", exact: true }).click();
    await expect(page.getByRole("heading", { name: "off-topic", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Open room Lounge", exact: true }).click({ timeout: 15_000 });
    await expect(page.getByTestId("aether-call-stage")).toHaveAttribute("data-phase", "in_call", {
        timeout: 60_000,
    });
    await expect.poll(() => page.evaluate(() => localStorage.getItem("mx_last_room_id"))).toBe(lastTextId);
    await expect
        .poll(() => page.evaluate((id) => localStorage.getItem(`mx_space_context_${id}`), spaceId))
        .toBe(lastTextId);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "off-topic", exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("aether-call-stage")).toHaveCount(0);
    await expect(
        page.getByRole("group", { name: "User menu" }).getByRole("button", { name: "Disconnect" }),
    ).toHaveCount(0);
    await expect
        .poll(() =>
            app.client.evaluate((client, id) => {
                const room = client.getRoom(id);
                return room
                    ? client.matrixRTC
                          .getRoomSession(room)
                          .memberships.filter(
                              (member) =>
                                  member.userId === client.getUserId() && member.deviceId === client.getDeviceId(),
                          ).length
                    : undefined;
            }, voiceId),
        )
        .toBe(0);
});

test("switches calls only after confirmation and remembers Don't ask again", async ({
    page,
    app,
    user,
    homeserver,
}, testInfo) => {
    test.setTimeout(180_000);
    await settle(page);
    const lounge = await app.client.createRoom({
        name: "Lounge",
        creation_content: { type: "org.matrix.msc3417.call" },
    });
    const studio = await app.client.createRoom({
        name: "Studio",
        creation_content: { type: "org.matrix.msc3417.call" },
    });
    const bob = await homeserver.registerUser("bob-switch-call", "password", "Bob");
    const conversation = await app.client.createRoom({
        name: "Switch conversation",
        is_direct: true,
        invite: [bob.userId],
        power_level_content_override: { events: { "org.matrix.msc3401.call.member": 0 } },
    });
    await homeserver.csApi.request("POST", `/v3/join/${conversation}`, bob.accessToken, {});
    await app.client.createSpace({
        name: "Switch space",
        initial_state: [lounge, studio, conversation].map((roomId) => ({
            type: "m.space.child",
            state_key: roomId,
            content: { via: [user.homeServer] },
        })),
    });
    await app.viewSpaceByName("Switch space");
    await page.getByRole("button", { name: "Open room Lounge", exact: true }).click();
    const stage = page.getByTestId("aether-call-stage").filter({ visible: true });
    await expect(stage).toHaveCount(1, { timeout: 15_000 });
    await expect(stage).toHaveAttribute("data-phase", "in_call", { timeout: 60_000 });
    const joinedRooms = (): Promise<string[]> =>
        app.client.evaluate((client) =>
            client
                .getRooms()
                .filter((room) => client.matrixRTC.getRoomSession(room).isJoined())
                .map((room) => room.roomId),
        );
    await expect.poll(joinedRooms).toEqual([lounge]);
    await page.getByRole("button", { name: "Open room Studio", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Leave your current call?" });
    await expect(dialog).toContainText("Studio");
    await expect.poll(joinedRooms).toEqual([lounge]);
    await page.screenshot({ path: testInfo.outputPath("switch-call-confirmation.png") });
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(joinedRooms).toEqual([lounge]);
    await page.getByRole("button", { name: "Open room Studio", exact: true }).click();
    await dialog.getByRole("button", { name: "Switch channel", exact: true }).click();
    await expect(stage).toHaveCount(1, { timeout: 15_000 });
    await expect(stage).toHaveAttribute("data-phase", "in_call", { timeout: 60_000 });
    await expect.poll(joinedRooms, { timeout: 15_000 }).toEqual([studio]);
    await app.viewRoomById(conversation);
    await page.getByRole("button", { name: "Video call", exact: true }).click();
    await expect(dialog).toContainText("Switch conversation");
    await expect.poll(joinedRooms).toEqual([studio]);
    await dialog.getByRole("checkbox", { name: "Don’t ask again" }).check();
    await dialog.getByRole("button", { name: "Switch channel", exact: true }).click();
    await expect(stage).toHaveCount(1, { timeout: 15_000 });
    await expect(stage).toHaveAttribute("data-phase", "in_call", { timeout: 60_000 });
    await expect(stage.getByTestId("call-control-camera")).toHaveAttribute("aria-pressed", "true");
    await expect.poll(joinedRooms, { timeout: 15_000 }).toEqual([conversation]);
    await expect
        .poll(() =>
            page.evaluate(
                () => JSON.parse(localStorage.getItem("mx_local_settings") ?? "{}").desktopVoiceSwitchWarning,
            ),
        )
        .toBe(false);
    await page.getByRole("button", { name: "Open room Lounge", exact: true }).click();
    await expect(stage).toHaveCount(1, { timeout: 15_000 });
    await expect(stage).toHaveAttribute("data-phase", "in_call", { timeout: 60_000 });
    await expect.poll(joinedRooms, { timeout: 15_000 }).toEqual([lounge]);
    await expect(dialog).toHaveCount(0);
    await stage.getByTestId("incall_leave").click();
    await expect.poll(joinedRooms).toEqual([]);
});

test("joining on another device moves voice there and can move back", async ({
    page,
    app,
    user,
    browser,
    homeserver,
    config,
}) => {
    test.setTimeout(180_000);
    await settle(page);
    const lounge = await app.client.createRoom({
        name: "Device lounge",
        creation_content: { type: "org.matrix.msc3417.call" },
    });
    const studio = await app.client.createRoom({
        name: "Device studio",
        creation_content: { type: "org.matrix.msc3417.call" },
    });
    await app.client.createSpace({
        name: "Device space",
        initial_state: [lounge, studio].map((roomId) => ({
            type: "m.space.child",
            state_key: roomId,
            content: { via: [user.homeServer] },
        })),
    });
    const secondDevice = await homeserver.loginUser(user.userId, user.password!);
    const context = await browser.newContext({
        baseURL: new URL(page.url()).origin,
        permissions: ["microphone", "camera"],
    });
    const joinedRooms = (clientApp: ElementAppPage): Promise<string[]> =>
        clientApp.client.evaluate((client) =>
            client
                .getRooms()
                .filter((room) => client.matrixRTC.getRoomSession(room).isJoined())
                .map((room) => room.roomId),
        );
    const ownMemberships = (): Promise<number> =>
        app.client.evaluate(
            (client) =>
                client
                    .getRooms()
                    .flatMap((room) =>
                        client.matrixRTC
                            .getRoomSession(room)
                            .memberships.filter((member) => member.userId === client.getUserId()),
                    ).length,
        );
    try {
        const secondPage = await context.newPage();
        await routeConfigJson(context, homeserver.baseUrl, config);
        await populateLocalStorageWithCredentials(secondPage, secondDevice);
        await secondPage.goto("/");
        await secondPage.waitForSelector(".mx_MatrixChat");
        await settle(secondPage);
        const secondApp = new ElementAppPage(secondPage);
        await app.viewSpaceByName("Device space");
        await secondApp.viewSpaceByName("Device space");
        await page.getByRole("button", { name: "Open room Device lounge", exact: true }).click();
        await expect.poll(() => joinedRooms(app), { timeout: 60_000 }).toEqual([lounge]);
        await expect.poll(ownMemberships, { timeout: 15_000 }).toBe(1);
        await secondPage.getByRole("button", { name: "Open room Device studio", exact: true }).click();
        await expect.poll(() => joinedRooms(secondApp), { timeout: 60_000 }).toEqual([studio]);
        await expect.poll(() => joinedRooms(app), { timeout: 30_000 }).toEqual([]);
        await expect(page.getByText("Call moved to another device", { exact: true })).toBeVisible();
        await page
            .getByRole("alert")
            .filter({ hasText: "Call moved to another device" })
            .getByRole("button", { name: "Dismiss", exact: true })
            .click();
        await expect.poll(ownMemberships, { timeout: 15_000 }).toBe(1);
        // The first client still displays its post-call lobby. Clicking its voice channel must join again.
        await page.getByRole("button", { name: "Open room Device lounge", exact: true }).click();
        await expect.poll(() => joinedRooms(app), { timeout: 60_000 }).toEqual([lounge]);
        await expect.poll(() => joinedRooms(secondApp), { timeout: 30_000 }).toEqual([]);
        await expect(secondPage.getByText("Call moved to another device", { exact: true })).toBeVisible();
        await secondPage
            .getByRole("alert")
            .filter({ hasText: "Call moved to another device" })
            .getByRole("button", { name: "Dismiss", exact: true })
            .click();
        await expect.poll(ownMemberships, { timeout: 15_000 }).toBe(1);
        // Joining the same channel from another device also replaces the existing copy of ourselves.
        await secondPage.getByRole("button", { name: /^Open room Device lounge(?:,|$)/ }).click();
        await expect.poll(() => joinedRooms(secondApp), { timeout: 60_000 }).toEqual([lounge]);
        await expect.poll(() => joinedRooms(app), { timeout: 30_000 }).toEqual([]);
        await expect.poll(ownMemberships, { timeout: 15_000 }).toBe(1);
        await secondPage.getByTestId("aether-call-stage").filter({ visible: true }).getByTestId("incall_leave").click();
        await expect.poll(ownMemberships, { timeout: 15_000 }).toBe(0);
    } finally {
        await context.close();
    }
});

test("shows profile customisation in call tiles and keeps it when focusing a participant", async ({
    page,
    app,
    user,
}, testInfo) => {
    await settle(page);
    await app.client.evaluate(async (client) => {
        await client.setExtendedProfileProperty("io.aether.profile", {
            v: 1,
            theme: { primary: "#19163b", accent: "#6327a0" },
            decoration: "neon-ring",
            name: { font: "pixel", effect: "none", colour: "#c09aff" },
        });
    });
    const roomId = await app.client.createRoom({
        name: "Profile voice",
        creation_content: { type: "org.matrix.msc3417.call" },
    });
    await app.client.createSpace({
        name: "Profile calls",
        initial_state: [{ type: "m.space.child", state_key: roomId, content: { via: [user.homeServer] } }],
    });
    await app.viewSpaceByName("Profile calls");
    await page.getByRole("button", { name: "Open room Profile voice", exact: true }).click();
    const stage = page.getByTestId("aether-call-stage").filter({ visible: true });
    await expect(stage).toHaveAttribute("data-phase", "in_call", { timeout: 60_000 });
    const tile = stage.getByTestId("videoTile");
    await expect(tile).toHaveCSS("--call-tile-colour", "#19163b");
    await expect(tile.getByTestId("name_tag")).toContainText("Alice");
    await expect(stage.getByRole("button", { name: "Show Chat" })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("personalized-call.png") });
    await stage.getByRole("button", { name: "Participant Alice", exact: true }).click();
    await expect(tile).toHaveCSS("--call-tile-colour", "#19163b");
    await expect(stage.getByRole("button", { name: "Grid View" })).toBeVisible();
    await stage.getByRole("button", { name: "Pop out call" }).click();
    await expect(stage).toHaveCount(0);
    await expect
        .poll(() =>
            page.evaluate(() => {
                const api = (window as Window & { documentPictureInPicture?: { window: Window | null } })
                    .documentPictureInPicture;
                return Boolean(api?.window?.document.querySelector('[data-testid="aether-call-stage"]'));
            }),
        )
        .toBe(true);
    await page.evaluate(() => {
        const api = (window as Window & { documentPictureInPicture?: { window: Window | null } })
            .documentPictureInPicture;
        api?.window?.close();
    });
    await expect(stage).toBeVisible();
    await stage.getByTestId("incall_leave").click();
});
