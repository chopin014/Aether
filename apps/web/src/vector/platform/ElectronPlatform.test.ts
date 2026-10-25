/*
Copyright 2024-2025 New Vector Ltd.
Copyright 2022 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeAll, beforeEach, afterEach, type MockedObject } from "vitest";
import { logger } from "matrix-js-sdk/src/logger";
import { MatrixEvent, Room } from "matrix-js-sdk/src/matrix";
import { waitFor } from "test-utils-rtl";
import { stubClient } from "test-utils";
import "vitest-canvas-mock";

import { UpdateCheckStatus } from "../../BasePlatform";
import { Action } from "../../dispatcher/actions";
import dispatcher from "../../dispatcher/dispatcher";
import * as rageshake from "../../rageshake/rageshake";
import { BreadcrumbsStore } from "../../stores/BreadcrumbsStore";
import Modal from "../../Modal";
import DesktopCapturerSourcePicker from "../../components/views/elements/DesktopCapturerSourcePicker";
import ElectronPlatform from "./ElectronPlatform";
import * as windowControlsTheme from "./watchWindowControlsTheme";
import ToastStore from "../../stores/ToastStore.ts";
import * as screenShareAudio from "../../audio/desktop/ScreenShareAudio";
import type { ScreenShareAudioApi, ScreenShareAudioTarget } from "shared-types";

vi.mock("../../rageshake/rageshake", () => ({
    flush: vi.fn(),
}));

describe("ElectronPlatform", () => {
    const initialiseValues = vi.fn().mockReturnValue({
        protocol: "io.element.desktop",
        sessionId: "session-id",
        config: { _config: true },
        supportedSettings: { setting1: false, setting2: true },
        supportsBadgeOverlay: false,
    });
    const defaultUserAgent =
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/105.0.0.0 Safari/537.36";
    const mockElectron = {
        on: vi.fn(),
        send: vi.fn(),
        initialise: initialiseValues,
        setSettingValue: vi.fn().mockResolvedValue(undefined),
        getSettingValue: vi.fn().mockResolvedValue(undefined),
    } as unknown as MockedObject<Electron>;

    const dispatchSpy = vi.spyOn(dispatcher, "dispatch");
    const dispatchFireSpy = vi.spyOn(dispatcher, "fire");
    const logSpy = vi.spyOn(logger, "log").mockImplementation(() => {});

    const userId = "@alice:server.org";
    const deviceId = "device-id";
    const screenShareAudioApi = {} as ScreenShareAudioApi;

    beforeEach(() => {
        window.electron = mockElectron;
        mockElectron.screenShareAudio = screenShareAudioApi;
        vi.clearAllMocks();
        Object.defineProperty(window, "navigator", { value: { userAgent: defaultUserAgent }, writable: true });
    });

    const getElectronEventHandlerCall = (
        eventType: string,
    ): [type: string, handler: (...args: any) => void] | undefined =>
        mockElectron.on.mock.calls.find(([type]) => type === eventType);

    it("sends resolved native window colours through the existing IPC bridge when the shell is enabled", async () => {
        initialiseValues.mockReturnValueOnce({
            protocol: "io.element.desktop",
            sessionId: "session-id",
            config: { features: { feature_desktop_shell: true } },
            supportedSettings: {},
            supportsBadgeOverlay: false,
        });
        const observe = vi.spyOn(windowControlsTheme, "watchWindowControlsTheme").mockImplementation((update) => {
            update("rgb(255, 255, 255)", "rgb(76, 80, 112)");
            return () => {};
        });
        try {
            const platform = new ElectronPlatform();
            await platform.initialised;
            expect(observe).toHaveBeenCalledOnce();
            expect(mockElectron.send).toHaveBeenCalledWith(
                "ipcCall",
                expect.objectContaining({
                    name: "setWindowControlsTheme",
                    args: ["rgb(255, 255, 255)", "rgb(76, 80, 112)"],
                }),
            );
        } finally {
            observe.mockRestore();
        }
    });

    it("does not watch native window colours when the desktop shell is disabled", async () => {
        const observe = vi.spyOn(windowControlsTheme, "watchWindowControlsTheme");
        try {
            const platform = new ElectronPlatform();
            await platform.initialised;
            expect(observe).not.toHaveBeenCalled();
        } finally {
            observe.mockRestore();
        }
    });

    it("flushes rageshake before quitting", () => {
        new ElectronPlatform();
        const [event, handler] = getElectronEventHandlerCall("before-quit")!;
        // correct event bound
        expect(event).toBeTruthy();

        handler();

        expect(logSpy).toHaveBeenCalled();
        expect(rageshake.flush).toHaveBeenCalled();
    });

    it("should load config", async () => {
        const platform = new ElectronPlatform();
        await expect(platform.getConfig()).resolves.toEqual({ _config: true });
    });

    it("delegates explicitly selected screen audio and preserves its cleanup action", async () => {
        const capture = vi.spyOn(screenShareAudio, "captureScreenShareAudio");
        const platform = new ElectronPlatform();
        const video = {} as MediaStream;
        const target: ScreenShareAudioTarget = { kind: "application", id: "application-1" };
        const signal = new AbortController().signal;
        const stop = vi.fn().mockResolvedValue(undefined);
        const result = { stream: video, stop };
        capture.mockResolvedValue(result);

        try {
            await expect(platform.captureScreenShareAudio(video, "screen:7:0", target, signal)).resolves.toBe(result);
            expect(capture).toHaveBeenCalledWith(video, "screen:7:0", target, { signal, api: screenShareAudioApi });

            await result.stop();
            expect(stop).toHaveBeenCalledOnce();
        } finally {
            capture.mockRestore();
        }
    });

    it("propagates screen audio setup failures", async () => {
        const capture = vi.spyOn(screenShareAudio, "captureScreenShareAudio");
        const platform = new ElectronPlatform();
        const error = new Error("native audio capture unavailable");
        capture.mockRejectedValue(error);

        try {
            await expect(
                platform.captureScreenShareAudio({} as MediaStream, "screen:7:0", { kind: "system" }),
            ).rejects.toBe(error);
        } finally {
            capture.mockRestore();
        }
    });

    it("should return oidc client state as expected", async () => {
        const platform = new ElectronPlatform();
        await platform.getConfig();
        expect(platform.getOAuthClientState()).toMatchInlineSnapshot(`":element-desktop-ssoid:session-id"`);
    });

    it.each(["aether", "io.element.desktop"])("uses the configured %s protocol for SSO callbacks", async (protocol) => {
        initialiseValues.mockReturnValueOnce({
            protocol,
            sessionId: "session-id",
            config: {},
            supportedSettings: {},
            supportsBadgeOverlay: false,
        });
        const locationSpy = vi.spyOn(window, "location", "get").mockReturnValue({
            href: "vector://vector/webapp/?existing=value#/login",
        } as Location);

        try {
            const platform = new ElectronPlatform();
            await platform.initialised;

            expect(platform.getSSOCallbackUrl("/room/!room:example.org").href).toBe(
                `${protocol}://vector/webapp/?existing=value&element-desktop-ssoid=session-id#/room/!room:example.org`,
            );
        } finally {
            locationSpy.mockRestore();
        }
    });

    it("dispatches view settings action on preferences event", () => {
        new ElectronPlatform();
        const [event, handler] = getElectronEventHandlerCall("preferences")!;
        // correct event bound
        expect(event).toBeTruthy();

        handler();

        expect(dispatchFireSpy).toHaveBeenCalledWith(Action.ViewUserSettings);
    });

    it("creates a modal on openDesktopCapturerSourcePicker", async () => {
        const plat = new ElectronPlatform();
        Modal.createDialog = vi.fn();

        // @ts-ignore mock
        vi.mocked(Modal.createDialog).mockReturnValue({
            finished: new Promise((r) => r(["source"])),
        });

        let res: () => void;
        const waitForIPCSend = new Promise<void>((r) => {
            res = r;
        });
        // @ts-ignore mock
        vi.spyOn(plat.ipc, "call").mockImplementation(() => {
            res();
        });

        const [event, handler] = getElectronEventHandlerCall("openDesktopCapturerSourcePicker")!;
        handler();

        await waitForIPCSend;

        expect(event).toBeTruthy();
        expect(Modal.createDialog).toHaveBeenCalledWith(DesktopCapturerSourcePicker);
        // @ts-ignore mock
        expect(plat.ipc.call).toHaveBeenCalledWith("callDisplayMediaCallback", "source");
    });

    it("should show a toast when showToast is fired", async () => {
        new ElectronPlatform();
        dispatcher.dispatch(
            {
                action: Action.ClientStarted,
            },
            true,
        );
        const spy = vi.spyOn(ToastStore.sharedInstance(), "addOrReplaceToast");

        const [event, handler] = getElectronEventHandlerCall("showToast")!;
        handler({} as any, { title: "title", description: "description" });

        expect(event).toBeTruthy();
        await waitFor(() =>
            expect(spy).toHaveBeenCalledWith(
                expect.objectContaining({
                    title: "title",
                    props: expect.objectContaining({ description: "description" }),
                }),
            ),
        );
    });

    describe("updates", () => {
        it("dispatches on check updates action", () => {
            new ElectronPlatform();
            const [event, handler] = getElectronEventHandlerCall("check_updates")!;
            // correct event bound
            expect(event).toBeTruthy();

            handler({}, true);
            expect(dispatchSpy).toHaveBeenCalledWith({
                action: Action.CheckUpdates,
                status: UpdateCheckStatus.Downloading,
            });
        });

        it("dispatches on check updates action when update not available", () => {
            new ElectronPlatform();
            const [, handler] = getElectronEventHandlerCall("check_updates")!;

            handler({}, false);
            expect(dispatchSpy).toHaveBeenCalledWith({
                action: Action.CheckUpdates,
                status: UpdateCheckStatus.NotAvailable,
            });
        });

        it("starts update check", () => {
            const platform = new ElectronPlatform();
            platform.startUpdateCheck();
            expect(mockElectron.send).toHaveBeenCalledWith("check_updates");
        });

        it("installs update", () => {
            const platform = new ElectronPlatform();
            platform.installUpdate();
            expect(mockElectron.send).toHaveBeenCalledWith("install_update");
        });
    });

    it("returns human readable name", () => {
        const platform = new ElectronPlatform();
        expect(platform.getHumanReadableName()).toEqual("Electron Platform");
    });

    describe("getDefaultDeviceDisplayName", () => {
        it.each([
            [
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
                    "(KHTML, like Gecko) Chrome/105.0.0.0 Safari/537.36",
                "Element Desktop: macOS",
            ],
            [
                "Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) " +
                    "electron/1.0.0 Chrome/53.0.2785.113 Electron/1.4.3 Safari/537.36",
                "Element Desktop: Windows",
            ],
            ["Mozilla/5.0 (X11; Linux i686; rv:21.0) Gecko/20100101 Firefox/21.0", "Element Desktop: Linux"],
            ["Mozilla/5.0 (X11; FreeBSD i686; rv:21.0) Gecko/20100101 Firefox/21.0", "Element Desktop: FreeBSD"],
            ["Mozilla/5.0 (X11; OpenBSD i686; rv:21.0) Gecko/20100101 Firefox/21.0", "Element Desktop: OpenBSD"],
            ["Mozilla/5.0 (X11; SunOS i686; rv:21.0) Gecko/20100101 Firefox/21.0", "Element Desktop: SunOS"],
            ["custom user agent", "Element Desktop: Unknown"],
        ])("%s = %s", (userAgent, result) => {
            Object.defineProperty(window, "navigator", { value: { userAgent }, writable: true });
            const platform = new ElectronPlatform();
            expect(platform.getDefaultDeviceDisplayName()).toEqual(result);
        });
    });

    it("returns true for needsUrlTooltips", () => {
        const platform = new ElectronPlatform();
        expect(platform.needsUrlTooltips()).toBe(true);
    });

    it("should override browser shortcuts", () => {
        const platform = new ElectronPlatform();
        expect(platform.overrideBrowserShortcuts()).toBe(true);
    });

    it("allows overriding native context menus", () => {
        const platform = new ElectronPlatform();
        expect(platform.allowOverridingNativeContextMenus()).toBe(true);
    });

    it("indicates support for desktop capturer", () => {
        const platform = new ElectronPlatform();
        expect(platform.supportsDesktopCapturer()).toBe(true);
    });

    it("indicates no support for jitsi screensharing", () => {
        const platform = new ElectronPlatform();
        expect(platform.supportsJitsiScreensharing()).toBe(false);
    });

    describe("notifications", () => {
        it("indicates support for notifications", () => {
            const platform = new ElectronPlatform();
            expect(platform.supportsNotifications()).toBe(true);
        });

        it("may send notifications", () => {
            const platform = new ElectronPlatform();
            expect(platform.maySendNotifications()).toBe(true);
        });

        it("pretends to request notification permission", async () => {
            const platform = new ElectronPlatform();
            const result = await platform.requestNotificationPermission();
            expect(result).toEqual("granted");
        });

        it("creates a loud notification", async () => {
            const platform = new ElectronPlatform();
            platform.loudNotification(new MatrixEvent(), new Room("!room:server", {} as any, userId));
            expect(mockElectron.send).toHaveBeenCalledWith("loudNotification");
        });

        it("sets notification count when count is changing", async () => {
            const platform = new ElectronPlatform();
            platform.setNotificationCount(0);
            // not called because matches internal notificaiton count
            expect(mockElectron.send).not.toHaveBeenCalledWith("setBadgeCount", 0);
            platform.setNotificationCount(1);
            expect(mockElectron.send).toHaveBeenCalledWith("setBadgeCount", 1);
        });
    });

    describe("spellcheck", () => {
        it("indicates support for spellcheck settings", () => {
            const platform = new ElectronPlatform();
            expect(platform.supportsSpellCheckSettings()).toBe(true);
        });

        it("gets available spellcheck languages", () => {
            const platform = new ElectronPlatform();
            mockElectron.send.mockClear();
            void platform.getAvailableSpellCheckLanguages();

            const [channel, { name }] = mockElectron.send.mock.calls[0];
            expect(channel).toEqual("ipcCall");
            expect(name).toEqual("getAvailableSpellCheckLanguages");
        });
    });

    describe("pickle key", () => {
        it("makes correct ipc call to get pickle key", () => {
            const platform = new ElectronPlatform();
            mockElectron.send.mockClear();
            void platform.getPickleKey(userId, deviceId);

            const [, { name, args }] = mockElectron.send.mock.calls[0];
            expect(name).toEqual("getPickleKey");
            expect(args).toEqual([userId, deviceId]);
        });

        it("resolves to null when no pickle key is stored", async () => {
            const platform = new ElectronPlatform();
            mockElectron.send.mockClear();
            const promise = platform.getPickleKey(userId, deviceId);

            const [, { id }] = mockElectron.send.mock.calls[0];
            const [, onIpcReply] = getElectronEventHandlerCall("ipcReply")!;
            onIpcReply({}, { id, reply: null });

            await expect(promise).resolves.toBeNull();
        });

        it("rejects, rather than resolving to null, when the pickle key could not be read", async () => {
            const platform = new ElectronPlatform();
            mockElectron.send.mockClear();
            const promise = platform.getPickleKey(userId, deviceId);

            const [, { id }] = mockElectron.send.mock.calls[0];
            const [, onIpcReply] = getElectronEventHandlerCall("ipcReply")!;
            onIpcReply({}, { id, error: { name: "SafeStorageDecryptionError", message: "Failed to decrypt" } });

            // The name is carried across the IPC boundary so callers can tell the failures apart.
            await expect(promise).rejects.toThrow("Failed to decrypt");
            await expect(promise.catch((e) => e.name)).resolves.toBe("SafeStorageDecryptionError");
        });

        it("makes correct ipc call to create pickle key", () => {
            const platform = new ElectronPlatform();
            mockElectron.send.mockClear();
            void platform.createPickleKey(userId, deviceId);

            const [, { name, args }] = mockElectron.send.mock.calls[0];
            expect(name).toEqual("createPickleKey");
            expect(args).toEqual([userId, deviceId]);
        });

        it("makes correct ipc call to destroy pickle key", () => {
            const platform = new ElectronPlatform();
            mockElectron.send.mockClear();
            void platform.destroyPickleKey(userId, deviceId);

            const [, { name, args }] = mockElectron.send.mock.calls[0];
            expect(name).toEqual("destroyPickleKey");
            expect(args).toEqual([userId, deviceId]);
        });
    });

    describe("versions", () => {
        it("calls install update", () => {
            const platform = new ElectronPlatform();
            platform.installUpdate();

            expect(mockElectron.send).toHaveBeenCalledWith("install_update");
        });
    });

    describe("breadcrumbs", () => {
        it("should send breadcrumb updates over the IPC", () => {
            const spy = vi.spyOn(BreadcrumbsStore.instance, "on");
            new ElectronPlatform();
            const cb = spy.mock.calls[0][1];
            cb();

            expect(mockElectron.send).toHaveBeenCalledWith(
                "ipcCall",
                expect.objectContaining({
                    name: "breadcrumbs",
                }),
            );
        });
    });

    describe("authenticated media", () => {
        it("should respond to relevant ipc requests", async () => {
            const cli = stubClient();
            vi.mocked(cli.getAccessToken).mockReturnValue("access_token");
            vi.mocked(cli.getHomeserverUrl).mockReturnValue("homeserver_url");
            vi.mocked(cli.getVersions).mockResolvedValue({
                versions: ["v1.1"],
                unstable_features: {},
            });

            new ElectronPlatform();

            const userAccessTokenCall = mockElectron.on.mock.calls.find((call) => call[0] === "userAccessToken");
            userAccessTokenCall![1]({} as any);
            const userAccessTokenResponse = mockElectron.send.mock.calls.find((call) => call[0] === "userAccessToken");
            expect(userAccessTokenResponse![1]).toBe("access_token");

            const homeserverUrlCall = mockElectron.on.mock.calls.find((call) => call[0] === "homeserverUrl");
            homeserverUrlCall![1]({} as any);
            const homeserverUrlResponse = mockElectron.send.mock.calls.find((call) => call[0] === "homeserverUrl");
            expect(homeserverUrlResponse![1]).toBe("homeserver_url");

            const serverSupportedVersionsCall = mockElectron.on.mock.calls.find(
                (call) => call[0] === "serverSupportedVersions",
            );
            await (serverSupportedVersionsCall![1]({} as any) as unknown as Promise<unknown>);
            const serverSupportedVersionsResponse = mockElectron.send.mock.calls.find(
                (call) => call[0] === "serverSupportedVersions",
            );
            expect(serverSupportedVersionsResponse![1]).toEqual({ versions: ["v1.1"], unstable_features: {} });
        });
    });

    describe("settings", () => {
        let platform: ElectronPlatform;
        beforeAll(async () => {
            window.electron = mockElectron;
            platform = new ElectronPlatform();
            await platform.getConfig(); // await init
        });

        it("supportsSetting should return true for the platform", () => {
            expect(platform.supportsSetting()).toBe(true);
        });

        it("supportsSetting should return true for available settings", () => {
            expect(platform.supportsSetting("setting2")).toBe(true);
        });

        it("supportsSetting should return false for unavailable settings", () => {
            expect(platform.supportsSetting("setting1")).toBe(false);
        });

        it("should read setting value over ipc", async () => {
            mockElectron.getSettingValue.mockResolvedValue("value");
            await expect(platform.getSettingValue("setting2")).resolves.toEqual("value");
            expect(mockElectron.getSettingValue).toHaveBeenCalledWith("setting2");
        });

        it("should write setting value over ipc", async () => {
            await platform.setSettingValue("setting2", "newValue");
            expect(mockElectron.setSettingValue).toHaveBeenCalledWith("setting2", "newValue");
        });
    });

    it("should forward call_state dispatcher events via ipc", async () => {
        new ElectronPlatform();

        dispatcher.dispatch(
            {
                action: "call_state",
                state: "connected",
            },
            true,
        );

        const ipcMessage = mockElectron.send.mock.calls.find((call) => call[0] === "app_onAction");
        expect(ipcMessage![1]).toEqual({
            action: "call_state",
            state: "connected",
        });
    });

    describe("Notification overlay badges", () => {
        beforeEach(() => {
            initialiseValues.mockReturnValue({
                protocol: "io.element.desktop",
                sessionId: "session-id",
                config: { _config: true },
                supportsBadgeOverlay: true,
            });
        });

        afterEach(() => {
            vi.clearAllMocks();
        });

        it("should send a badge with a notification count", async () => {
            const platform = new ElectronPlatform();
            await platform.initialised;
            platform.setNotificationCount(1);
            // Badges are sent asynchronously
            await waitFor(() => {
                const ipcMessage = mockElectron.send.mock.lastCall;
                expect(ipcMessage?.[1]).toEqual(1);
                expect(ipcMessage?.[2].constructor.name).toEqual("ArrayBuffer");
            });
        });

        it("should update badge and skip duplicates", async () => {
            const platform = new ElectronPlatform();
            await platform.initialised;
            platform.setNotificationCount(1);
            platform.setNotificationCount(1); // Test that duplicates do not fire.
            platform.setNotificationCount(2);
            // Badges are sent asynchronously
            await waitFor(() => {
                const [ipcMessageA, ipcMessageB] = mockElectron.send.mock.calls.filter(
                    (call) => call[0] === "setBadgeCount",
                );

                expect(ipcMessageA?.[1]).toEqual(1);
                expect(ipcMessageA?.[2].constructor.name).toEqual("ArrayBuffer");

                expect(ipcMessageB?.[1]).toEqual(2);
                expect(ipcMessageB?.[2].constructor.name).toEqual("ArrayBuffer");
            });
        });
        it("should remove badge when notification count zeros", async () => {
            const platform = new ElectronPlatform();
            await platform.initialised;
            platform.setNotificationCount(1);
            platform.setNotificationCount(0); // Test that duplicates do not fire.
            // Badges are sent asynchronously
            await waitFor(() => {
                const [ipcMessageB, ipcMessageA] = mockElectron.send.mock.calls.filter(
                    (call) => call[0] === "setBadgeCount",
                );

                expect(ipcMessageA?.[1]).toEqual(1);
                expect(ipcMessageA?.[2].constructor.name).toEqual("ArrayBuffer");

                expect(ipcMessageB?.[1]).toEqual(0);
                expect(ipcMessageB?.[2]).toBeNull();
            });
        });
        it("should show an error badge when the application errors", async () => {
            const platform = new ElectronPlatform();
            await platform.initialised;
            platform.setErrorStatus(true);
            // Badges are sent asynchronously
            await waitFor(() => {
                const ipcMessage = mockElectron.send.mock.calls.find((call) => call[0] === "setBadgeCount");

                expect(ipcMessage?.[1]).toEqual(0);
                expect(ipcMessage?.[2].constructor.name).toEqual("ArrayBuffer");
                expect(ipcMessage?.[3]).toEqual(true);
            });
        });
        it("should restore after error is resolved", async () => {
            const platform = new ElectronPlatform();
            await platform.initialised;
            platform.setErrorStatus(true);
            platform.setErrorStatus(false);
            // Badges are sent asynchronously
            await waitFor(() => {
                const [ipcMessageB, ipcMessageA] = mockElectron.send.mock.calls.filter(
                    (call) => call[0] === "setBadgeCount",
                );

                expect(ipcMessageA?.[1]).toEqual(0);
                expect(ipcMessageA?.[2].constructor.name).toEqual("ArrayBuffer");
                expect(ipcMessageA?.[3]).toEqual(true);

                expect(ipcMessageB?.[1]).toEqual(0);
                expect(ipcMessageB?.[2]).toBeNull();
            });
        });
    });
});
