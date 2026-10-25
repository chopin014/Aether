/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScreenShareAudioEvent, ScreenShareAudioRequest } from "shared-types";
import { ShareAudioController } from "./ShareAudioController.js";
import type { ShareAudioCallbacks, ShareAudioProvider, ShareAudioSession } from "./types.js";

describe("ShareAudioController", () => {
    let callbacks: ShareAudioCallbacks;
    let controller: ShareAudioController;
    let provider: ShareAudioProvider;
    let events: ScreenShareAudioEvent[];
    let session: ShareAudioSession;
    let now: number;
    const request: ScreenShareAudioRequest = {
        id: "capture-1",
        videoSourceId: "screen:1:0",
        target: { kind: "system" },
    };

    beforeEach(() => {
        now = 100;
        events = [];
        session = { stop: vi.fn(async () => undefined) };
        provider = {
            capabilities: vi.fn(async () => ({ system: true, window: true, application: true })),
            listApplications: vi.fn(async () => []),
            resolveWindow: vi.fn(async () => "native-approved-window"),
            start: vi.fn(async (_target, _excluded, handlers) => {
                callbacks = handlers;
                return session;
            }),
        };
        controller = new ShareAudioController(
            provider,
            (event) => events.push(event),
            () => [101, 102],
            () => now,
        );
    });

    it("requires a matching, recent, single-use desktop picker grant", async () => {
        await expect(controller.start(request)).rejects.toThrow("approved video source");
        controller.authorizeVideo("screen:other");
        await expect(controller.start(request)).rejects.toThrow("approved video source");
        controller.authorizeVideo(request.videoSourceId);
        now += 30_001;
        await expect(controller.start(request)).rejects.toThrow("approved video source");
        controller.authorizeVideo(request.videoSourceId);
        await controller.start(request);
        expect(provider.start).toHaveBeenCalledWith(
            { kind: "system" },
            [101, 102],
            expect.any(Object),
            expect.any(AbortSignal),
        );
        await controller.stop(request.id);
        await expect(controller.start(request)).rejects.toThrow("approved video source");
    });

    it.each([
        null,
        {},
        { ...request, id: "bad id" },
        { ...request, target: { kind: "pid", id: 42 } },
        { ...request, target: { kind: "application", id: "" } },
    ])("rejects invalid IPC input %j", async (value) => {
        controller.authorizeVideo(request.videoSourceId);
        await expect(controller.start(value)).rejects.toThrow("Invalid screen audio request");
        expect(provider.start).not.toHaveBeenCalled();
    });

    it("resolves window audio through the provider and never broadens an unknown window", async () => {
        controller.authorizeVideo("window:123:0");
        await controller.start({ ...request, videoSourceId: "window:123:0", target: { kind: "window" } });
        expect(provider.start).toHaveBeenCalledWith(
            { kind: "application", id: "native-approved-window" },
            [101, 102],
            expect.any(Object),
            expect.any(AbortSignal),
        );
        await controller.stop(request.id);
        vi.mocked(provider.resolveWindow).mockResolvedValueOnce(null);
        controller.authorizeVideo("window:456:0");
        await expect(
            controller.start({ ...request, videoSourceId: "window:456:0", target: { kind: "window" } }),
        ).rejects.toThrow("cannot be identified");
        expect(provider.start).toHaveBeenCalledTimes(1);
    });

    it("caps unacknowledged PCM at eight packets and rejects stale acknowledgements", async () => {
        controller.authorizeVideo(request.videoSourceId);
        await controller.start(request);
        callbacks.onData(Buffer.alloc(7680 * 20, 1));
        expect(events).toHaveLength(8);
        expect(events.every((event) => event.type === "data" && event.pcm.length === 7680)).toBe(true);
        controller.acknowledge("previous-capture", 1);
        callbacks.onData(Buffer.alloc(8));
        expect(events).toHaveLength(8);
        controller.acknowledge(request.id, 1);
        callbacks.onData(Buffer.alloc(8, 7));
        expect(events).toHaveLength(9);
        expect(events[8]).toMatchObject({ type: "data", sequence: 9, pcm: new Uint8Array(8).fill(7) });
    });

    it("preserves stereo frame boundaries across pipe chunks", async () => {
        controller.authorizeVideo(request.videoSourceId);
        await controller.start(request);
        callbacks.onData(Buffer.from([1, 2, 3]));
        expect(events).toHaveLength(0);
        callbacks.onData(Buffer.from([4, 5, 6, 7, 8, 9]));
        expect(events[0]).toMatchObject({ pcm: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]) });
        callbacks.onData(Buffer.from([10, 11, 12, 13, 14, 15, 16]));
        expect(events[1]).toMatchObject({ pcm: Uint8Array.from([9, 10, 11, 12, 13, 14, 15, 16]) });
    });

    it("cleans up a late native start after cancellation and ignores its audio", async () => {
        let ready!: (value: ShareAudioSession) => void;
        vi.mocked(provider.start).mockImplementationOnce((_target, _excluded, handlers) => {
            callbacks = handlers;
            return new Promise((resolve) => {
                ready = resolve;
            });
        });
        controller.authorizeVideo(request.videoSourceId);
        const outcome = controller.start(request).catch((error: unknown) => error);
        await controller.stop(request.id);
        callbacks.onData(Buffer.alloc(8));
        ready(session);
        expect(await outcome).toMatchObject({ message: "Screen audio request was cancelled" });
        expect(session.stop).toHaveBeenCalledTimes(1);
        expect(events).toEqual([{ type: "stopped", id: request.id }]);
    });

    it("terminates once on native failure and revokes capture on navigation or a new share", async () => {
        controller.authorizeVideo(request.videoSourceId);
        await controller.start(request);
        callbacks.onError(new Error("device lost"));
        callbacks.onStopped();
        callbacks.onData(Buffer.alloc(8));
        expect(events).toEqual([{ type: "stopped", id: request.id, error: "device lost" }]);
        expect(session.stop).toHaveBeenCalledTimes(1);
        controller.authorizeVideo(request.videoSourceId);
        await controller.start(request);
        await controller.reset();
        await expect(controller.start(request)).rejects.toThrow("approved video source");
        controller.authorizeVideo(request.videoSourceId);
        await controller.start(request);
        controller.authorizeVideo("screen:replacement");
        expect(events.filter((event) => event.type === "stopped")).toHaveLength(3);
    });

    it("stops startup before native capture if window resolution was cancelled", async () => {
        let resolve!: (id: string) => void;
        vi.mocked(provider.resolveWindow).mockReturnValueOnce(
            new Promise((ready) => {
                resolve = ready;
            }),
        );
        controller.authorizeVideo(request.videoSourceId);
        const outcome = controller.start({ ...request, target: { kind: "window" } }).catch((error: unknown) => error);
        await controller.reset();
        resolve("native-approved");
        expect(await outcome).toMatchObject({ message: "Screen audio request was cancelled" });
        expect(provider.start).not.toHaveBeenCalled();
    });
});
