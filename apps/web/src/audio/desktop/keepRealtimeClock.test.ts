/*
Copyright 2026

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it, vi } from "vitest";

import { INAUDIBLE_LEVEL, keepRealtimeClock } from "./keepRealtimeClock";

describe("keepRealtimeClock", () => {
    it("plays a constant, inaudible but non-zero level to the speakers", () => {
        const source = { offset: { value: 1 }, connect: vi.fn(), start: vi.fn() };
        const context = { destination: {}, createConstantSource: vi.fn(() => source) };
        keepRealtimeClock(context as unknown as BaseAudioContext);
        expect(source.offset.value).toBe(INAUDIBLE_LEVEL);
        // Chromium only treats output as silent when every sample is exactly zero.
        expect(INAUDIBLE_LEVEL).toBeGreaterThan(0);
        // Well under the smallest step of 24-bit output, so no device can reproduce it.
        expect(INAUDIBLE_LEVEL).toBeLessThan(2 ** -24);
        expect(source.connect).toHaveBeenCalledWith(context.destination);
        expect(source.start).toHaveBeenCalledOnce();
    });
});
