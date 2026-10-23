/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { test, expect } from "../../element-web-test";

import { SettingLevel } from "../../../src/settings/SettingLevel";

test.use({
    viewport: { width: 1280, height: 1100 },
    permissions: ["microphone"],
    launchOptions: {
        args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--mute-audio"],
    },
    config: {
        features: { feature_element_call_react: true },
        element_call: { disable: false, use_exclusively: true },
    },
});

test(
    "tests the microphone locally, saves sensitivity and releases capture when settings closes",
    {
        tag: ["@no-firefox", "@no-webkit"],
    },
    async ({ page, app, user }, testInfo) => {
        await page.evaluate(() => {
            const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
            const tracks: MediaStreamTrack[] = [];
            Object.defineProperty(window, "__microphoneTestTracks", { value: tracks });
            navigator.mediaDevices.getUserMedia = async (constraints) => {
                const stream = await capture(constraints);
                tracks.push(...stream.getAudioTracks());
                return stream;
            };
        });
        await app.settings.setValue("webrtc_audio_noiseSuppression", null, SettingLevel.DEVICE, false);
        const dialog = await app.settings.openUserSettings("Voice & Video");
        const microphone = dialog.getByRole("region", { name: "Microphone settings" });
        await expect(microphone.getByRole("button", { name: "Mic test", exact: true })).toBeVisible();
        expect(
            await page.evaluate(
                () =>
                    (window as Window & { __microphoneTestTracks?: MediaStreamTrack[] }).__microphoneTestTracks?.length,
            ),
        ).toBe(0);

        await microphone.getByRole("switch", { name: "Automatically determine input sensitivity" }).click();
        const sensitivity = microphone.getByRole("slider", { name: "Manual sensitivity" });
        await sensitivity.press("Home");
        for (let step = 0; step < 30; step++) await sensitivity.press("ArrowRight");
        await microphone.getByRole("slider", { name: "Input volume" }).press("Home");
        for (let step = 0; step < 125; step++)
            await microphone.getByRole("slider", { name: "Input volume" }).press("ArrowRight");
        await microphone.getByRole("slider", { name: "Test playback volume" }).press("Home");
        for (let step = 0; step < 25; step++)
            await microphone.getByRole("slider", { name: "Test playback volume" }).press("ArrowRight");
        await microphone.getByRole("button", { name: "Mic test", exact: true }).click();
        await expect(microphone.getByRole("button", { name: "Stop test" })).toBeVisible();
        await expect.poll(() => microphone.getByRole("meter").getAttribute("aria-valuenow")).not.toBe("-100");
        await expect
            .poll(() =>
                page.getByTestId("microphone-test-audio").evaluate((element: HTMLAudioElement) => ({
                    playing: !element.paused,
                    volume: element.volume,
                    processed: (element.srcObject as MediaStream)
                        .getAudioTracks()[0]
                        .label.includes("MediaStreamAudioDestinationNode"),
                })),
            )
            .toEqual({ playing: true, volume: 0.25, processed: true });
        const playbackTrack = await page
            .getByTestId("microphone-test-audio")
            .evaluateHandle((element: HTMLAudioElement) => (element.srcObject as MediaStream).getAudioTracks()[0]);
        await app.settings.closeDialog();
        await expect(page.getByTestId("microphone-test-audio")).toHaveCount(0);
        await expect
            .poll(() =>
                page.evaluate(() => {
                    const tracks = (window as Window & { __microphoneTestTracks?: MediaStreamTrack[] })
                        .__microphoneTestTracks;
                    return !!tracks?.length && tracks.every((track) => track.readyState === "ended");
                }),
            )
            .toBe(true);
        await expect.poll(() => playbackTrack.evaluate((track) => track.readyState)).toBe("ended");
        await playbackTrack.dispose();

        await app.settings.openUserSettings("Voice & Video");
        await expect(page.getByRole("slider", { name: "Manual sensitivity" })).toHaveValue("-70");
        await expect(page.getByRole("slider", { name: "Input volume" })).toHaveValue("125");
        await expect(page.getByRole("slider", { name: "Test playback volume" })).toHaveValue("25");
        await expect(page.getByRole("slider", { name: "Input volume" })).toHaveAttribute("aria-valuetext", "125%");
        await expect(page.getByRole("button", { name: "Mic test", exact: true })).toBeVisible();
        await microphone.screenshot({ path: testInfo.outputPath("microphone-settings.png") });
    },
);
