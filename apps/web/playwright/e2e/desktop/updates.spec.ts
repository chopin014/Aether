/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type DesktopUpdateState } from "shared-types";
import { type Locator, type Page } from "@playwright/test";
import {
    buildConfigJson,
    closeReleaseAnnouncementIfExists,
    rejectToastIfExists,
} from "@element-hq/element-web-playwright-common";

import { test, expect } from "../../element-web-test";
import { SettingLevel } from "../../../src/settings/SettingLevel";

declare global {
    interface Window {
        updateTest: {
            emit: (state: DesktopUpdateState) => void;
            checks: number;
            restarts: number;
        };
    }
}

test.use({
    displayName: "Alice",
    config: { default_theme: "dark", features: { feature_desktop_shell: true } },
});

test.beforeEach(async ({ pageWithCredentials: page, homeserver, config }) => {
    // Exercise the actual Electron platform bridge, substituting only the native process.
    await page.addInitScript(
        (desktopConfig) => {
            const listeners = new Map<string, Array<(event: Event, ...args: unknown[]) => void>>();
            let state: DesktopUpdateState = { status: "idle", currentVersion: "0.1.0" };
            const emit = (channel: string, payload: unknown): void => {
                for (const listener of listeners.get(channel) ?? []) listener(new Event(channel), payload);
            };
            const controls = {
                checks: 0,
                restarts: 0,
                emit: (next: DesktopUpdateState): void => {
                    state = next;
                    emit("aether:update-state", state);
                },
            };
            window.updateTest = controls;
            const electron = {
                on: (channel: string, listener: (event: Event, ...args: unknown[]) => void) => {
                    listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
                },
                send: (channel: string, ...args: unknown[]) => {
                    if (channel === "check_updates") {
                        controls.checks++;
                        controls.emit({ status: "checking", currentVersion: state.currentVersion });
                    } else if (channel === "install_update") {
                        controls.restarts++;
                    } else if (channel === "ipcCall" || channel === "seshat") {
                        const request = args[0] as { id: number; name: string };
                        const values: Record<string, unknown> = {
                            getAppVersion: state.currentVersion,
                            getUpdateFeedUrl: "https://github.com/chopin014/Aether/releases",
                            getDesktopUpdateState: state,
                            supportsEventIndexing: false,
                        };
                        queueMicrotask(() =>
                            emit(channel === "ipcCall" ? "ipcReply" : "seshatReply", {
                                id: request.id,
                                reply: values[request.name] ?? null,
                            }),
                        );
                    }
                },
                initialise: async () => ({
                    protocol: "aether",
                    sessionId: "update-test",
                    supportsBadgeOverlay: false,
                    config: desktopConfig,
                    supportedSettings: {},
                }),
                setSettingValue: async () => {},
                getSettingValue: async () => false,
            };
            Object.assign(window, { electron });
        },
        buildConfigJson(homeserver.baseUrl, { ...config, brand: "Aether" }),
    );
    await page.goto("/");
    await expect(page.locator(".mx_MatrixChat")).toBeVisible();
    await closeReleaseAnnouncementIfExists(page, "Introducing Sections");
    await rejectToastIfExists(page, "Verify this device");
    await rejectToastIfExists(page, "Notifications");
});

async function openUpdates(page: Page): Promise<Locator> {
    await page.getByRole("button", { name: "All settings", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("tab", { name: "Updates", exact: true }).click();
    await expect(dialog.getByRole("heading", { name: "Updates", level: 2, exact: true })).toBeVisible();
    return dialog;
}

async function setUpdateState(page: Page, state: DesktopUpdateState): Promise<void> {
    await page.evaluate((next) => window.updateTest.emit(next), state);
}

test("checks manually, retains background download progress, and restarts only on request", async ({
    page,
    app,
}, testInfo) => {
    let dialog = await openUpdates(page);
    await expect(dialog.getByText("0.1.0", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Check for updates", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.updateTest.checks)).toBe(1);
    await expect(dialog.getByRole("button", { name: /Checking/ })).toBeDisabled();

    await setUpdateState(page, { status: "idle", currentVersion: "0.1.0", lastChecked: Date.now() });
    await expect(dialog.getByText("Aether is up to date.", { exact: true })).toBeVisible();

    await page.keyboard.press("Escape");
    await setUpdateState(page, { status: "downloading", currentVersion: "0.1.0", version: "0.1.1", percent: 42 });
    dialog = await openUpdates(page);
    await expect(dialog.getByRole("progressbar", { name: "Download progress" })).toHaveAttribute("value", "42");
    await dialog.screenshot({ path: testInfo.outputPath("updates-downloading-dark.png") });
    await expect.poll(() => page.evaluate(() => window.updateTest.restarts)).toBe(0);

    await setUpdateState(page, { status: "ready", currentVersion: "0.1.0", version: "0.1.1", percent: 100 });
    await expect(dialog.getByRole("button", { name: "Restart to update", exact: true })).toBeEnabled();
    await dialog.screenshot({ path: testInfo.outputPath("updates-ready-dark.png") });
    await app.settings.setValue("theme", null, SettingLevel.DEVICE, "light");
    await expect(page.locator("body")).toHaveClass(/cpd-theme-light/);
    await dialog.screenshot({ path: testInfo.outputPath("updates-ready-light.png") });
    await page.setViewportSize({ width: 800, height: 640 });
    await expect.poll(() => dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await dialog.screenshot({ path: testInfo.outputPath("updates-ready-narrow.png") });
    await dialog.getByRole("button", { name: "Restart to update", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.updateTest.restarts)).toBe(1);
});

test("defers the ready prompt while keeping the downloaded update available in settings", async ({ page }) => {
    await setUpdateState(page, { status: "ready", currentVersion: "0.1.0", version: "0.1.1", percent: 100 });
    await page.getByRole("button", { name: "Later", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.updateTest.restarts)).toBe(0);
    const dialog = await openUpdates(page);
    await expect(dialog.getByRole("button", { name: "Restart to update", exact: true })).toBeEnabled();
});

test("recovers from errors and explains manual updates for unsupported installs", async ({ page }) => {
    const dialog = await openUpdates(page);
    await setUpdateState(page, { status: "error", currentVersion: "0.1.0" });
    await expect(dialog.getByRole("alert")).toBeVisible();
    await dialog.getByRole("button", { name: "Try again", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.updateTest.checks)).toBe(1);

    await setUpdateState(page, { status: "unsupported", currentVersion: "0.1.0", reason: "package" });
    await expect(dialog.getByRole("link", { name: "Download the latest release" })).toHaveAttribute(
        "href",
        "https://github.com/chopin014/Aether/releases/latest",
    );
    await expect(dialog.getByRole("button", { name: "Check for updates" })).toHaveCount(0);
});
