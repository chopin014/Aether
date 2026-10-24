/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

// Exercise the actual installed fork extension: a mock host alone cannot catch publication-order regressions.
const require = createRequire(import.meta.url);
const bundle = readFileSync(
    path.join(path.dirname(require.resolve("@element-hq/element-call-component")), "element-call.js"),
    "utf8",
);
const start = bundle.indexOf("async function aetherCreateMicrophoneTracks(");
const end = bundle.indexOf("\nvar U4 = class", start);
const capture = runInNewContext(`${bundle.slice(start, end)}; aetherCreateMicrophoneTracks`, {
    aetherAudio: {},
    Z: { Kind: { Audio: "audio" }, Source: { ScreenShareAudio: "screen_share_audio" } },
}) as (room: unknown, create: unknown, options: unknown) => Promise<unknown>;

function fixture() {
    const processor = { init: vi.fn(), destroy: vi.fn(), processedTrack: undefined as unknown };
    const track = { kind: "audio", source: "microphone", stop: vi.fn(), setProcessor: vi.fn() };
    const audio = { microphoneProcessor: { createProcessor: vi.fn(() => processor) } };
    const helper = runInNewContext(`${bundle.slice(start, end)}; aetherCreateMicrophoneTracks`, {
        aetherAudio: audio,
        Z: { Kind: { Audio: "audio" }, Source: { ScreenShareAudio: "screen_share_audio" } },
    }) as typeof capture;
    const room = { acquireAudioContext: vi.fn().mockResolvedValue(undefined), audioContext: {} };
    const create = vi.fn().mockResolvedValue([track]);
    return { helper, processor, track, audio, room, create };
}

describe("Element Call microphone publication boundary", () => {
    it("waits for processed capture before returning a track LiveKit can publish", async () => {
        const { helper, processor, track, room, create } = fixture();
        let resolve!: () => void;
        track.setProcessor.mockImplementation(
            () =>
                new Promise<void>((r) => {
                    resolve = r;
                }),
        );
        const published = vi.fn();
        const pending = helper(room, create, { audio: true }).then(published);
        await vi.waitFor(() => expect(track.setProcessor).toHaveBeenCalledWith(processor));
        expect(published).not.toHaveBeenCalled();
        processor.processedTrack = { id: "processed" };
        resolve();
        await pending;
        expect(published).toHaveBeenCalledWith([track]);
        expect(room.acquireAudioContext.mock.invocationCallOrder[0]).toBeLessThan(create.mock.invocationCallOrder[0]);
    });

    it.each(["initialization failed", "no processed track"])("does not publish raw audio when %s", async (failure) => {
        const { helper, processor, track, room, create } = fixture();
        if (failure === "initialization failed") track.setProcessor.mockRejectedValue(new Error("blocked worklet"));
        else track.setProcessor.mockResolvedValue(undefined);
        await expect(helper(room, create, { audio: true })).rejects.toThrow();
        expect(track.stop).toHaveBeenCalledOnce();
        expect(processor.destroy).toHaveBeenCalledOnce();
    });

    it("does not open a microphone when the required audio context cannot start", async () => {
        const { helper, room, create } = fixture();
        room.acquireAudioContext.mockRejectedValue(new Error("audio unavailable"));
        await expect(helper(room, create, { audio: true })).rejects.toThrow("audio unavailable");
        expect(create).not.toHaveBeenCalled();
    });

    it("keeps video-only and flag-off capture paths unchanged", async () => {
        const { helper, room, create } = fixture();
        await helper(room, create, { audio: false, video: true });
        expect(room.acquireAudioContext).not.toHaveBeenCalled();
        expect(create).toHaveBeenCalledWith({ audio: false, video: true });
        await capture(room, create, { audio: true });
        expect(create).toHaveBeenCalledTimes(2);
    });
});
