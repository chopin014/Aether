/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AFTER_PAINT_DEADLINE_MS, afterNextPaint } from "./afterNextPaint";

describe("afterNextPaint", () => {
    let frames: FrameRequestCallback[];

    beforeEach(() => {
        vi.useFakeTimers();
        frames = [];
        vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => frames.push(callback));
        vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    const nextFrame = (): void => frames.splice(0).forEach((frame) => frame(0));

    it("runs in the task after the frame that follows the next one, once", () => {
        const work = vi.fn();
        afterNextPaint(work);
        expect(work).not.toHaveBeenCalled();
        // The next frame may come before updates made now are rendered.
        nextFrame();
        vi.advanceTimersByTime(0);
        expect(work).not.toHaveBeenCalled();
        nextFrame();
        expect(work).not.toHaveBeenCalled();
        vi.advanceTimersByTime(0);
        expect(work).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(AFTER_PAINT_DEADLINE_MS);
        expect(work).toHaveBeenCalledTimes(1);
    });

    it("runs by the deadline in a window that paints no frames", () => {
        const work = vi.fn();
        afterNextPaint(work);
        vi.advanceTimersByTime(AFTER_PAINT_DEADLINE_MS - 1);
        expect(work).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(work).toHaveBeenCalledTimes(1);
    });

    it("does not run once cancelled", () => {
        const work = vi.fn();
        afterNextPaint(work)();
        nextFrame();
        vi.advanceTimersByTime(AFTER_PAINT_DEADLINE_MS);
        expect(work).not.toHaveBeenCalled();
    });
});
