/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { _electron as electron, type ConsoleMessage, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
    buildConfigJson,
    closeReleaseAnnouncementIfExists,
    populateLocalStorageWithCredentials,
    rejectToastIfExists,
    routeConfigJson,
} from "@element-hq/element-web-playwright-common";

import { test, expect } from "../../element-web-test";
import { ElementAppPage } from "../../pages/ElementAppPage";
import { SettingLevel } from "../../../src/settings/SettingLevel";

const run = promisify(execFile);
// Native input needs an interactive X11 display (XWayland is sufficient), xdotool, and a built desktop host.
// This deliberately selects X11; Wayland portal activation requires compositor-approved physical input.
test.skip(!process.env.AETHER_NATIVE_SHORTCUT_SMOKE || process.platform !== "linux", "Opt-in native X11 smoke");
test.use({
    displayName: "Alice",
    matrixRTC: true,
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

async function settle(page: Page): Promise<void> {
    await rejectToastIfExists(page, "Verify this device");
    await rejectToastIfExists(page, "Notifications");
    await closeReleaseAnnouncementIfExists(page, "Introducing Sections");
}

function collectCallLogs(page: Page, member: string, logs: string[]): () => void {
    const onConsole = (message: ConsoleMessage): void => {
        if (["error", "warning"].includes(message.type())) logs.push(`${member} ${message.type()}: ${message.text()}`);
    };
    const onError = (error: Error): void => {
        logs.push(`${member} pageerror: ${error.message}`);
    };
    page.on("console", onConsole);
    page.on("pageerror", onError);
    return () => {
        page.off("console", onConsole);
        page.off("pageerror", onError);
    };
}

async function energyDelta(page: Page): Promise<number> {
    return page.evaluate(async () => {
        const energy = async (): Promise<number> => {
            const peers = (window as Window & { __shortcutPeers?: RTCPeerConnection[] }).__shortcutPeers ?? [];
            let total = 0;
            for (const peer of peers) {
                (await peer.getStats()).forEach((entry) => {
                    if (entry.type === "inbound-rtp" && entry.kind === "audio") total += entry.totalAudioEnergy ?? 0;
                });
            }
            return total;
        };
        const before = await energy();
        await new Promise((resolve) => setTimeout(resolve, 500));
        return (await energy()) - before;
    });
}

test("global holds control the actual transmitted microphone while another window has focus", async ({
    credentials,
    homeserver,
    config,
    browser,
}, testInfo) => {
    test.setTimeout(180_000);
    const logs: string[] = [];
    const cleanups: Array<() => void> = [];
    const profile = await mkdtemp(path.join(tmpdir(), "aether-shortcut-call-"));
    const configPath = path.join(profile, "config.json");
    await writeFile(configPath, JSON.stringify(buildConfigJson(homeserver.baseUrl, config)), { mode: 0o600 });
    const requireDesktop = createRequire(new URL("../../../../desktop/package.json", import.meta.url));
    const env: Record<string, string> = { XDG_SESSION_TYPE: "x11" };
    for (const [key, value] of Object.entries(process.env)) {
        if (!["ELECTRON_RUN_AS_NODE", "WAYLAND_DISPLAY", "XDG_SESSION_TYPE"].includes(key) && value !== undefined)
            env[key] = value;
    }
    const desktop = await electron.launch({
        executablePath: requireDesktop("electron"),
        args: [
            fileURLToPath(new URL("../../../../desktop/lib/electron-main.js", import.meta.url)),
            "--profile-dir",
            profile,
            "--config",
            configPath,
            "--ozone-platform=x11",
            "--use-fake-ui-for-media-stream",
            "--use-fake-device-for-media-stream",
            "--mute-audio",
        ],
        env,
    });
    const bobContext = await browser.newContext({ baseURL: testInfo.project.use.baseURL, permissions: ["microphone"] });
    try {
        const page = await desktop.firstWindow();
        cleanups.push(collectCallLogs(page, "Alice", logs));
        await populateLocalStorageWithCredentials(page, credentials);
        await page.reload();
        await expect(page.locator(".mx_MatrixChat")).toBeVisible({ timeout: 60_000 });
        await settle(page);
        const app = new ElementAppPage(page);
        await app.settings.setValue("desktopPushToTalkKey", null, SettingLevel.DEVICE, "Control+Shift+KeyV");
        await app.settings.setValue("desktopPushToTalkReleaseDelay", null, SettingLevel.DEVICE, 0);
        await app.settings.setValue("desktopInputMode", null, SettingLevel.DEVICE, "push_to_talk");
        // The fake microphone's beep is not speech, so noise suppression would keep it out of the call.
        await app.settings.setValue("desktopInputProfile", null, SettingLevel.DEVICE, "custom");
        await app.settings.setValue("desktopNoiseSuppression", null, SettingLevel.DEVICE, "none");
        await app.settings.setValue("desktopShortcutBindings", null, SettingLevel.DEVICE, {
            push_to_mute: "Control+Shift+KeyB",
            toggle_mute: "Control+Shift+KeyM",
        });
        await page.getByRole("button", { name: "All settings", exact: true }).click();
        await page.getByRole("dialog").getByText("Keyboard", { exact: true }).click();
        const keybinds = page.getByRole("region", { name: "Keybinds" });
        await expect(keybinds.getByText("Available across applications", { exact: true })).toHaveCount(3);
        for (const theme of ["dark", "light"] as const) {
            await app.settings.setValue("theme", null, SettingLevel.DEVICE, theme);
            await expect(page.locator("body")).toHaveClass(new RegExp(`cpd-theme-${theme}`));
            await keybinds.screenshot({ path: testInfo.outputPath(`native-keybinds-${theme}.png`) });
        }
        await page.keyboard.press("Escape");
        const bob = await homeserver.registerUser("bob-shortcuts", "password", "Bob");
        const roomId = await app.client.createRoom({
            name: "Shortcut studio",
            invite: [bob.userId],
            creation_content: { type: "org.matrix.msc3417.call" },
            // Match createRoom.ts: members can announce their calls and media has Matrix E2EE enabled.
            power_level_content_override: { events: { "org.matrix.msc3401.call.member": 0 } },
            initial_state: [
                { type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } },
            ],
        });
        await homeserver.csApi.request("POST", `/v3/join/${roomId}`, bob.accessToken, {});
        const bobPage = await bobContext.newPage();
        cleanups.push(collectCallLogs(bobPage, "Bob", logs));
        await routeConfigJson(bobContext, homeserver.baseUrl, config);
        await populateLocalStorageWithCredentials(bobPage, bob);
        await bobPage.addInitScript(() => {
            const peers: RTCPeerConnection[] = [];
            Object.defineProperty(window, "__shortcutPeers", { value: peers });
            const Original = window.RTCPeerConnection;
            window.RTCPeerConnection = class extends Original {
                public constructor(configuration?: RTCConfiguration) {
                    super(configuration);
                    peers.push(this);
                }
            };
        });
        await page.evaluate((id) => {
            window.location.hash = `/room/${id}`;
        }, roomId);
        await bobPage.goto(`/#/room/${roomId}`);
        await settle(bobPage);
        for (const member of [page, bobPage]) {
            await expect(member.getByText("Voice Connected", { exact: true })).toBeVisible({ timeout: 60_000 });
            await expect(member.getByTestId("videoTile").first()).toBeVisible({ timeout: 30_000 });
        }
        await expect
            .poll(
                () =>
                    bobPage.evaluate(async () => {
                        const peers =
                            (window as Window & { __shortcutPeers?: RTCPeerConnection[] }).__shortcutPeers ?? [];
                        let bytes = 0;
                        for (const peer of peers)
                            (await peer.getStats()).forEach((entry) => {
                                if (entry.type === "inbound-rtp" && entry.kind === "audio")
                                    bytes += entry.bytesReceived ?? 0;
                            });
                        return bytes;
                    }),
                { timeout: 30_000 },
            )
            .toBeGreaterThan(0);
        await desktop.evaluate(async ({ BrowserWindow }) => {
            const owner = BrowserWindow.getAllWindows()[0];
            const other = new BrowserWindow({ width: 400, height: 200 });
            await other.loadURL("data:text/html,<title>Disposable shortcut input</title><p>Shortcut test input</p>");
            owner.hide();
            other.show();
            other.focus();
        });
        await expect
            .poll(() =>
                desktop.evaluate(({ BrowserWindow }) => {
                    const windows = BrowserWindow.getAllWindows();
                    return (
                        !windows.find((window) => window.webContents.getURL().startsWith("vector:"))?.isFocused() &&
                        BrowserWindow.getFocusedWindow()?.getTitle() === "Disposable shortcut input"
                    );
                }),
            )
            .toBe(true);
        await expect.poll(() => energyDelta(bobPage), { timeout: 15_000 }).toBeLessThan(0.000001);
        await run("xdotool", ["keydown", "ctrl", "keydown", "shift", "keydown", "v"]);
        await expect.poll(() => energyDelta(bobPage), { timeout: 15_000 }).toBeGreaterThan(0.000001);
        await run("xdotool", ["keydown", "b"]);
        await expect.poll(() => energyDelta(bobPage), { timeout: 15_000 }).toBeLessThan(0.000001);
        await run("xdotool", ["keyup", "b"]);
        await expect.poll(() => energyDelta(bobPage), { timeout: 15_000 }).toBeGreaterThan(0.000001);
        await run("xdotool", ["keyup", "ctrl+shift+v"]);
        await expect.poll(() => energyDelta(bobPage), { timeout: 15_000 }).toBeLessThan(0.000001);
        await run("xdotool", ["key", "ctrl+shift+m"]);
        await expect(
            page.getByRole("group", { name: "User menu" }).getByRole("button", { name: "Unmute", exact: true }),
        ).toBeVisible();
        await run("xdotool", ["keydown", "ctrl+shift+v"]);
        await expect.poll(() => energyDelta(bobPage), { timeout: 15_000 }).toBeLessThan(0.000001);
        await run("xdotool", ["keyup", "ctrl+shift+v"]);
        await run("xdotool", ["key", "ctrl+shift+m"]);
        await expect(
            page.getByRole("group", { name: "User menu" }).getByRole("button", { name: "Mute", exact: true }),
        ).toBeVisible();
        await run("xdotool", ["keydown", "ctrl+shift+v"]);
        await expect.poll(() => energyDelta(bobPage), { timeout: 15_000 }).toBeGreaterThan(0.000001);
        await run("xdotool", ["keyup", "ctrl+shift+v"]);
        await expect.poll(() => energyDelta(bobPage), { timeout: 15_000 }).toBeLessThan(0.000001);
    } finally {
        for (const cleanup of cleanups) cleanup();
        await writeFile(testInfo.outputPath("native-call-console.log"), logs.join("\n"));
        await testInfo.attach("native-call-console", { body: logs.join("\n"), contentType: "text/plain" });
        await run("xdotool", ["keyup", "b", "v", "m", "ctrl", "shift"]).catch(() => {});
        await bobContext.close();
        await desktop.close();
        await rm(profile, { recursive: true, force: true });
    }
});
