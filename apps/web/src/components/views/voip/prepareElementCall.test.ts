/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { prepareCallSoon, prepareElementCall } from "./prepareElementCall";
import { loadElementCallComponent } from "./ElementCallLoader";
import { DesktopVoicePipeline } from "../../../audio/desktop/DesktopVoicePipeline";

vi.mock("./ElementCallLoader", () => ({ loadElementCallComponent: vi.fn() }));
vi.mock("../../../audio/DesktopVoiceSounds", () => ({ preloadDesktopVoiceSounds: vi.fn() }));
vi.mock("../../../audio/desktop/DesktopVoicePipeline", () => ({
    DesktopVoicePipeline: { instance: { prepare: vi.fn(), cancelPreparation: vi.fn() } },
}));

describe("prepareElementCall", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        vi.mocked(loadElementCallComponent).mockResolvedValue({} as never);
        vi.stubGlobal("requestIdleCallback", undefined);
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it("defers preparation, then releases the unused processor on logout", async () => {
        const cancel = prepareElementCall();
        expect(loadElementCallComponent).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1000);
        expect(loadElementCallComponent).toHaveBeenCalledOnce();
        expect(DesktopVoicePipeline.instance.prepare).toHaveBeenCalledOnce();
        cancel();
        expect(DesktopVoicePipeline.instance.cancelPreparation).toHaveBeenCalledOnce();
    });

    it("cancels idle work without creating a microphone pipeline", async () => {
        const idle = vi.fn().mockReturnValue(7);
        const cancelIdle = vi.fn();
        vi.stubGlobal("requestIdleCallback", idle);
        vi.stubGlobal("cancelIdleCallback", cancelIdle);
        const cancel = prepareElementCall();
        cancel();
        idle.mock.calls[0][0]();
        expect(cancelIdle).toHaveBeenCalledWith(7);
        expect(loadElementCallComponent).not.toHaveBeenCalled();
        expect(DesktopVoicePipeline.instance.prepare).not.toHaveBeenCalled();
        expect(DesktopVoicePipeline.instance.cancelPreparation).not.toHaveBeenCalled();
    });

    it("allows the foreground call to retry a failed background download", async () => {
        vi.mocked(loadElementCallComponent).mockRejectedValue(new Error("offline"));
        const cancel = prepareElementCall();
        await vi.advanceTimersByTimeAsync(1000);
        expect(DesktopVoicePipeline.instance.prepare).toHaveBeenCalledOnce();
        cancel();
    });

    it("prepares again when the person comes back or is about to join, but not after logout", async () => {
        const cancel = prepareElementCall();
        await vi.advanceTimersByTimeAsync(1000);
        expect(DesktopVoicePipeline.instance.prepare).toHaveBeenCalledTimes(1);

        window.dispatchEvent(new Event("focus"));
        prepareCallSoon();
        expect(DesktopVoicePipeline.instance.prepare).toHaveBeenCalledTimes(3);

        cancel();
        window.dispatchEvent(new Event("focus"));
        prepareCallSoon();
        expect(DesktopVoicePipeline.instance.prepare).toHaveBeenCalledTimes(3);
    });

    it("holds automatic idle scheduling until conversation paint while explicit voice intent works immediately", async () => {
        let release: (() => void) | undefined;
        const cancelWait = vi.fn();
        const cancel = prepareElementCall((start) => {
            release = start;
            return cancelWait;
        });
        await vi.advanceTimersByTimeAsync(5000);
        expect(loadElementCallComponent).not.toHaveBeenCalled();
        prepareCallSoon();
        expect(loadElementCallComponent).toHaveBeenCalledOnce();
        release?.();
        await vi.advanceTimersByTimeAsync(1000);
        expect(loadElementCallComponent).toHaveBeenCalledTimes(2);
        cancel();
        expect(cancelWait).toHaveBeenCalledOnce();
    });

    it("ignores focus and visibility changes until the scheduler releases automatic preparation", async () => {
        let release: (() => void) | undefined;
        const cancel = prepareElementCall((start) => {
            release = start;
            return vi.fn();
        });
        // Startup focus changes must not load the call engine before the first conversation paints.
        window.dispatchEvent(new Event("focus"));
        document.dispatchEvent(new Event("visibilitychange"));
        await vi.advanceTimersByTimeAsync(5000);
        expect(loadElementCallComponent).not.toHaveBeenCalled();
        expect(DesktopVoicePipeline.instance.prepare).not.toHaveBeenCalled();
        release?.();
        window.dispatchEvent(new Event("focus"));
        expect(DesktopVoicePipeline.instance.prepare).toHaveBeenCalledOnce();
        cancel();
        window.dispatchEvent(new Event("focus"));
        expect(DesktopVoicePipeline.instance.prepare).toHaveBeenCalledOnce();
    });

    it("starts automatic preparation once by a deadline when the scheduler never releases it", async () => {
        let release: (() => void) | undefined;
        const cancel = prepareElementCall((start) => {
            release = start;
            return vi.fn();
        });
        await vi.advanceTimersByTimeAsync(29_999);
        expect(loadElementCallComponent).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1 + 1000);
        expect(loadElementCallComponent).toHaveBeenCalledOnce();
        // A release arriving later does not prepare a second time.
        release?.();
        await vi.runAllTimersAsync();
        expect(loadElementCallComponent).toHaveBeenCalledOnce();
        window.dispatchEvent(new Event("focus"));
        expect(DesktopVoicePipeline.instance.prepare).toHaveBeenCalledTimes(2);
        cancel();
    });

    it("arms no deadline when the scheduler releases preparation at once", async () => {
        const cancel = prepareElementCall((start) => {
            start();
            return vi.fn();
        });
        await vi.advanceTimersByTimeAsync(1000);
        expect(loadElementCallComponent).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
        cancel();
    });

    it("ignores a late paint callback after logout", async () => {
        let release: (() => void) | undefined;
        const cancelWait = vi.fn();
        const cancel = prepareElementCall((start) => {
            release = start;
            return cancelWait;
        });
        cancel();
        release?.();
        prepareCallSoon();
        await vi.runAllTimersAsync();
        expect(loadElementCallComponent).not.toHaveBeenCalled();
        expect(cancelWait).toHaveBeenCalledOnce();
    });
});
