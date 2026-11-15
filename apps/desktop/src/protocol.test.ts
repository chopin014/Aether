/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { expect, describe, it, beforeEach, vi, type Mock } from "vitest";
import { fs as memfs, vol } from "memfs";
import EventEmitter from "node:events";
import { app } from "electron";

import ProtocolHandler from "./protocol.js";

const TEST_PROTOCOL = "test.proto";
const TEST_SESSION_ID = "test_session_id";
const USER_DATA_DIR = "/Users/name/Library/Application Support/Element";

vi.mock("node:fs", () => ({ default: memfs }));
vi.mock("electron", () => {
    const emitter = new EventEmitter();

    return {
        app: {
            isPackaged: true,
            getPath: vi.fn().mockReturnValue("/Users/name/Library/Application Support/Element"),
            getAppPath: vi.fn().mockReturnValue("/bin/element-desktop"),
            setAsDefaultProtocolClient: vi.fn(),
            getApplicationNameForProtocol: vi.fn().mockReturnValue(""),
            on: emitter.on.bind(emitter),
            emit: emitter.emit.bind(emitter),
            removeAllListeners: emitter.removeAllListeners.bind(emitter),
        },
        ipcMain: {
            handle: vi.fn(),
        },
    };
});

beforeEach(() => {
    // Reset the state of the in-memory fs
    vol.reset();
    // Clear the event emitter
    app.removeAllListeners();
});

