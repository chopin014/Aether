/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";
import type { DesktopAudioPacket } from "shared-types";

import {
    answerPlaybackReferenceRequest,
    DesktopAudioCapture,
    selectPortalDesktopAudio,
    setupDesktopAudio,
} from "./desktop-audio.js";

const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, value: unknown) => unknown>() }));
vi.mock("electron", () => ({
    ipcMain: {
        handle: vi.fn((channel, callback) => handlers.set(channel, callback)),
        removeHandler: vi.fn(),
    },
}));

function fixture() {
    const listeners = new Map<string, () => void>();
    const owner = {
        on: vi.fn((event, callback) => listeners.set(event, callback)),
        send: vi.fn(),
        isDestroyed: () => false,
    };
    const native = {
        isAvailable: () => true,
        getPidFromWindowHandle: vi.fn(() => 123),
        startCapture: vi.fn<
            (
                pid: number,
                include: boolean,
                callback: (data: Buffer, format: Omit<DesktopAudioPacket, "data" | "sessionId">) => void,
            ) => boolean
        >(() => true),
        stopCapture: vi.fn(),
    };
    const capture = new DesktopAudioCapture(owner as unknown as WebContents, native);
    return { capture, native, owner, listeners };
}

describe("DesktopAudioCapture", () => {
    it.each(["screen:1:0", "window:456:0"])("captures %s with the correct process-tree mode", (source) => {
        const { capture, native } = fixture();
        capture.select(source, true);
        expect(capture.start("session")).toBe(true);
        expect(native.startCapture).toHaveBeenCalledWith(
            source.startsWith("window") ? 123 : process.pid,
            source.startsWith("window"),
            expect.any(Function),
        );
        capture.stop("session");
        expect(native.stopCapture).toHaveBeenCalledOnce();
    });

    it.each(["", "window:bad", "window:-1:0"])("rejects invalid or cancelled source %s", (source) => {
        const { capture, native } = fixture();
        capture.select(source, true);
        expect(capture.start("session")).toBe(false);
        expect(native.startCapture).not.toHaveBeenCalled();
    });

    it("never captures unrequested audio or reuses a previous confirmation", () => {
        const { capture, native } = fixture();
        capture.select("screen:1:0", false);
        expect(capture.start("one")).toBe(false);
        capture.select("screen:1:0", true);
        capture.start("two");
        capture.stop("two");
        expect(capture.start("three")).toBe(false);
        expect(native.startCapture).toHaveBeenCalledOnce();
    });

    it("fails instead of leaking system audio when the selected application has gone away", () => {
        const { capture, native } = fixture();
        native.getPidFromWindowHandle.mockReturnValue(0);
        capture.select("window:456:0", true);
        expect(() => capture.start("session")).toThrow("Cannot resolve");
        expect(native.startCapture).not.toHaveBeenCalled();
    });

    it("ignores late cleanup and stops capture on renderer teardown", () => {
        const { capture, native, listeners } = fixture();
        capture.select("screen:1:0", true);
        capture.start("one");
        capture.stop("old");
        expect(native.stopCapture).not.toHaveBeenCalled();
        listeners.get("render-process-gone")!();
        expect(native.stopCapture).toHaveBeenCalledOnce();
        expect(capture.start("two")).toBe(false);
    });

    it("forwards only packets from the active capture session", () => {
        const { capture, native, owner } = fixture();
        capture.select("window:456:0", true);
        capture.start("one");
        const deliver = native.startCapture.mock.calls[0][2];
        const data = Buffer.alloc(16);
        const format = { sampleRate: 48000, channels: 2, bitsPerSample: 32, isFloat: true };
        deliver(data, format);
        expect(owner.send).toHaveBeenCalledExactlyOnceWith("aether:desktop-audio-data", {
            data,
            ...format,
            sessionId: "one",
        });
        capture.stop("one");
        deliver(data, format);
        expect(owner.send).toHaveBeenCalledOnce();
    });

    it("captures system audio without Aether for a Wayland portal source", () => {
        const { capture, native } = fixture();
        capture.selectPortal(true);
        expect(capture.start("session")).toBe(true);
        // The portal hides the chosen application, so its id is never treated as a window handle.
        expect(native.getPidFromWindowHandle).not.toHaveBeenCalled();
        expect(native.startCapture).toHaveBeenCalledWith(process.pid, false, expect.any(Function));
        capture.stop("session");
        expect(capture.start("again")).toBe(false);
    });

    it("uses the audio preference sent before a Wayland portal capture, once", () => {
        const owner = { on: vi.fn(), mainFrame: {}, isDestroyed: () => false } as unknown as WebContents;
        const native = fixture().native;
        setupDesktopAudio(owner, native);
        const event = { sender: owner, senderFrame: owner.mainFrame };
        const prepare = handlers.get("aether:desktop-audio-prepare")!;
        const start = handlers.get("aether:desktop-audio-start")!;

        prepare(event, true);
        selectPortalDesktopAudio("window:1:0:s");
        expect(start(event, "one")).toBe(true);
        handlers.get("aether:desktop-audio-stop")!(event, "one");

        // The preference is consumed by one portal selection.
        selectPortalDesktopAudio("window:2:0:s");
        expect(start(event, "two")).toBe(false);

        prepare(event, false);
        selectPortalDesktopAudio("window:3:0:s");
        expect(start(event, "three")).toBe(false);

        // A cancelled portal returns no source.
        prepare(event, true);
        selectPortalDesktopAudio("");
        expect(start(event, "four")).toBe(false);
        expect(native.startCapture).toHaveBeenCalledOnce();
    });

    it("restricts audio IPC to the owning main frame", () => {
        const owner = { on: vi.fn(), mainFrame: {} } as unknown as WebContents;
        setupDesktopAudio(owner);
        for (const channel of ["prepare", "start", "stop"]) {
            const handler = handlers.get(`aether:desktop-audio-${channel}`)!;
            expect(() => handler({ sender: {}, senderFrame: owner.mainFrame }, "one")).toThrow("Invalid audio sender");
            expect(() => handler({ sender: owner, senderFrame: {} }, "one")).toThrow("Invalid audio sender");
        }
        const event = { sender: owner, senderFrame: owner.mainFrame };
        handlers.get("aether:desktop-audio-prepare")!(event, true);
        expect(handlers.get("aether:desktop-audio-start")!(event, "one")).toBe(false);
        handlers.get("aether:desktop-audio-stop")!(event, "one");
    });

    it("cleans up native initialization failures", () => {
        const { capture, native } = fixture();
        native.startCapture.mockImplementation(() => {
            throw Error("device unavailable");
        });
        capture.select("window:456:0", true);
        expect(() => capture.start("one")).toThrow("device unavailable");
        expect(native.stopCapture).toHaveBeenCalledOnce();
    });
});

