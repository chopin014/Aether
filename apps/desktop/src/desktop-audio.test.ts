/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";
import type { DesktopAudioPacket } from "shared-types";

import { DesktopAudioCapture, setupDesktopAudio } from "./desktop-audio.js";

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
