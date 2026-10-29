/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { app, ipcMain, type BrowserWindow, type Event, type IpcMainEvent } from "electron";

/** Allow the renderer to publish call leaves before destroying its network connections. */
export function setupGracefulQuit(getWindow: () => BrowserWindow | null): { isWaiting: () => boolean } {
    let ready = false;
    let waiting = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (): void => {
        if (!waiting) return;
        waiting = false;
        ready = true;
        clearTimeout(timer);
        ipcMain.off("quit-ready", onReady);
        app.quit();
    };
    const onReady = (event: IpcMainEvent): void => {
        const window = getWindow();
        if (window && event.sender === window.webContents && event.senderFrame === event.sender.mainFrame) finish();
    };
    app.on("before-quit", (event: Event) => {
        if (ready) return;
        const window = getWindow();
        if (!window || window.isDestroyed() || window.webContents.isDestroyed() || window.webContents.isCrashed()) {
            ready = true;
            return;
        }
        event.preventDefault();
        if (waiting) return;
        waiting = true;
        ipcMain.on("quit-ready", onReady);
        // A crashed, offline or older renderer must never prevent the user from quitting.
        timer = setTimeout(finish, 5_000);
        window.webContents.send("before-quit");
    });
    return { isWaiting: () => waiting };
}