describe("answerPlaybackReferenceRequest", () => {
    function setup() {
        const owner = { on: vi.fn(), mainFrame: {}, isDestroyed: () => false } as unknown as WebContents;
        setupDesktopAudio(owner);
        const prepare = (): unknown =>
            handlers.get("aether:playback-reference-prepare")!(
                { sender: owner, senderFrame: owner.mainFrame },
                undefined,
            );
        const audioOnly = { frame: owner.mainFrame, audioRequested: true, videoRequested: false };
        return { owner, prepare, audioOnly };
    }

    it("answers the audio-only capture the app's page asked for with the system loopback, once", () => {
        const { prepare, audioOnly } = setup();
        prepare();
        const callback = vi.fn();
        expect(answerPlaybackReferenceRequest(audioOnly, callback)).toBe(true);
        expect(callback).toHaveBeenCalledWith({ audio: "loopback" });
        expect(answerPlaybackReferenceRequest(audioOnly, vi.fn())).toBe(false);
    });

    it("leaves screen shares to the picker, even right after the page asked", () => {
        const { prepare, audioOnly } = setup();
        prepare();
        const callback = vi.fn();
        expect(answerPlaybackReferenceRequest({ ...audioOnly, videoRequested: true }, callback)).toBe(false);
        expect(callback).not.toHaveBeenCalled();
    });

    it("answers nothing the page did not ask for, nor any other frame", () => {
        const { prepare, audioOnly } = setup();
        expect(answerPlaybackReferenceRequest(audioOnly, vi.fn())).toBe(false);
        prepare();
        const callback = vi.fn();
        expect(answerPlaybackReferenceRequest({ ...audioOnly, frame: {} as Electron.WebFrameMain }, callback)).toBe(
            false,
        );
        expect(callback).not.toHaveBeenCalled();
    });

    it("forgets a request that waited too long", () => {
        vi.useFakeTimers();
        try {
            const { prepare, audioOnly } = setup();
            prepare();
            vi.advanceTimersByTime(6000);
            expect(answerPlaybackReferenceRequest(audioOnly, vi.fn())).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    it("only lets the app's own page ask", () => {
        const { owner } = setup();
        expect(() =>
            handlers.get("aether:playback-reference-prepare")!({ sender: {}, senderFrame: owner.mainFrame }, undefined),
        ).toThrow("Invalid audio sender");
    });
});
