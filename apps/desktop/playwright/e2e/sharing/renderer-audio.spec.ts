/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { _electron as electron } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

import { test, expect } from "../../element-desktop-test.js";

test.use({
    // The shared fixture already supplies storage mode and GPU flags on GitHub Actions.
    extraArgs: process.env.GITHUB_ACTIONS ? [] : ["--storage-mode", "force-plaintext", "--disable-gpu"],
    extraEnv: async ({ tmpDir }, use) => {
        const configPath = path.join(tmpDir, "audio-config.json");
        await fs.writeFile(configPath, JSON.stringify({ brand: "Aether", features: { feature_desktop_shell: true } }));
        await use({ ELEMENT_DESKTOP_CONFIG_JSON: configPath });
    },
});

for (const kind of ["window", "screen"] as const) {
    for (const includeAudio of [true, false]) {
        test(`native ${kind} picker ${includeAudio ? "with" : "without"} audio reaches a WebRTC receiver`, async ({
            app,
            page,
            tmpDir,
        }) => {
            test.setTimeout(90_000);
            const entry = path.join(tmpDir, "tone.cjs");
            await fs.writeFile(
                entry,
                `const { app, BrowserWindow } = require("electron");
        app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
        app.whenReady().then(async () => {
            const window = new BrowserWindow();
            await window.loadURL("data:text/html,<title>Aether audio source</title>");
        });`,
            );
            const env = { ...process.env };
            delete env.ELECTRON_RUN_AS_NODE;
            const target = await electron.launch({
                env,
                args: [entry, `--user-data-dir=${path.join(tmpDir, "tone")}`],
            });
            try {
                await page.evaluate(() =>
                    localStorage.setItem("mx_local_settings", JSON.stringify({ language: "en" })),
                );
                await page.reload();
                const source = await target.firstWindow();
                await source.evaluate(async () => {
                    const context = new AudioContext({ sampleRate: 48000 });
                    const oscillator = context.createOscillator();
                    const gain = context.createGain();
                    oscillator.frequency.value = 440;
                    gain.gain.value = 0.01;
                    oscillator.connect(gain).connect(context.destination);
                    oscillator.start();
                    await context.resume();
                    Object.assign(globalThis, { testAudio: context });
                });
                await expect(page.getByRole("heading", { name: "Welcome to Aether" })).toBeVisible();
                const capture = page.evaluate(async () => {
                    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
                    Object.assign(globalThis, { capturedStream: stream });
                    return stream.getTracks().map((track) => ({ kind: track.kind, state: track.readyState }));
                });
                const picker = page.getByRole("dialog", { name: "Share your screen" });
                await expect(picker).toBeVisible();
                if (kind === "screen") {
                    const screen = await app.evaluate(
                        async ({ desktopCapturer }) =>
                            (await desktopCapturer.getSources({ types: ["screen"] }))[0].name,
                    );
                    await picker.getByRole("tab", { name: "Entire screen", exact: true }).click();
                    await picker.getByRole("button", { name: screen, exact: true }).click();
                } else await picker.getByRole("button", { name: "Aether audio source", exact: true }).click();
                await picker.getByRole("button", { name: "Next", exact: true }).click();
                await picker.getByRole("checkbox", { name: "Share System Audio" }).setChecked(includeAudio);
                await picker.getByRole("button", { name: "Share", exact: true }).click();
                expect(await capture).toEqual([
                    ...(includeAudio ? [{ kind: "audio", state: "live" }] : []),
                    { kind: "video", state: "live" },
                ]);
                const offer = await page.evaluate(async () => {
                    const { capturedStream } = globalThis as unknown as { capturedStream: MediaStream };
                    const peer = new RTCPeerConnection();
                    for (const track of capturedStream.getTracks()) peer.addTrack(track, capturedStream);
                    await peer.setLocalDescription(await peer.createOffer());
                    await new Promise<void>((resolve) => {
                        if (peer.iceGatheringState === "complete") resolve();
                        else
                            peer.addEventListener("icegatheringstatechange", () => {
                                if (peer.iceGatheringState === "complete") resolve();
                            });
                    });
                    Object.assign(globalThis, { sendingPeer: peer });
                    return peer.localDescription!.toJSON();
                });
                const answer = await source.evaluate(async (offer) => {
                    const context = new AudioContext();
                    const analyser = context.createAnalyser();
                    analyser.fftSize = 8192;
                    const peer = new RTCPeerConnection();
                    peer.addEventListener("track", ({ track }) => {
                        if (track.kind === "audio")
                            context.createMediaStreamSource(new MediaStream([track])).connect(analyser);
                        else {
                            const video = document.createElement("video");
                            video.srcObject = new MediaStream([track]);
                            video.autoplay = true;
                            video.muted = true;
                            document.body.appendChild(video);
                        }
                    });
                    await context.resume();
                    await peer.setRemoteDescription(offer);
                    await peer.setLocalDescription(await peer.createAnswer());
                    await new Promise<void>((resolve) => {
                        if (peer.iceGatheringState === "complete") resolve();
                        else
                            peer.addEventListener("icegatheringstatechange", () => {
                                if (peer.iceGatheringState === "complete") resolve();
                            });
                    });
                    Object.assign(globalThis, { audioProbe: { context, analyser, peer } });
                    return peer.localDescription!.toJSON();
                }, offer);
                await page.evaluate(async (answer) => {
                    const { sendingPeer } = globalThis as unknown as { sendingPeer: RTCPeerConnection };
                    await sendingPeer.setRemoteDescription(answer);
                }, answer);
                await expect
                    .poll(() =>
                        source.evaluate(async () => {
                            const { audioProbe } = globalThis as unknown as { audioProbe: { peer: RTCPeerConnection } };
                            let frames = 0;
                            for (const stat of (await audioProbe.peer.getStats()).values()) {
                                if (stat.type === "inbound-rtp" && stat.kind === "video")
                                    frames += stat.framesDecoded ?? 0;
                            }
                            return frames;
                        }),
                    )
                    .toBeGreaterThan(0);
                if (!includeAudio) {
                    expect(
                        await source.evaluate(() => {
                            const { audioProbe } = globalThis as unknown as { audioProbe: { peer: RTCPeerConnection } };
                            return audioProbe.peer.getReceivers().filter(({ track }) => track.kind === "audio").length;
                        }),
                    ).toBe(0);
                    return;
                }
                await expect
                    .poll(() =>
                        source.evaluate(async () => {
                            const { audioProbe } = globalThis as unknown as {
                                audioProbe: { peer: RTCPeerConnection };
                            };
                            let energy = 0;
                            for (const stat of (await audioProbe.peer.getStats()).values()) {
                                if (stat.type === "inbound-rtp" && stat.kind === "audio")
                                    energy += stat.totalAudioEnergy ?? 0;
                            }
                            return energy;
                        }),
                    )
                    .toBeGreaterThan(0);
                await expect
                    .poll(() =>
                        source.evaluate(() => {
                            const { audioProbe } = globalThis as unknown as { audioProbe: { analyser: AnalyserNode } };
                            const frequencies = new Float32Array(audioProbe.analyser.frequencyBinCount);
                            audioProbe.analyser.getFloatFrequencyData(frequencies);
                            const bin = Math.round(
                                (440 * audioProbe.analyser.fftSize) / audioProbe.analyser.context.sampleRate,
                            );
                            return Math.max(...frequencies.slice(bin - 1, bin + 2));
                        }),
                    )
                    .toBeGreaterThan(-65);
            } finally {
                await page.evaluate(() => {
                    const state = globalThis as unknown as {
                        capturedStream?: MediaStream;
                        sendingPeer?: RTCPeerConnection;
                    };
                    for (const track of state.capturedStream?.getTracks() ?? []) track.stop();
                    state.sendingPeer?.close();
                });
                await target.close();
            }
        });
    }
}
