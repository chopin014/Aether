/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ScreenShareAudioApi, ScreenShareAudioEvent, X509Api, X509IpcCommand } from "shared-types";
import { ipcRenderer } from "electron";
import type { ShortcutConfiguration, ShortcutEvent, ShortcutResult } from "./global-shortcuts/types.js";

// `vi.mock` factories are hoisted above top-level constants, so anything they reference must be hoisted too.
const { exposed, invoke } = vi.hoisted(() => ({
    exposed: new Map<string, unknown>(),
    invoke: vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock("electron", () => ({
    contextBridge: {
        exposeInMainWorld: (key: string, api: unknown) => exposed.set(key, api),
    },
    ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn(), send: vi.fn(), emit: vi.fn() },
}));

describe("preload x509 ipc", () => {
    let x509: X509Api;

    beforeAll(async () => {
        // @ts-ignore `tsc` complains about needing to enable `allowImportingTsExtensions`, but vitest is happy to import this.
        await import("./preload.cts");
        x509 = (exposed.get("electron") as { x509: X509Api }).x509;
    });

    /**
     * Assert the last IPC call was `command` on the "x509" channel.
     */
    function expectInvoked(command: X509IpcCommand, ...args: unknown[]): void {
        expect(invoke).toHaveBeenLastCalledWith("x509", command, ...args);
    }

    it("configures shortcuts through a narrow invoke channel and removes the exact event listener", async () => {
        const api = (
            exposed.get("electron") as {
                globalShortcuts: {
                    configure: (configuration: ShortcutConfiguration) => Promise<ShortcutResult>;
                    onEvent: (listener: (event: ShortcutEvent) => void) => () => void;
                };
            }
        ).globalShortcuts;
        const configuration = { enabled: false, bindings: [] };
        const result: ShortcutResult = { backend: "unsupported", bindings: [] };
        invoke.mockResolvedValueOnce(result);
        await expect(api.configure(configuration)).resolves.toBe(result);
        expect(invoke).toHaveBeenLastCalledWith("aether:configure-global-shortcuts", configuration);
        const listener = vi.fn();
        const unsubscribe = api.onEvent(listener);
        const [channel, handler] = vi.mocked(ipcRenderer.on).mock.calls.at(-1)!;
        const event: ShortcutEvent = { id: "push_to_talk", pressed: true };
        handler({ ports: [], sender: ipcRenderer, preventDefault: vi.fn(), defaultPrevented: false }, event);
        expect(channel).toBe("aether:global-shortcut");
        expect(listener).toHaveBeenCalledExactlyOnceWith(event);
        unsubscribe();
        expect(ipcRenderer.removeListener).toHaveBeenCalledWith(channel, handler);
    });

    it("calls getUserCertificate correctly", async () => {
        const result = { ok: true, data: "certificate" };
        invoke.mockResolvedValueOnce(result);

        await expect(x509.getUserCertificate()).resolves.toBe(result);
        expectInvoked("getUserCertificate");
    });

    it("exposes screen audio through narrow channels and acknowledges bounded PCM even if a listener throws", async () => {
        const api = (exposed.get("electron") as { screenShareAudio: ScreenShareAudioApi }).screenShareAudio;
        const request = { id: "share-1", videoSourceId: "screen:1:0", target: { kind: "system" } as const };
        await api.start(request);
        expect(invoke).toHaveBeenLastCalledWith("aether:share-audio-start", request);
        await api.stop(request.id);
        expect(invoke).toHaveBeenLastCalledWith("aether:share-audio-stop", request.id);
        const listener = vi.fn(() => {
            throw new Error("listener stopped");
        });
        const unsubscribe = api.onEvent(listener);
        const [channel, handler] = vi.mocked(ipcRenderer.on).mock.calls.at(-1)!;
        const event: ScreenShareAudioEvent = { type: "data", id: request.id, sequence: 1, pcm: new Uint8Array(8) };
        expect(() => handler({} as Electron.IpcRendererEvent, event)).toThrow("listener stopped");
        expect(ipcRenderer.send).toHaveBeenLastCalledWith("aether:share-audio-ack", request.id, 1);
        unsubscribe();
        expect(ipcRenderer.removeListener).toHaveBeenCalledWith(channel, handler);
    });

    it("calls listHardwareKeys correctly", async () => {
        const result = { ok: true, data: [] };
        invoke.mockResolvedValueOnce(result);

        await expect(x509.listHardwareKeys()).resolves.toBe(result);
        expectInvoked("listHardwareKeys");
    });

    it("calls getKeyState correctly", async () => {
        const result = { ok: true, data: "open" };
        invoke.mockResolvedValueOnce(result);

        await expect(x509.getKeyState("SERIAL1")).resolves.toBe(result);
        expectInvoked("getKeyState", "SERIAL1");
    });

    it("calls logIntoKey correctly", async () => {
        const result = { ok: true, data: undefined };
        invoke.mockResolvedValueOnce(result);

        await expect(x509.logIntoKey("SERIAL1", "123456")).resolves.toBe(result);
        expectInvoked("logIntoKey", "SERIAL1", "123456");
    });

    it("calls signData correctly", async () => {
        const data = new Uint8Array([1, 2, 3]);
        const result = { ok: true, data: new Uint8Array([4, 5, 6]) };
        invoke.mockResolvedValueOnce(result);

        await expect(x509.signData("SERIAL1", data)).resolves.toBe(result);
        expectInvoked("signData", "SERIAL1", data);
    });
});
