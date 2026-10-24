/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { closeReleaseAnnouncementIfExists, rejectToastIfExists } from "@element-hq/element-web-playwright-common";
import type { Locator, Page } from "@playwright/test";

import { test, expect } from "../../element-web-test";

test.use({
    displayName: "Alice",
    lockLeftPanelWidth: false,
    config: {
        default_theme: "dark",
        features: { feature_desktop_shell: true, feature_video_rooms: true, feature_element_call_video_rooms: true },
        element_call: { disable: false, use_exclusively: true },
    },
});

test.beforeEach(async ({ pageWithCredentials: page }) => {
    // Remember every stream and every sound the page opens, so the tests can check they are used and released.
    await page.addInitScript(() => {
        const win = window as unknown as { __streams: MediaStream[]; __sounds: string[] };
        win.__streams = [];
        win.__sounds = [];
        const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async (constraints) => {
            const stream = await getUserMedia(constraints);
            win.__streams.push(stream);
            return stream;
        };
        const play = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function (this: HTMLMediaElement): Promise<void> {
            if (this.src.endsWith(".wav")) win.__sounds.push(this.src);
            return play.call(this);
        };
    });
    await page.goto("/");
    await expect(page.locator(".mx_MatrixChat")).toBeVisible();
});

/** Closes the toasts that may be on screen, which depend on the homeserver and are not what is being tested. */
async function dismissToasts(page: Page): Promise<void> {
    await closeReleaseAnnouncementIfExists(page, "Introducing Sections");
    for (const title of ["Verify this device", "Notifications"]) {
        await rejectToastIfExists(page, title);
    }
}

