/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { expect, describe, it, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { Tray, nativeImage, type BrowserWindow } from "electron";

import { getConfig } from "./config.js";

vi.mock("electron", () => ({
    Tray: vi.fn(
        class {
            public setToolTip = vi.fn();
            public setContextMenu = vi.fn();
            public on = vi.fn();
            public setImage = vi.fn();
            public destroy = vi.fn();
        },
    ),
    Menu: {
        buildFromTemplate: vi.fn(),
    },
    nativeImage: {
        createFromPath: vi.fn(),
        createFromDataURL: vi.fn(),
    },
    app: {
        isPackaged: true,
        getPath: vi.fn(() => "/tmp"),
    },
}));

vi.mock("node:fs/promises", () => ({ writeFile: vi.fn() }));
vi.mock("png-to-ico", () => ({ default: vi.fn(async (png: Buffer) => png) }));
vi.mock("./build-config.js", () => ({ getBuildConfig: () => ({}) }));
vi.mock("./icon.js");
vi.mock("./config.js");

describe("create", () => {
    let create: () => Promise<void>;
    let destroy: () => void;

    beforeEach(async () => {
        // The tray is disabled on macOS so test under win32
        vi.spyOn(process, "platform", "get").mockReturnValue("win32");
        ({ create, destroy } = await import("./tray.js"));
    });

    afterEach(() => {
        destroy();
        global.mainWindow = null;
        vi.restoreAllMocks();
        vi.clearAllMocks();
    });

    it("should use config.brand", async () => {
        vi.mocked(getConfig).mockReturnValue({ brand: "ChatApp", help_url: "HELP_URL", web_base_url: "WEB_BASE_URL" });
        await create();
        const tray = vi.mocked(Tray).mock.instances[0];
        expect(tray.setToolTip).toHaveBeenCalledWith("ChatApp");
    });

    it.each(["linux", "win32"] as const)(
        "keeps Aether branding when the renderer updates the %s tray",
        async (platform) => {
            vi.spyOn(process, "platform", "get").mockReturnValue(platform);
            vi.mocked(getConfig).mockReturnValue({ brand: "Aether", help_url: "", web_base_url: "" });
            const webContents = new EventEmitter();
            global.mainWindow = { webContents, setIcon: vi.fn() } as unknown as BrowserWindow;
            const packagedPng = readFileSync("aether/icon.png");
            const rendererPng = readFileSync("../web/res/vector-icons/512.png");
            const defaultIcon = { toPNG: () => packagedPng } as Electron.NativeImage;
            vi.mocked(nativeImage.createFromPath).mockReturnValue(defaultIcon);
            vi.mocked(nativeImage.createFromDataURL).mockImplementation((url) => {
                const png = Buffer.from(url.split(",")[1], "base64");
                return { toPNG: () => png } as Electron.NativeImage;
            });
            await create();
            const tray = vi.mocked(Tray).mock.instances[0];
            const faviconUpdated = webContents.listeners("page-favicon-updated")[0];

            // A zero-count badge redraw emits the original favicon as a data URL too.
            await faviconUpdated({}, [`data:image/png;base64,${rendererPng.toString("base64")}`]);
            const url = vi.mocked(nativeImage.createFromDataURL).mock.calls[0][0];
            expect(Buffer.from(url.split(",")[1], "base64").equals(packagedPng)).toBe(true);
            expect(tray.setImage).toHaveBeenCalled();

            await faviconUpdated({}, []);
            expect(tray.setImage).toHaveBeenLastCalledWith(defaultIcon);
        },
    );
});