describe("ProtocolHandler", () => {
    beforeEach(() => {
        vol.fromJSON(
            {
                "./sso-sessions.json": JSON.stringify({ [TEST_SESSION_ID]: USER_DATA_DIR }),
            },
            USER_DATA_DIR,
        );
    });

    describe("getProfileFromDeeplink", () => {
        const handler = new ProtocolHandler(TEST_PROTOCOL);

        it("should handle legacy SSO URIs", () => {
            expect(
                handler.getProfileFromDeeplink([
                    "Element.app",
                    `element://vector/webapp/?element-desktop-ssoid=${TEST_SESSION_ID}`,
                ]),
            ).toBe(USER_DATA_DIR);
        });

        it("should handle OIDC URIs with response_mode=query", () => {
            expect(
                handler.getProfileFromDeeplink([
                    "Element.app",
                    `${TEST_PROTOCOL}:/vector/webapp/?no_universal_links=true&code=DEADBEEF&state=foobar:element-desktop-ssoid:${TEST_SESSION_ID}`,
                ]),
            ).toBe(USER_DATA_DIR);
        });

        it("should handle OIDC URIs with response_mode=fragment", () => {
            expect(
                handler.getProfileFromDeeplink([
                    "Element.app",
                    `${TEST_PROTOCOL}:/vector/webapp/?no_universal_links=true#code=DEADBEEF&state=foobar:element-desktop-ssoid:${TEST_SESSION_ID}`,
                ]),
            ).toBe(USER_DATA_DIR);
        });

        it("should handle malformed OIDC URIs gracefully", () => {
            expect(
                handler.getProfileFromDeeplink([
                    "Element.app",
                    `${TEST_PROTOCOL}:/vector/webapp/?no_universal_links=true#code=DEADBEEF:element-desktop-ssoid:${TEST_SESSION_ID}`,
                ]),
            ).toBeUndefined();
        });

        it("should handle unrelated URIs gracefully", () => {
            expect(handler.getProfileFromDeeplink(["Element.app", `${TEST_PROTOCOL}:/vector/webapp/`])).toBeUndefined();
            expect(handler.getProfileFromDeeplink(["Element.app", `test.unrelated:/vector/webapp/`])).toBeUndefined();
        });
    });

    it.each(["darwin", "linux", "win32"] as const)("should handle deeplink on %s", (platform) => {
        vi.spyOn(process, "platform", "get").mockReturnValue(platform);
        vi.stubGlobal("mainWindow", {
            loadURL: vi.fn(),
        });

        const handler = new ProtocolHandler(TEST_PROTOCOL);
        expect(handler).toBeTruthy();

        const incomingUri = "test.proto:/#/room/#matrix:matrix.org";
        const expectedUri = "vector://vector/webapp/#/room/#matrix:matrix.org";

        if (platform === "darwin") {
            app.emit("open-url", new Event("test"), incomingUri);
        } else {
            app.emit("second-instance", new Event("test"), ["/path/to/app", incomingUri]);
        }

        expect(global.mainWindow!.loadURL).toHaveBeenCalledWith(expectedUri);
    });

    it("should safely deal with wrong protocol deeplinks", () => {
        vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
        vi.stubGlobal("mainWindow", {
            loadURL: vi.fn(),
        });

        const handler = new ProtocolHandler(TEST_PROTOCOL);
        expect(handler).toBeTruthy();

        app.emit("open-url", new Event("test"), "random.proto:/#/room/#matrix:matrix.org");

        expect(global.mainWindow!.loadURL).not.toHaveBeenCalled();
    });

    describe("matrix: links", () => {
        const ROOM_LINK = "matrix:r/aether:example.org?via=example.org&action=join";
        const ROOM_HASH = "#/room/%23aether%3Aexample.org?via=example.org";

        function stubWindow(isLoading = false): { loadURL: Mock; webContents: { isLoading: Mock; send: Mock } } {
            const window = {
                loadURL: vi.fn(),
                webContents: { isLoading: vi.fn().mockReturnValue(isLoading), send: vi.fn() },
            };
            vi.stubGlobal("mainWindow", window);
            return window;
        }

        it.each(["linux", "win32"] as const)(
            "tells the running app on %s where to go, without reloading it",
            (platform) => {
                vi.spyOn(process, "platform", "get").mockReturnValue(platform);
                const window = stubWindow();
                new ProtocolHandler(TEST_PROTOCOL);

                app.emit("second-instance", new Event("test"), ["/opt/Aether/aether", "--no-sandbox", ROOM_LINK]);

                expect(window.webContents.send).toHaveBeenCalledWith("openMatrixLink", ROOM_HASH);
                expect(window.loadURL).not.toHaveBeenCalled();
            },
        );

        it("routes a user and an event link", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("linux");
            const window = stubWindow();
            new ProtocolHandler(TEST_PROTOCOL);

            app.emit("second-instance", new Event("test"), ["/opt/Aether/aether", "matrix:u/alice:example.org"]);
            app.emit("second-instance", new Event("test"), ["aether", "matrix:roomid/abc:example.org/e/ev%2F1"]);

            expect(window.webContents.send.mock.calls).toEqual([
                ["openMatrixLink", "#/user/%40alice%3Aexample.org"],
                ["openMatrixLink", "#/room/!abc%3Aexample.org/%24ev%2F1"],
            ]);
        });

        it("loads the app at the link while it is still starting", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("linux");
            const window = stubWindow(true);
            new ProtocolHandler(TEST_PROTOCOL);

            app.emit("second-instance", new Event("test"), ["/opt/Aether/aether", ROOM_LINK]);

            expect(window.loadURL).toHaveBeenCalledWith(`vector://vector/webapp/${ROOM_HASH}`);
            expect(window.webContents.send).not.toHaveBeenCalled();
        });

        it("opens a link on macOS", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
            const window = stubWindow();
            new ProtocolHandler(TEST_PROTOCOL);

            app.emit("open-url", new Event("test"), ROOM_LINK);

            expect(window.webContents.send).toHaveBeenCalledWith("openMatrixLink", ROOM_HASH);
        });

        it.each([
            "matrix:r/aether",
            "matrix://evil.example/r/a:b.org",
            "matrix:u/a%0A:b.org",
            "matrix:r/a:b.org/e/%3Cscript%3E",
            "javascript:alert(1)",
            "file:///etc/passwd",
        ])("ignores %s", (uri) => {
            vi.spyOn(process, "platform", "get").mockReturnValue("linux");
            const window = stubWindow();
            new ProtocolHandler(TEST_PROTOCOL);

            app.emit("second-instance", new Event("test"), ["/opt/Aether/aether", uri]);

            expect(window.webContents.send).not.toHaveBeenCalled();
            expect(window.loadURL).not.toHaveBeenCalled();
        });

        it("ignores a second instance started with no link", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("linux");
            const window = stubWindow();
            new ProtocolHandler(TEST_PROTOCOL);

            app.emit("second-instance", new Event("test"), ["/opt/Aether/aether"]);

            expect(window.webContents.send).not.toHaveBeenCalled();
        });

        it("loads the app at a link it was started with", () => {
            const window = stubWindow();
            const handler = new ProtocolHandler(TEST_PROTOCOL);

            const hasDeeplink = handler.initialise({
                userDataPath: "/data",
                devtools: false,
                update: false,
                hidden: false,
                positional: ["/opt/Aether/aether", "matrix:u/alice:example.org"],
            });

            expect(hasDeeplink).toBe(true);
            expect(window.loadURL).toHaveBeenCalledWith("vector://vector/webapp/#/user/%40alice%3Aexample.org");
        });

        it("starts normally when the start link is malformed", () => {
            const window = stubWindow();
            const handler = new ProtocolHandler(TEST_PROTOCOL);

            const hasDeeplink = handler.initialise({
                userDataPath: "/data",
                devtools: false,
                update: false,
                hidden: false,
                positional: ["/opt/Aether/aether", "matrix:u/alice"],
            });

            expect(hasDeeplink).toBe(false);
            expect(window.loadURL).not.toHaveBeenCalled();
        });
    });

    describe("initialise", () => {
        beforeEach(() => {
            vi.spyOn(process, "execPath", "get").mockReturnValue("/bin/element-desktop");
            vi.mocked(app.setAsDefaultProtocolClient).mockClear();
            vi.mocked(app.getApplicationNameForProtocol).mockReturnValue("");
        });

        it("should set as default protocol client", () => {
            const handler = new ProtocolHandler(TEST_PROTOCOL);
            handler.initialise({
                userDataPath: USER_DATA_DIR,
                devtools: false,
                update: false,
                hidden: false,
                positional: ["/bin/element-desktop"],
            });

            const args = ["--no-update"];
            expect(app.setAsDefaultProtocolClient).toHaveBeenCalledWith(TEST_PROTOCOL, "/bin/element-desktop", args);
            expect(app.setAsDefaultProtocolClient).toHaveBeenCalledWith("element", "/bin/element-desktop", args);
            expect(app.getApplicationNameForProtocol).toHaveBeenCalledWith("matrix:");
            expect(app.setAsDefaultProtocolClient).toHaveBeenCalledWith("matrix", "/bin/element-desktop", args);
        });

        it("leaves matrix: links to another app that already opens them", () => {
            vi.mocked(app.getApplicationNameForProtocol).mockReturnValue("Element");
            const handler = new ProtocolHandler(TEST_PROTOCOL);
            handler.initialise({
                userDataPath: USER_DATA_DIR,
                devtools: false,
                update: false,
                hidden: false,
                positional: ["/bin/element-desktop"],
            });

            expect(app.setAsDefaultProtocolClient).toHaveBeenCalledWith(TEST_PROTOCOL, "/bin/element-desktop", [
                "--no-update",
            ]);
            expect(app.setAsDefaultProtocolClient).not.toHaveBeenCalledWith(
                "matrix",
                expect.anything(),
                expect.anything(),
            );
        });

        it("never registers a development build for matrix: links", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("win32");
            (app as { isPackaged: boolean }).isPackaged = false;
            try {
                const handler = new ProtocolHandler(TEST_PROTOCOL);
                handler.initialise({
                    userDataPath: USER_DATA_DIR,
                    devtools: false,
                    update: false,
                    hidden: false,
                    positional: ["/bin/element-desktop"],
                });
            } finally {
                (app as { isPackaged: boolean }).isPackaged = true;
            }

            expect(app.setAsDefaultProtocolClient).toHaveBeenCalledWith(
                TEST_PROTOCOL,
                "/bin/element-desktop",
                expect.anything(),
            );
            expect(app.setAsDefaultProtocolClient).not.toHaveBeenCalledWith(
                "matrix",
                expect.anything(),
                expect.anything(),
            );
        });

        it("should handle deeplink", () => {
            vi.stubGlobal("mainWindow", {
                loadURL: vi.fn(),
            });

            const handler = new ProtocolHandler(TEST_PROTOCOL);
            handler.initialise({
                userDataPath: "/data",
                devtools: false,
                update: false,
                hidden: false,
                positional: ["/bin/element-desktop", "test.proto:/#/room/#matrix:matrix.org"],
            });

            expect(global.mainWindow!.loadURL).toHaveBeenCalledWith("vector://vector/webapp/#/room/#matrix:matrix.org");
        });
    });
});
