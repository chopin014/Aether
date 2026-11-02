/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { test, expect } from "../../element-web-test";
import { SettingLevel } from "../../../src/settings/SettingLevel";

test.use({
    config: {
        features: { feature_desktop_shell: true, feature_element_call_react: true },
        element_call: { disable: false, use_exclusively: true },
    },
});

interface Preparation {
    contexts: AudioContext[];
    captures: number;
    denoiserReady: boolean;
}

test(
    "prepares a suspended microphone without capture, then expires it",
    { tag: ["@no-firefox", "@no-webkit"] },
    async ({ page, user }) => {
        await page.evaluate(async (level) => {
            await window.mxSettingsStore.setValue("desktopInputProfile", null, level, "voice_isolation");
        }, SettingLevel.DEVICE);
        await page.addInitScript(() => {
            const state: Preparation = { contexts: [], captures: 0, denoiserReady: false };
            Object.defineProperty(window, "__callPreparation", { value: state });
            const OriginalWorklet = window.AudioWorkletNode;
            window.AudioWorkletNode = class extends OriginalWorklet {
                public constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
                    super(context, name, options);
                    if (name === "aether-microphone-gate" && context instanceof AudioContext)
                        state.contexts.push(context);
                    this.port.addEventListener("message", (event) => {
                        if (event.data.denoiser === "active") state.denoiserReady = true;
                    });
                    this.port.start();
                }
            };
            const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
            navigator.mediaDevices.getUserMedia = (constraints): Promise<MediaStream> => {
                state.captures++;
                return capture(constraints);
            };
        });
        await page.clock.install();
        await page.reload();
        const preparation = (): Promise<{ captures: number; ready: boolean; suspended: boolean; closed: boolean }> =>
            page.evaluate(() => {
                const state = (window as Window & { __callPreparation?: Preparation }).__callPreparation!;
                return {
                    captures: state.captures,
                    ready: state.denoiserReady,
                    suspended: state.contexts.some((context) => context.state === "suspended"),
                    closed: state.contexts.length > 0 && state.contexts.every((context) => context.state === "closed"),
                };
            });
        await expect.poll(preparation, { timeout: 30000 }).toMatchObject({ captures: 0, ready: true, suspended: true });
        await page.clock.fastForward(60001);
        await expect.poll(preparation).toMatchObject({ captures: 0, closed: true });
    },
);
