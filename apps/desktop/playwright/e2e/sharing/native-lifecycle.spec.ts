/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { _electron as electron, test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

test("Windows native audio can restart and the capturing process exits after stopping", async () => {
    test.skip(process.platform !== "win32", "Tests Windows WASAPI process cleanup");
    test.skip(!!process.env.ELEMENT_DESKTOP_EXECUTABLE, "Requires the local native audio dependency");
    test.setTimeout(60_000);

    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aether-native-lifecycle-"));
    const entry = path.join(directory, "main.cjs");
    const require = createRequire(import.meta.url);
    const nativeModule = require.resolve("electron-native-screenshare");
    await fs.writeFile(
        entry,
        `const { app, BrowserWindow } = require("electron");
globalThis.nativeCapture = require(process.env.AETHER_NATIVE_AUDIO_MODULE);
app.whenReady().then(async () => {
    globalThis.sourceWindow = new BrowserWindow({ show: false });
    await globalThis.sourceWindow.loadURL("data:text/html,<title>Native audio lifecycle</title>");
});
`,
    );

    const env = { ...process.env };
    env.AETHER_NATIVE_AUDIO_MODULE = nativeModule;
    delete env.ELECTRON_RUN_AS_NODE;
    const application = await electron.launch({
        env,
        args: [entry, "--disable-gpu", `--user-data-dir=${path.join(directory, "profile")}`],
    });
    const child = application.process();
    try {
        await application.firstWindow();
        const started = await application.evaluate(async () => {
            const capture = (
                globalThis as unknown as {
                    nativeCapture: {
                        startCapture: (pid: number, include: boolean, callback: () => void) => boolean;
                        stopCapture: () => void;
                    };
                }
            ).nativeCapture;
            const sessions = [];
            for (let session = 0; session < 2; session++) {
                sessions.push(capture.startCapture(process.pid, false, () => {}));
                // Allow the capture thread to enter its loop before stopping and restarting it.
                await new Promise((resolve) => setTimeout(resolve, 200));
                capture.stopCapture();
            }
            return sessions;
        });
        expect(started).toEqual([true, true]);

        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                application.close(),
                new Promise<never>((_, reject) => {
                    // Keep shutdown bounded independently of application startup and capture assertions.
                    timeout = setTimeout(() => reject(new Error("Native capture process did not close")), 30_000);
                }),
            ]);
        } finally {
            clearTimeout(timeout);
        }
        expect(child.exitCode).toBe(0);
    } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
});
