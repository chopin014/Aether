/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { act, renderHook } from "test-utils-rtl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import UIStore, { UI_EVENTS } from "../stores/UIStore";
import { computeAnchoredPopoverPosition, useAnchoredPopoverPosition } from "./useAnchoredPopoverPosition";

describe("computeAnchoredPopoverPosition", () => {
    it("right-aligns to the trigger and sits 8px below it", () => {
        expect(computeAnchoredPopoverPosition({ right: 900, bottom: 48 }, { width: 1280, height: 720 })).toEqual({
            top: 56,
            left: 420,
            width: 480,
            availableHeight: 664,
        });
    });

    it("clamps to the left edge of the viewport", () => {
        const { left } = computeAnchoredPopoverPosition({ right: 200, bottom: 48 }, { width: 1280, height: 720 });
        expect(left).toBe(8);
    });

    it("clamps to the right edge of the viewport", () => {
        const { left, width } = computeAnchoredPopoverPosition(
            { right: 1400, bottom: 48 },
            { width: 1280, height: 720 },
        );
        expect(left + width).toBe(1272);
    });

    it("shrinks to the viewport minus the gaps on narrow windows", () => {
        expect(computeAnchoredPopoverPosition({ right: 700, bottom: 48 }, { width: 400, height: 720 })).toMatchObject({
            left: 8,
            width: 384,
        });
    });

    it("keeps the top inside the viewport", () => {
        const { top, availableHeight } = computeAnchoredPopoverPosition(
            { right: 700, bottom: 900 },
            { width: 1280, height: 720 },
        );
        expect(top).toBe(712);
        expect(availableHeight).toBe(8);
    });
});

describe("useAnchoredPopoverPosition", () => {
    let right: number;
    let observe: ReturnType<typeof vi.fn>;
    let disconnect: ReturnType<typeof vi.fn>;
    let resizeCallback: () => void;
    const trigger = { current: null as HTMLElement | null };

    beforeEach(() => {
        right = 900;
        observe = vi.fn();
        disconnect = vi.fn();
        vi.stubGlobal(
            "ResizeObserver",
            class {
                public constructor(cb: () => void) {
                    resizeCallback = cb;
                }
                public observe = observe;
                public disconnect = disconnect;
            },
        );
        trigger.current = document.createElement("button");
        vi.spyOn(trigger.current, "getBoundingClientRect").mockImplementation(() => ({ right, bottom: 48 }) as DOMRect);
        vi.spyOn(UIStore.instance, "windowWidth", "get").mockReturnValue(1280);
        vi.spyOn(UIStore.instance, "windowHeight", "get").mockReturnValue(720);
    });
    afterEach(() => vi.unstubAllGlobals());

    it("places on mount and follows window resize, scroll and trigger resize", () => {
        const apply = vi.fn();
        renderHook(() => useAnchoredPopoverPosition(true, trigger, apply));
        expect(apply).toHaveBeenLastCalledWith(expect.objectContaining({ left: 420, top: 56 }));
        expect(observe).toHaveBeenCalledWith(trigger.current);

        right = 700;
        act(() => {
            UIStore.instance.emit(UI_EVENTS.Resize);
        });
        expect(apply).toHaveBeenLastCalledWith(expect.objectContaining({ left: 220 }));

        right = 600;
        act(() => {
            window.dispatchEvent(new Event("scroll"));
        });
        expect(apply).toHaveBeenLastCalledWith(expect.objectContaining({ left: 120 }));

        right = 800;
        act(() => {
            resizeCallback();
        });
        expect(apply).toHaveBeenLastCalledWith(expect.objectContaining({ left: 320 }));
    });

    it("does nothing while inactive and cleans up on unmount", () => {
        const apply = vi.fn();
        const inactive = renderHook(() => useAnchoredPopoverPosition(false, trigger, apply));
        expect(apply).not.toHaveBeenCalled();
        inactive.unmount();

        const active = renderHook(() => useAnchoredPopoverPosition(true, trigger, apply));
        apply.mockClear();
        active.unmount();
        expect(disconnect).toHaveBeenCalled();
        act(() => {
            UIStore.instance.emit(UI_EVENTS.Resize);
        });
        window.dispatchEvent(new Event("scroll"));
        expect(apply).not.toHaveBeenCalled();
    });
});
