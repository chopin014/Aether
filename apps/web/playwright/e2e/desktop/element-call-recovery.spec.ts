/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { createHmac } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { connect, createServer, type Server } from "node:net";
import { promisify } from "node:util";

import { type Page, type ConsoleMessage } from "@playwright/test";
import {
    closeReleaseAnnouncementIfExists,
    populateLocalStorageWithCredentials,
    rejectToastIfExists,
    routeConfigJson,
} from "@element-hq/element-web-playwright-common";

import { test, expect } from "../../element-web-test";
import { ElementAppPage } from "../../pages/ElementAppPage";
import { SettingLevel } from "../../../src/settings/SettingLevel";
import { LIVEKIT_API_KEY, LIVEKIT_API_SECRET } from "../../testcontainers/livekit";

const run = promisify(execFile);
const cases = [
    "baseline",
    "membership removal",
    "membership expiry",
    "membership removal with renewal unavailable",
    "membership removal with renewal forbidden",
    "Matrix sync outage",
    "signalling socket loss",
    "SFU participant removal",
    "SFU restart",
    "SFU outage beyond retries",
    "signalling outage beyond retries",
    "renderer suspension without delegation",
    "network offline",
    "encrypted membership removal",
    "encrypted SFU restart",
    "slow homeserver",
    "clock 8s ahead",
] as const;
// Faults that only show up when memberships are renewed, which happens every five minutes.
const renewalCycleFaults: ReadonlyArray<(typeof cases)[number]> = ["slow homeserver", "clock 8s ahead"];

