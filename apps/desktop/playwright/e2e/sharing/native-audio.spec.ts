/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { _electron as electron, test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Separate applications ensure process-tree capture can distinguish the shared app from the call host.
const fixture = `
const { app, BrowserWindow } = require("electron");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.whenReady().then(async () => {
    globalThis.audioModule = await import(process.env.AETHER_AUDIO_MODULE);
    const window = new BrowserWindow({ webPreferences: { nodeIntegration: false } });
    globalThis.audioSourceWindow = window;
    await window.loadURL("data:text/html,<title>Audio capture test</title>");
});
`;

for (const kind of ["screen", "window"] as const) {
    test(`native ${kind} capture contains the shared application tone and excludes the call host`, async () => {
        test.skip(process.platform !== "win32" && process.platform !== "linux");
        test.skip(
            !!process.env.ELEMENT_DESKTOP_EXECUTABLE,
            "Native backend tests require a local desktop TypeScript build",
        );
        // Two Electron startups and shutdowns need headroom on developer machines as well as CI.
        test.setTimeout(90_000);
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aether-native-audio-"));
        const entry = path.join(directory, "main.cjs");
        await fs.writeFile(entry, fixture);
        const env = { ...process.env };
        delete env.ELECTRON_RUN_AS_NODE;
        if (process.platform === "linux") env.XDG_SESSION_TYPE = "x11";
        env.AETHER_AUDIO_MODULE = pathToFileURL(path.resolve("lib/desktop-audio.js")).href;
        const args = [entry, "--disable-gpu", "--ozone-platform=x11"];
        const target = await test.step("Launch the source application", () =>
            electron.launch({
                env,
                args: [...args, `--user-data-dir=${path.join(directory, "target")}`],
            }));
        const host = await test.step("Launch the capturing application", () =>
            electron.launch({ env, args: [...args, `--user-data-dir=${path.join(directory, "host")}`] }));
        try {
            const targetPage = await target.firstWindow();
            const hostPage = await host.firstWindow();
            const play = async (page: typeof targetPage, frequency: number): Promise<void> => {
                await page.evaluate(async (frequency) => {
                    const context = new AudioContext({ sampleRate: 48000 });
                    const oscillator = context.createOscillator();
                    const gain = context.createGain();
                    oscillator.frequency.value = frequency;
                    gain.gain.value = 0.01;
                    oscillator.connect(gain).connect(context.destination);
                    oscillator.start();
                    await context.resume();
                    Object.assign(globalThis, { testAudio: { context, oscillator } });
                }, frequency);
            };
            await play(targetPage, 440);
            await play(hostPage, 880);
            const handle = await target.evaluate(({ BrowserWindow }) => {
                const bytes = BrowserWindow.getAllWindows()[0].getNativeWindowHandle();
                return bytes.length === 8 ? Number(bytes.readBigUInt64LE()) : bytes.readUInt32LE();
            });
            await test.step("Start native audio capture", () =>
                host.evaluate(
                    async ({ BrowserWindow }, { handle, kind }) => {
                        const { DesktopAudioCapture } = (
                            globalThis as unknown as {
                                audioModule: typeof import("../../../src/desktop-audio.js");
                            }
                        ).audioModule;
                        const contents = BrowserWindow.getAllWindows()[0].webContents;
                        const state = { peak: 0, packets: 0, energy440: 0, energy880: 0 };
                        // Observe production PCM packets before IPC delivery, without stubbing the native backend.
                        const send = contents.send.bind(contents);
                        contents.send = (
                            channel: string,
                            packet: { data: Uint8Array; channels: number; isFloat: boolean },
                        ) => {
                            if (channel === "aether:desktop-audio-data") {
                                state.packets++;
                                const view = new DataView(
                                    packet.data.buffer,
                                    packet.data.byteOffset,
                                    packet.data.byteLength,
                                );
                                const samples = packet.data.byteLength / 4 / packet.channels;
                                let real440 = 0,
                                    imaginary440 = 0,
                                    real880 = 0,
                                    imaginary880 = 0;
                                for (let frame = 0; frame < samples; frame++) {
                                    const sample = view.getFloat32(frame * 4 * packet.channels, true);
                                    state.peak = Math.max(state.peak, Math.abs(sample));
                                    real440 += sample * Math.cos((2 * Math.PI * 440 * frame) / 48000);
                                    imaginary440 += sample * Math.sin((2 * Math.PI * 440 * frame) / 48000);
                                    real880 += sample * Math.cos((2 * Math.PI * 880 * frame) / 48000);
                                    imaginary880 += sample * Math.sin((2 * Math.PI * 880 * frame) / 48000);
                                }
                                state.energy440 += real440 ** 2 + imaginary440 ** 2;
                                state.energy880 += real880 ** 2 + imaginary880 ** 2;
                            } else send(channel, packet);
                        };
                        const capture = new DesktopAudioCapture(contents);
                        capture.select(kind === "window" ? `window:${handle}:0` : "screen:0:0", true);
                        capture.start("native-test");
                        Object.assign(globalThis, { nativeAudioTest: { capture, state } });
                    },
                    { handle, kind },
                ));
            const result = () =>
                host.evaluate(
                    () =>
                        (
                            globalThis as unknown as {
                                nativeAudioTest: {
                                    state: { peak: number; packets: number; energy440: number; energy880: number };
                                };
                            }
                        ).nativeAudioTest.state,
                );
            await expect.poll(async () => (await result()).peak).toBeGreaterThan(0.001);
            await expect.poll(async () => (await result()).packets).toBeGreaterThan(20);
            const measured = await result();
            expect(measured.energy440).toBeGreaterThan(measured.energy880 * 10);
            await test.step("Stop native audio capture", () =>
                host.evaluate(() => {
                    const state = globalThis as unknown as {
                        nativeAudioTest: { capture: { stop: (id: string) => void } };
                    };
                    state.nativeAudioTest.capture.stop("native-test");
                }));
        } finally {
            await Promise.all([host.close(), target.close()]);
            await fs.rm(directory, { recursive: true, force: true });
        }
    });
}