/** Opens Settings → Voice & Video from the account dock, like a user would. */
async function openVoiceVideo(page: Page): Promise<Locator> {
    await dismissToasts(page);
    const account = page.getByRole("group", { name: "User menu" });
    await account.getByRole("button", { name: "User menu", exact: true }).hover();
    await account.getByRole("button", { name: "All settings" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator(".mx_TabbedView_tabLabel", { hasText: "Voice & Video" }).click();
    await expect(dialog.getByRole("heading", { level: 2, name: "Voice", exact: true })).toBeVisible();
    return dialog;
}

const liveTracks = (page: Page): Promise<number> =>
    page.evaluate(
        () =>
            (window as unknown as { __streams: MediaStream[] }).__streams
                .flatMap((stream) => stream.getTracks())
                .filter((track) => track.readyState === "live").length,
    );

test.describe("Voice & Video settings in the desktop shell", () => {
    test("lists the sections under the tab and scrolls to them", async ({ page }) => {
        const dialog = await openVoiceVideo(page);
        const links = dialog.locator(".mx_TabbedView_anchors");
        for (const name of ["Voice", "Video", "Sounds", "Advanced"]) {
            await expect(links.getByRole("button", { name, exact: true })).toBeVisible();
        }
        await expect(links.getByRole("button", { name: "Voice", exact: true })).toHaveAttribute(
            "aria-current",
            "location",
        );
        await links.getByRole("button", { name: "Sounds", exact: true }).click();
        await expect(dialog.getByRole("heading", { level: 2, name: "Sounds", exact: true })).toBeInViewport();
        await expect(links.getByRole("button", { name: "Sounds", exact: true })).toHaveAttribute(
            "aria-current",
            "location",
        );
    });

    test("offers no noise suppression, Krisp or OpenH264", async ({ page }) => {
        const dialog = await openVoiceVideo(page);
        await expect(dialog.getByText(/noise suppression|krisp|voice isolation|openh264/i)).toHaveCount(0);
    });

    test("tests the microphone with a live meter and releases it when stopped", async ({ page }) => {
        const dialog = await openVoiceVideo(page);
        const meter = dialog.getByRole("meter", { name: "Microphone level" });
        await expect(meter).toHaveAttribute("aria-valuenow", "-100");

        await dialog.getByRole("button", { name: "Let's check" }).click();
        await expect(dialog.getByRole("button", { name: "Stop testing" })).toBeVisible();
        await expect.poll(() => liveTracks(page)).toBeGreaterThan(0);
        // Chromium's fake microphone beeps, so the level moves above silence.
        await expect
            .poll(async () => Number(await meter.getAttribute("aria-valuenow")), { timeout: 15_000 })
            .toBeGreaterThan(-100);

        await dialog.getByRole("button", { name: "Stop testing" }).click();
        await expect(meter).toHaveAttribute("aria-valuenow", "-100");
        await expect.poll(() => liveTracks(page)).toBe(0);
    });

    test("releases the microphone when the settings are closed during a test", async ({ page }) => {
        const dialog = await openVoiceVideo(page);
        await dialog.getByRole("button", { name: "Let's check" }).click();
        await expect(dialog.getByRole("button", { name: "Stop testing" })).toBeVisible();
        await expect.poll(() => liveTracks(page)).toBeGreaterThan(0);
        await page.keyboard.press("Escape");
        await expect(page.getByRole("dialog")).not.toBeVisible();
        await expect.poll(() => liveTracks(page)).toBe(0);
    });

    test("previews the camera and releases it when stopped", async ({ page }) => {
        const dialog = await openVoiceVideo(page);
        await dialog.getByRole("button", { name: "Test video" }).click();
        const video = dialog.getByLabel("Camera preview");
        await expect(video).toBeVisible();
        await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.videoWidth)).toBeGreaterThan(0);
        await dialog.getByRole("button", { name: "Stop test" }).click();
        await expect(video).toHaveCount(0);
        await expect.poll(() => liveTracks(page)).toBe(0);
    });

    test("switching input profiles updates the processing switches", async ({ page }) => {
        const dialog = await openVoiceVideo(page);
        const echo = dialog.getByRole("switch", { name: "Echo cancellation" });
        await dialog.getByRole("button", { name: "Show advanced voice settings" }).click();
        const gain = dialog.getByRole("switch", { name: "Automatic gain control" });
        const custom = dialog.getByRole("radio", { name: "Custom" });
        const studio = dialog.getByRole("radio", { name: "Studio" });

        await expect(custom).toBeChecked();
        await expect(echo).toBeChecked();
        await expect(gain).toBeChecked();

        await studio.check();
        await expect(echo).not.toBeChecked();
        await expect(gain).not.toBeChecked();
        await expect(dialog.getByRole("slider", { name: "Input sensitivity threshold" })).toBeDisabled();

        // Editing a switch by hand leaves the profile that promised there was no processing.
        await echo.click();
        await expect(custom).toBeChecked();
        await expect(echo).toBeChecked();
        await expect(gain).not.toBeChecked();

        await studio.check();
        await custom.check();
        await expect(echo).not.toBeChecked();
    });

    test("records a push to talk keybind and keeps it", async ({ page }) => {
        const dialog = await openVoiceVideo(page);
        await expect(dialog.getByTestId("ptt-key")).toHaveCount(0);
        await dialog.getByRole("radio", { name: "Push to talk" }).check();
        await expect(dialog.getByTestId("ptt-key")).toHaveText("Not set");

        await dialog.getByRole("button", { name: "Record keybind" }).click();
        await expect(dialog.getByTestId("ptt-key")).toContainText("Press a key");
        await page.keyboard.press("Escape");
        await expect(dialog.getByTestId("ptt-key")).toHaveText("Not set");
        await expect(page.getByRole("dialog")).toBeVisible();

        await dialog.getByRole("button", { name: "Record keybind" }).click();
        await page.keyboard.press("Control+KeyV");
        await expect(dialog.getByTestId("ptt-key")).toHaveText("Ctrl + V");
        await expect(dialog.getByText("Manage keybinds in Keyboard settings")).toBeVisible();

        await dialog.getByRole("slider", { name: "Push to talk release delay" }).fill("600");
        await expect(dialog.getByText("600 ms").first()).toBeVisible();

        await page.reload();
        const reopened = await openVoiceVideo(page);
        await expect(reopened.getByRole("radio", { name: "Push to talk" })).toBeChecked();
        await expect(reopened.getByTestId("ptt-key")).toHaveText("Ctrl + V");
    });

    test("previews a sound even when it is switched off, and keeps the choice", async ({ page }) => {
        const dialog = await openVoiceVideo(page);
        const mute = dialog.getByRole("switch", { name: "Mute", exact: true });
        await expect(mute).toBeChecked();
        await mute.click();
        await expect(mute).not.toBeChecked();

        await dialog.getByRole("button", { name: "Preview sound: Mute" }).click();
        await expect
            .poll(() => page.evaluate(() => (window as unknown as { __sounds: string[] }).__sounds))
            .toEqual([expect.stringMatching(/\.wav$/)]);

        await dialog.getByRole("button", { name: "Show 8 more sounds" }).click();
        await expect(dialog.getByRole("switch", { name: "Camera on" })).toBeChecked();
        await expect(dialog.getByRole("switch", { name: "Push to talk on" })).toBeChecked();

        await page.reload();
        const reopened = await openVoiceVideo(page);
        await expect(reopened.getByRole("switch", { name: "Mute", exact: true })).not.toBeChecked();
        await expect(reopened.getByRole("switch", { name: "Unmute", exact: true })).toBeChecked();
    });

    test("opens the notification settings from the sounds section", async ({ page }) => {
        const dialog = await openVoiceVideo(page);
        await dialog
            .getByRole("button", { name: /Notifications/ })
            .first()
            .click();
        await expect(dialog.locator(".mx_TabbedView_tabLabel_active")).toContainText("Notifications");
        // It is the same dialog, not a second one on top.
        await expect(page.getByRole("dialog")).toHaveCount(1);
    });

    test("resets every Voice & Video setting after a confirmation", async ({ page }) => {
        const dialog = await openVoiceVideo(page);
        const speaker = dialog.getByRole("slider", { name: "Speaker volume" });
        await speaker.fill("30");
        await dialog.getByRole("switch", { name: "Mute", exact: true }).click();
        await dialog.getByRole("radio", { name: "Studio" }).check();
        await dialog.getByRole("switch", { name: "Mirror my video" }).click();

        await dialog.getByRole("button", { name: "Reset", exact: true }).click();
        const confirm = page.getByRole("dialog").filter({
            has: page.getByRole("heading", { name: "Reset all Voice & Video settings?", exact: true }),
        });
        await confirm.getByRole("button", { name: "Cancel" }).click();
        await expect(speaker).toHaveValue("30");

        await dialog.getByRole("button", { name: "Reset", exact: true }).click();
        await confirm.getByRole("button", { name: "Reset", exact: true }).click();
        await expect(speaker).toHaveValue("100");
        await expect(dialog.getByRole("switch", { name: "Mute", exact: true })).toBeChecked();
        await expect(dialog.getByRole("radio", { name: "Custom" })).toBeChecked();
        await expect(dialog.getByRole("switch", { name: "Echo cancellation" })).toBeChecked();
        await expect(dialog.getByRole("switch", { name: "Mirror my video" })).toBeChecked();
    });
});

test.describe("Voice & Video settings outside the desktop shell", () => {
    test.use({
        config: {
            features: { feature_desktop_shell: false },
            element_call: { disable: false, use_exclusively: true },
        },
    });

    test("keep Element's own page, without sections, sounds or the new controls", async ({ page, app }) => {
        await dismissToasts(page);
        const dialog = await app.settings.openUserSettings("Voice & Video");
        await expect(dialog.getByRole("switch", { name: "Noise suppression" })).toBeVisible();
        await expect(dialog.getByRole("switch", { name: "Echo cancellation" })).toBeVisible();
        await expect(dialog.getByRole("button", { name: "Let's check" })).toHaveCount(0);
        await expect(dialog.getByText("Show advanced voice settings")).toHaveCount(0);
        await expect(dialog.locator(".mx_TabbedView_anchors")).toHaveCount(0);
    });
});