test.use({
    matrixRTC: true,
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
test.skip(({ homeserverType, browserName }) => homeserverType !== "synapse" || browserName !== "chromium");

async function settle(page: Page): Promise<void> {
    await rejectToastIfExists(page, "Verify this device");
    await rejectToastIfExists(page, "Notifications");
    await closeReleaseAnnouncementIfExists(page, "Introducing Sections");
    await page.evaluate(async (level) => {
        await window.mxSettingsStore.setValue("desktopAnsMigrated", null, level, true);
        await window.mxSettingsStore.setValue("desktopInputProfile", null, level, "custom");
        await window.mxSettingsStore.setValue("desktopNoiseSuppression", null, level, "none");
        const peers: RTCPeerConnection[] = [];
        const sockets: WebSocket[] = [];
        const sounds: string[] = [];
        Object.assign(window, { __recoveryPeers: peers, __recoverySockets: sockets, __recoverySounds: sounds });
        // Record every cue the app plays so false join and leave sounds can be counted.
        const play = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
            // Only the app's own cues are files; call audio plays from media streams.
            const src = this.currentSrc || this.src;
            if (src.endsWith(".wav")) sounds.push(src.split("/").pop()!.split(".")[0]);
            return play.call(this);
        };
        const Peer = window.RTCPeerConnection;
        window.RTCPeerConnection = class extends Peer {
            public constructor(config?: RTCConfiguration) {
                super(config);
                peers.push(this);
            }
        };
        const Socket = window.WebSocket;
        window.WebSocket = class extends Socket {
            public constructor(url: string | URL, protocols?: string | string[]) {
                super(url, protocols);
                sockets.push(this);
            }
        };
    }, SettingLevel.DEVICE);
}

async function openCall(page: Page, roomId: string): Promise<void> {
    await page.evaluate((id) => {
        (window as unknown as { mxDispatcher: { dispatch: (payload: unknown) => void } }).mxDispatcher.dispatch({
            action: "view_room",
            room_id: id,
            view_call: true,
            skipLobby: true,
            voiceOnly: true,
        });
    }, roomId);
}

async function measure(app: ElementAppPage, roomId: string) {
    const matrix = await app.client.evaluate((client, id) => {
        const session = client.matrixRTC.getRoomSession(client.getRoom(id)!);
        return {
            joined: session.isJoined(),
            status: session.membershipStatus,
            probablyLeft: session.probablyLeft,
            own: session.memberships.filter(
                (m) => m.userId === client.getUserId() && m.deviceId === client.getDeviceId(),
            ).length,
            members: session.memberships.map((m) => ({ user: m.userId, device: m.deviceId })),
            sync: client.getSyncState(),
        };
    }, roomId);
    const transport = await app.page.evaluate(async () => {
        const peers = (window as unknown as { __recoveryPeers: RTCPeerConnection[] }).__recoveryPeers;
        let received = 0;
        let sent = 0;
        let energy = 0;
        for (const peer of peers) {
            const stats = await peer.getStats();
            stats.forEach((entry) => {
                if (entry.kind !== "audio") return;
                if (entry.type === "inbound-rtp") {
                    received += entry.bytesReceived ?? 0;
                    energy += entry.totalAudioEnergy ?? 0;
                }
                if (entry.type === "outbound-rtp") sent += entry.bytesSent ?? 0;
            });
        }
        return { received, sent, energy, peers: peers.map((p) => p.connectionState) };
    });
    const stage = app.page.getByTestId("aether-call-stage").filter({ visible: true });
    return {
        ...matrix,
        ...transport,
        phase: (await stage.count()) ? await stage.getAttribute("data-phase") : null,
        tiles: await stage.getByTestId("videoTile").allTextContents(),
        alerts: await app.page.getByRole("alert").filter({ visible: true }).allTextContents(),
        statusText: await app.page.getByRole("status").filter({ visible: true }).allTextContents(),
        sounds: await app.page.evaluate(() => [
            ...(window as unknown as { __recoverySounds: string[] }).__recoverySounds,
        ]),
    };
}

// The SFU container outlives a single test, so its forwarded address must stay up for the tests after a restart.
let sfuForward: { server: Server; port: number } | null = null;

/** Serves the SFU's original signalling port from the port Docker gave it after a restart. */
async function forwardSfu(knownPort: number, port: number): Promise<void> {
    if (sfuForward) {
        sfuForward.port = port;
        return;
    }
    const forward = {
        port,
        server: createServer((client) => {
            const upstream = connect(forward.port, "127.0.0.1");
            client.pipe(upstream).pipe(client);
            upstream.on("error", () => client.destroy());
            client.on("error", () => upstream.destroy());
        }),
    };
    sfuForward = forward;
    forward.server.unref();
    await new Promise<void>((resolve) => forward.server.listen(knownPort, "0.0.0.0", resolve));
}

/** Whether decoded audio keeps arriving, measured over a short window so replaced connections do not skew it. */
async function audioFlowing(app: ElementAppPage, roomId: string): Promise<boolean> {
    const before = (await measure(app, roomId)).energy;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return (await measure(app, roomId)).energy > before;
}

for (const fault of cases) {
    test(`call recovery: ${fault}`, async ({
        page,
        app,
        browser,
        homeserver,
        config,
        user,
        matrixRTCBackend,
    }, testInfo) => {
        test.setTimeout(renewalCycleFaults.includes(fault) ? 600_000 : 240_000);
        const injection = fault.replace(/^encrypted /, "");
        let socketFault = false;
        let manuallyRecovered: boolean | null = null;
        const logs: string[] = [];
        const bobLogs: string[] = [];
        const testStart = Date.now();
        const lifecycle = (into: string[]) => (msg: ConsoleMessage) => {
            if (/membership|livekit|reconnect|connection|pausing|resuming|error|expir|rejoin/i.test(msg.text()))
                into.push(`+${((Date.now() - testStart) / 1000).toFixed(1)}s ${msg.text()}`);
        };
        const onConsole = lifecycle(logs);
        const onBobConsole = lifecycle(bobLogs);
        page.on("console", onConsole);
        await settle(page);
        const bob = await homeserver.registerUser(
            `bob-recovery-${testInfo.testId.replace(/\W/g, "").slice(-16)}`,
            "password",
            "Bob",
        );
        const context = await browser.newContext({
            baseURL: new URL(page.url()).origin,
            permissions: ["microphone", "camera"],
            recordVideo: { dir: testInfo.outputPath("bob-video") },
        });
        let paused = false;
        const samples: Array<{
            seconds: number;
            alice: Awaited<ReturnType<typeof measure>>;
            bob: Awaited<ReturnType<typeof measure>>;
        }> = [];
        try {
            if (fault === "clock 8s ahead") {
                await context.addInitScript(() => {
                    const now = Date.now.bind(Date);
                    Date.now = (): number => now() + 8000;
                });
            }
            const bobPage = await context.newPage();
            bobPage.on("console", onBobConsole);
            await routeConfigJson(context, homeserver.baseUrl, config);
            await populateLocalStorageWithCredentials(bobPage, bob);
            await bobPage.goto("/");
            await bobPage.waitForSelector(".mx_MatrixChat");
            await settle(bobPage);
            const bobApp = new ElementAppPage(bobPage);
            if (fault === "renderer suspension without delegation") {
                await page.route(/delegate_delayed_leave/, (route) =>
                    route.fulfill({ status: 404, json: { errcode: "M_UNRECOGNIZED" } }),
                );
            }
            const roomId = await app.client.createRoom({
                name: `Recovery ${fault}`,
                creation_content: { type: "org.matrix.msc3417.call" },
                invite: [bob.userId],
                initial_state: fault.startsWith("encrypted ")
                    ? [{ type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } }]
                    : [],
                power_level_content_override: { events: { "org.matrix.msc3401.call.member": 0 } },
            });
            await homeserver.csApi.request("POST", `/v3/join/${roomId}`, bob.accessToken, {});
            await expect.poll(() => bobApp.client.evaluate((c, id) => !!c.getRoom(id), roomId)).toBe(true);
            await openCall(page, roomId);
            await openCall(bobPage, roomId);
            for (const clientApp of [app, bobApp]) {
                await expect(clientApp.page.getByTestId("aether-call-stage").filter({ visible: true })).toHaveAttribute(
                    "data-phase",
                    "in_call",
                    { timeout: 60_000 },
                );
                await expect
                    .poll(async () => (await measure(clientApp, roomId)).energy, { timeout: 30_000 })
                    .toBeGreaterThan(0);
                await expect.poll(async () => (await measure(clientApp, roomId)).own).toBe(1);
            }
            samples.push({ seconds: -1, alice: await measure(app, roomId), bob: await measure(bobApp, roomId) });
            const state = await app.client.evaluate((client, id) => {
                const room = client.getRoom(id)!;
                const own = client.matrixRTC
                    .getRoomSession(room)
                    .memberships.find((m) => m.userId === client.getUserId() && m.deviceId === client.getDeviceId())!;
                const event = room.currentState
                    .getStateEvents("org.matrix.msc3401.call.member")
                    .find((e) => e.getId() === own.eventId)!;
                return { type: event.getType(), key: event.getStateKey()!, content: event.getContent() };
            }, roomId);
            const membershipPattern = /\/_matrix\/client\/.*\/rooms\/.*\/state\/org\.matrix\.msc3401\.call\.member/;
            let duration = fault.includes("beyond retries") ? 110 : 30;
            if (fault === "baseline") duration = 5;
            // Cover a full membership renewal, which is due five minutes after joining.
            if (renewalCycleFaults.includes(fault)) duration = 320;
            if (fault === "slow homeserver") {
                await page.route(membershipPattern, async (route) => {
                    if (route.request().method() === "PUT") await new Promise((resolve) => setTimeout(resolve, 7000));
                    await route.continue();
                });
            }
            if (fault.includes("renewal")) {
                await page.route(membershipPattern, (route) =>
                    route.request().method() === "PUT"
                        ? route.fulfill({
                              status: fault.endsWith("forbidden") ? 403 : 503,
                              json: {
                                  errcode: fault.endsWith("forbidden") ? "M_FORBIDDEN" : "M_UNKNOWN",
                                  error: "Injected renewal failure",
                              },
                          })
                        : route.continue(),
                );
            }
            if (injection.startsWith("membership")) {
                const content =
                    fault === "membership expiry" ? { ...state.content, created_ts: Date.now(), expires: 2000 } : {};
                await homeserver.csApi.request(
                    "PUT",
                    `/v3/rooms/${roomId}/state/${encodeURIComponent(state.type)}/${encodeURIComponent(state.key)}`,
                    user.accessToken,
                    content,
                );
            } else if (fault === "Matrix sync outage") {
                await page.route(/\/_matrix\/client\/.*\/sync\?/, (route) => route.abort("internetdisconnected"));
                await app.client.evaluate((client) => client.retryImmediately());
            } else if (fault === "signalling socket loss" || fault === "signalling outage beyond retries") {
                if (fault === "signalling outage beyond retries") {
                    socketFault = true;
                    await page.routeWebSocket(
                        (url) => url.hostname === "livekit.localhost",
                        async (ws) => {
                            if (socketFault) await ws.close({ code: 1011, reason: "Injected signalling outage" });
                            else ws.connectToServer();
                        },
                    );
                }
                await page.evaluate(() => {
                    for (const socket of (window as unknown as { __recoverySockets: WebSocket[] }).__recoverySockets) {
                        if (socket.readyState === WebSocket.OPEN && socket.url.includes("/rtc")) socket.close();
                    }
                });
            } else if (fault === "SFU participant removal") {
                const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
                const api = async (method: string, body: { room?: string; identity?: string }) => {
                    const scopedPayload = Buffer.from(
                        JSON.stringify({
                            iss: LIVEKIT_API_KEY,
                            sub: "recovery-test",
                            exp: Math.floor(Date.now() / 1000) + 120,
                            video: { roomAdmin: true, roomList: true, room: body.room },
                        }),
                    ).toString("base64url");
                    const scopedToken = `${header}.${scopedPayload}.${createHmac("sha256", LIVEKIT_API_SECRET).update(`${header}.${scopedPayload}`).digest("base64url")}`;
                    const response = await fetch(
                        `${matrixRTCBackend!.livekit.signallingUrl.replace("ws:", "http:").replace("livekit.localhost", "127.0.0.1")}/twirp/livekit.RoomService/${method}`,
                        {
                            method: "POST",
                            headers: { "Authorization": `Bearer ${scopedToken}`, "Content-Type": "application/json" },
                            body: JSON.stringify(body),
                        },
                    );
                    expect(response.ok).toBe(true);
                    return response.json();
                };
                // Earlier tests leave their SFU rooms behind, so find the one Alice is in now.
                const rooms: { rooms: Array<{ name: string }> } = await api("ListRooms", {});
                let target: { room: string; identity: string } | undefined;
                for (const { name } of rooms.rooms) {
                    const { participants } = await api("ListParticipants", { room: name });
                    const own = participants?.find((p: { identity: string }) => p.identity.includes(user.userId));
                    if (own) target = { room: name, identity: own.identity };
                }
                expect(target).toBeDefined();
                await api("RemoveParticipant", target!);
            } else if (injection === "SFU restart") {
                const id = matrixRTCBackend!.livekit.getId();
                const knownPort = Number(new URL(matrixRTCBackend!.livekit.signallingUrl).port);
                await run("docker", ["restart", "--time", "0", id]);
                // Docker publishes the signalling port on a new host port after a restart. Forward the old one so
                // the SFU comes back at the address clients already use, as a restarted production SFU would.
                const { stdout } = await run("docker", ["port", id, "7880/tcp"]);
                const port = Number(stdout.trim().split("\n")[0].split(":").pop());
                if (port !== knownPort) await forwardSfu(knownPort, port);
            } else if (fault === "network offline") {
                await page.context().setOffline(true);
            } else if (fault === "SFU outage beyond retries") {
                await run("docker", ["pause", matrixRTCBackend!.livekit.getId()]);
                paused = true;
            }
            if (fault === "renderer suspension without delegation") {
                const tab = await page.context().newCDPSession(page);
                try {
                    await tab.send("Page.setWebLifecycleState", { state: "frozen" });
                    await new Promise((resolve) => setTimeout(resolve, 25_000));
                } finally {
                    await tab.send("Page.setWebLifecycleState", { state: "active" });
                    await tab.detach();
                }
            }
            const started = Date.now();
            while (Date.now() - started < duration * 1000) {
                samples.push({
                    seconds: Math.round((Date.now() - started) / 1000),
                    alice: await measure(app, roomId),
                    bob: await measure(bobApp, roomId),
                });
                await new Promise((resolve) => setTimeout(resolve, 1000));
            }
            if (fault === "network offline") await page.context().setOffline(false);
            if (paused) {
                await run("docker", ["unpause", matrixRTCBackend!.livekit.getId()]);
                paused = false;
            }
            socketFault = false;
            await page.unrouteAll({ behavior: "wait" });
            // Observe another recovery window with the injected network/server fault removed.
            if (fault !== "baseline") {
                const recovery = Date.now();
                while (Date.now() - recovery < 45_000) {
                    samples.push({
                        seconds: duration + Math.round((Date.now() - recovery) / 1000),
                        alice: await measure(app, roomId),
                        bob: await measure(bobApp, roomId),
                    });
                    await new Promise((resolve) => setTimeout(resolve, 1000));
                }
            }
            const last = samples.at(-1)!;
            // Keep the memberships the homeserver holds, to see what each client last sent.
            const roomState = await homeserver.csApi.request("GET", `/v3/rooms/${roomId}/state`, user.accessToken);
            await writeFile(
                testInfo.outputPath("call-members.json"),
                JSON.stringify(
                    (roomState as Array<{ type: string }>).filter((e) => e.type === "org.matrix.msc3401.call.member"),
                    null,
                    2,
                ),
            );
            const flowing = { alice: await audioFlowing(app, roomId), bob: await audioFlowing(bobApp, roomId) };
            const heard = {
                alice: last.alice.sounds.slice(samples[0].alice.sounds.length),
                bob: last.bob.sounds.slice(samples[0].bob.sounds.length),
            };
            console.log(`RECOVERY_RESULT ${JSON.stringify({ fault, last, flowing, heard })}`);
            await page.screenshot({ path: testInfo.outputPath("after-fault.png") });
            if (renewalCycleFaults.includes(fault)) {
                // Nobody left, so nobody may vanish from the call or be announced as leaving at any point.
                const before = samples[0];
                const gaps = samples
                    .filter((sample) => sample.seconds >= 0)
                    .filter(
                        (sample) =>
                            sample.alice.own !== 1 ||
                            sample.alice.members.length !== 2 ||
                            sample.bob.own !== 1 ||
                            sample.bob.members.length !== 2,
                    )
                    .map((sample) => sample.seconds);
                const cues = {
                    alice: last.alice.sounds.slice(before.alice.sounds.length),
                    bob: last.bob.sounds.slice(before.bob.sounds.length),
                };
                console.log(`RENEWAL_RESULT ${JSON.stringify({ fault, gaps, cues })}`);
                expect.soft(gaps, `participants vanished during ${fault}`).toEqual([]);
                expect.soft(cues, `cues played during ${fault}`).toEqual({ alice: [], bob: [] });
            }
            // Once the fault is gone the call must come back on its own: own tile, and audio in both directions.
            expect
                .soft(
                    last.alice.own === 1 &&
                        last.alice.phase === "in_call" &&
                        last.alice.tiles.some((text) => text.includes("Alice")) &&
                        last.bob.tiles.some((text) => text.includes("Alice") && !text.includes("Connecting")) &&
                        flowing.alice &&
                        flowing.bob,
                    `Alice did not recover after ${fault}`,
                )
                .toBe(true);
            if (last.alice.phase !== "in_call" || !last.alice.own || !flowing.alice || !flowing.bob) {
                for (const clientApp of [app, ...(last.bob.phase !== "in_call" || !last.bob.own ? [bobApp] : [])]) {
                    const stage = clientApp.page.getByTestId("aether-call-stage").filter({ visible: true });
                    await stage.getByTestId("incall_leave").click();
                    await openCall(clientApp.page, roomId);
                }
                await expect.poll(async () => (await measure(app, roomId)).own, { timeout: 30_000 }).toBe(1);
                await expect.poll(() => audioFlowing(app, roomId), { timeout: 30_000 }).toBe(true);
                await expect.poll(() => audioFlowing(bobApp, roomId), { timeout: 30_000 }).toBe(true);
                manuallyRecovered = true;
                console.log(`MANUAL_RECOVERY ${fault}: leave/rejoin restored both audio directions`);
            }
        } finally {
            if (paused) await run("docker", ["unpause", matrixRTCBackend!.livekit.getId()]);
            await writeFile(
                testInfo.outputPath("recovery-samples.json"),
                JSON.stringify({ fault, samples, manuallyRecovered }, null, 2),
            );
            await writeFile(testInfo.outputPath("call-lifecycle.log"), logs.join("\n"));
            await writeFile(testInfo.outputPath("bob-call-lifecycle.log"), bobLogs.join("\n"));
            await testInfo.attach("recovery-samples", {
                body: JSON.stringify({ fault, samples, manuallyRecovered }, null, 2),
                contentType: "application/json",
            });
            await testInfo.attach("call-lifecycle", { body: logs.join("\n"), contentType: "text/plain" });
            page.off("console", onConsole);
            for (const bobPage of context.pages()) bobPage.off("console", onBobConsole);
            await context.close();
        }
    });
}
