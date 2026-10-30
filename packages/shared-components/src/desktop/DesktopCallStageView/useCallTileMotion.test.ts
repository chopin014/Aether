/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { act, renderHook } from "@test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useCallTileMotion } from "./useCallTileMotion";

describe("visible call artwork", () => {
    let intersection: IntersectionObserverCallback;
    let hidden: boolean;
    let reduced: boolean;
    let media: MediaQueryList;
    const disconnect = vi.fn();
    const surface = { current: document.createElement("div") };

    beforeEach(() => {
        hidden = reduced = false;
        disconnect.mockClear();
        media = new EventTarget() as MediaQueryList;
        Object.defineProperty(media, "matches", { get: () => reduced });
        vi.spyOn(window, "matchMedia").mockReturnValue(media);
        vi.spyOn(document, "visibilityState", "get").mockImplementation(() => (hidden ? "hidden" : "visible"));
        vi.stubGlobal(
            "IntersectionObserver",
            class {
                public constructor(callback: IntersectionObserverCallback) {
                    intersection = callback;
                }
                public observe = vi.fn();
                public disconnect = disconnect;
            },
        );
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    const show = (visible: boolean): void => {
        act(() => intersection([{ isIntersecting: visible } as IntersectionObserverEntry], {} as IntersectionObserver));
    };

    it("plays without hovering while visible and pauses when scrolled away or minimized", () => {
        const { result, unmount } = renderHook(() => useCallTileMotion(surface, true));
        expect(result.current).toBe(false);
        show(true);
        expect(result.current).toBe(true);
        show(false);
        expect(result.current).toBe(false);
        show(true);
        expect(result.current).toBe(true);
        act(() => {
            hidden = true;
            document.dispatchEvent(new Event("visibilitychange"));
        });
        expect(result.current).toBe(false);
        act(() => {
            hidden = false;
            document.dispatchEvent(new Event("visibilitychange"));
        });
        expect(result.current).toBe(true);
        unmount();
        expect(disconnect).toHaveBeenCalledOnce();
    });

    it("pauses when navigating from the call to chat and resumes when returning", () => {
        const { result, rerender } = renderHook(({ enabled }) => useCallTileMotion(surface, enabled), {
            initialProps: { enabled: true },
        });
        show(true);
        expect(result.current).toBe(true);
        rerender({ enabled: false });
        expect(result.current).toBe(false);
        rerender({ enabled: true });
        show(true);
        expect(result.current).toBe(true);
    });

    it("respects reduced motion and follows changes to that preference", () => {
        reduced = true;
        const { result } = renderHook(() => useCallTileMotion(surface, true));
        show(true);
        expect(result.current).toBe(false);
        act(() => {
            reduced = false;
            media.dispatchEvent(new Event("change"));
        });
        expect(result.current).toBe(true);
        act(() => {
            reduced = true;
            media.dispatchEvent(new Event("change"));
        });
        expect(result.current).toBe(false);
    });
});
