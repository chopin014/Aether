/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CAPTURE_LINGER_MS, lingerCapture } from "./lingerCapture";

describe("lingerCapture", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    const capturedTrack = (): { track: MediaStreamTrack; clone: { enabled: boolean; stop: () => void } } => {
        const clone = { enabled: true, stop: vi.fn() };
        const track = { clone: vi.fn(() => clone) } as unknown as MediaStreamTrack;
        return { track, clone };
    };

    it("holds a silent clone of the capture and stops it only once the linger has passed", () => {
        const { track, clone } = capturedTrack();
        const release = lingerCapture(track);
        expect(clone.enabled).toBe(false);
        release();
        vi.advanceTimersByTime(CAPTURE_LINGER_MS - 1);
        expect(clone.stop).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(clone.stop).toHaveBeenCalledOnce();
    });

    it("releases once however many times it is asked", () => {
        const { track, clone } = capturedTrack();
        const release = lingerCapture(track);
        release();
        release();
        vi.advanceTimersByTime(CAPTURE_LINGER_MS * 2);
        expect(clone.stop).toHaveBeenCalledOnce();
    });

    it("does nothing for a track that cannot be cloned", () => {
        const track = {
            clone: () => {
                throw new Error("ended");
            },
        } as unknown as MediaStreamTrack;
        expect(() => lingerCapture(track)()).not.toThrow();
    });
});
