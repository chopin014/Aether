/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { act, renderHook } from "@test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useProfileMotion } from "./useProfileMotion";

function stubReducedMotion(reduced: boolean): void {
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: reduced } as MediaQueryList);
}

describe("useProfileMotion", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it("plays when opened, then settles until the pointer returns", () => {
        vi.useFakeTimers();
        stubReducedMotion(false);
        const { result } = renderHook(() => useProfileMotion());
        expect(result.current.live).toBe(true);
        act(() => {
            vi.advanceTimersByTime(8000);
        });
        expect(result.current.live).toBe(false);
        act(() => result.current.bind.onPointerEnter());
        expect(result.current.live).toBe(true);
        expect(result.current.bind.style).toMatchObject({ "--profile-motion": "running" });
        act(() => result.current.bind.onPointerLeave());
        expect(result.current.live).toBe(false);
        expect(result.current.bind.style).toMatchObject({ "--profile-motion": "paused" });
    });

    it("stays still until asked when there is no opening animation, and follows keyboard focus", () => {
        stubReducedMotion(false);
        const { result } = renderHook(() => useProfileMotion(false));
        expect(result.current.live).toBe(false);
        act(() => result.current.bind.onFocus());
        expect(result.current.live).toBe(true);
        act(() => result.current.bind.onBlur());
        expect(result.current.live).toBe(false);
    });

    it("never moves for someone who asked for reduced motion", () => {
        stubReducedMotion(true);
        const { result } = renderHook(() => useProfileMotion());
        expect(result.current.live).toBe(false);
        act(() => result.current.bind.onPointerEnter());
        expect(result.current.live).toBe(false);
    });
});
