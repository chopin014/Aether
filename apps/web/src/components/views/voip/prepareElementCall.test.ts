/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type MatrixClient, type Room } from "matrix-js-sdk/src/matrix";

import {
    BACKGROUND_TOKEN_LIMIT,
    BACKGROUND_TOKEN_WINDOW_MS,
    prepareCallInBackground,
    prepareCallSoon,
    prepareElementCall,
    PREFLIGHT_CACHE_MS,
    TOKEN_REFRESH_MS,
} from "./prepareElementCall";
import { loadElementCallComponent, prefetchElementCallTransport } from "./ElementCallLoader";
import { DesktopVoicePipeline } from "../../../audio/desktop/DesktopVoicePipeline";
import { getCallOpenIdToken } from "./ElementCallOpenIdToken";

vi.mock("./ElementCallLoader", () => ({ loadElementCallComponent: vi.fn(), prefetchElementCallTransport: vi.fn() }));
vi.mock("./ElementCallOpenIdToken", () => ({ getCallOpenIdToken: vi.fn() }));
vi.mock("../../../audio/DesktopVoiceSounds", () => ({ preloadDesktopVoiceSounds: vi.fn() }));
vi.mock("../../../audio/desktop/DesktopVoicePipeline", () => ({
    DesktopVoicePipeline: { instance: { prepare: vi.fn(), cancelPreparation: vi.fn() } },
}));

describe("prepareElementCall", () => {
    const getStateEvent = vi.fn();
    const client = {
        getUserId: () => "@alice:example.org",
        getDeviceId: () => "ALICE",
        getStateEvent,
    } as unknown as MatrixClient;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        vi.mocked(loadElementCallComponent).mockResolvedValue({} as never);
        vi.mocked(getCallOpenIdToken).mockResolvedValue({} as never);
        vi.mocked(prefetchElementCallTransport).mockResolvedValue(undefined);
        getStateEvent.mockRejectedValue(new Error("M_NOT_FOUND"));
        vi.stubGlobal("requestIdleCallback", undefined);
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it("defers preparation, then releases the unused processor on logout", async () => {
        const cancel = prepareElementCall(client);
        expect(loadElementCallComponent).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1000);
        expect(loadElementCallComponent).toHaveBeenCalledOnce();
        expect(DesktopVoicePipeline.instance.prepare).toHaveBeenCalledOnce();
        expect(getCallOpenIdToken).toHaveBeenCalledWith(client);
        cancel();
        expect(DesktopVoicePipeline.instance.cancelPreparation).toHaveBeenCalledOnce();
    });

    it("keeps preparing when the OpenID token cannot be fetched", async () => {
        vi.mocked(getCallOpenIdToken).mockRejectedValue(new Error("offline"));
        const cancel = prepareElementCall(client);
        await vi.advanceTimersByTimeAsync(1000);
        expect(loadElementCallComponent).toHaveBeenCalledOnce();
        expect(DesktopVoicePipeline.instance.prepare).toHaveBeenCalledOnce();
        cancel();
    });

    it("cancels idle work without creating a microphone pipeline", async () => {
        const idle = vi.fn().mockReturnValue(7);
        const cancelIdle = vi.fn();
        vi.stubGlobal("requestIdleCallback", idle);
        vi.stubGlobal("cancelIdleCallback", cancelIdle);
        const cancel = prepareElementCall(client);
        cancel();
        idle.mock.calls[0][0]();
        expect(cancelIdle).toHaveBeenCalledWith(7);
        expect(loadElementCallComponent).not.toHaveBeenCalled();
        expect(DesktopVoicePipeline.instance.prepare).not.toHaveBeenCalled();
        expect(DesktopVoicePipeline.instance.cancelPreparation).not.toHaveBeenCalled();
    });

    it("allows the foreground call to retry a failed background download", async () => {
        vi.mocked(loadElementCallComponent).mockRejectedValue(new Error("offline"));
        const cancel = prepareElementCall(client);
        await vi.advanceTimersByTimeAsync(1000);
        expect(DesktopVoicePipeline.instance.prepare).toHaveBeenCalledOnce();
        cancel();
    });

    it("prepares again when the person comes back or is about to join, but not after logout", async () => {
        const cancel = prepareElementCall(client);
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
        const cancel = prepareElementCall(client, (start) => {
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
        const cancel = prepareElementCall(client, (start) => {
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
        const cancel = prepareElementCall(client, (start) => {
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
        const cancel = prepareElementCall(client, (start) => {
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
        const cancel = prepareElementCall(client, (start) => {
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

    describe("call tokens", () => {
        const room = (roomId: string, version = "11"): Room => ({ roomId, getVersion: () => version }) as Room;
        const fetched = (): string[] => vi.mocked(prefetchElementCallTransport).mock.calls.map(([, roomId]) => roomId);

        it("fetches a room's token at once when someone is about to join it, even before release", async () => {
            const cancel = prepareElementCall(client, () => vi.fn());
            prepareCallSoon(room("!voice"));
            expect(fetched()).toEqual(["!voice"]);
            cancel();
        });

        it("readies the membership write when someone is about to join, once per preflight lifetime", async () => {
            const cancel = prepareElementCall(client, () => vi.fn());
            prepareCallSoon(room("!voice"));
            prepareCallSoon(room("!voice"));
            expect(getStateEvent).toHaveBeenCalledExactlyOnceWith(
                "!voice",
                "org.matrix.msc3401.call.member",
                "_@alice:example.org_ALICE_m.call",
            );
            await vi.advanceTimersByTimeAsync(PREFLIGHT_CACHE_MS);
            prepareCallSoon(room("!other", "org.matrix.msc3757.10"));
            expect(getStateEvent).toHaveBeenLastCalledWith(
                "!other",
                "org.matrix.msc3401.call.member",
                "@alice:example.org_ALICE_m.call",
            );
            // Background fetches are not intent to join: no preflight for them.
            getStateEvent.mockClear();
            prepareCallInBackground(room("!listed"));
            expect(getStateEvent).not.toHaveBeenCalled();
            cancel();
        });

        it("fetches tokens in the background one at a time, only once released", async () => {
            let release: (() => void) | undefined;
            let finishFirst: (() => void) | undefined;
            vi.mocked(prefetchElementCallTransport).mockImplementationOnce(
                () => new Promise<void>((resolve) => (finishFirst = resolve)),
            );
            const cancel = prepareElementCall(client, (start) => {
                release = start;
                return vi.fn();
            });
            prepareCallInBackground(room("!a"));
            prepareCallInBackground(room("!b"));
            await vi.advanceTimersByTimeAsync(5000);
            expect(fetched()).toEqual([]);
            release?.();
            await vi.advanceTimersByTimeAsync(0);
            expect(fetched()).toEqual(["!a"]);
            finishFirst?.();
            await vi.advanceTimersByTimeAsync(0);
            expect(fetched()).toEqual(["!a", "!b"]);
            cancel();
        });

        it("limits background fetches per window and skips rooms fetched recently", async () => {
            const cancel = prepareElementCall(client);
            prepareCallInBackground(room("!seen"));
            await vi.advanceTimersByTimeAsync(0);
            prepareCallInBackground(room("!seen"));
            await vi.advanceTimersByTimeAsync(0);
            expect(fetched()).toEqual(["!seen"]);
            for (let i = 1; i <= BACKGROUND_TOKEN_LIMIT; i++) {
                prepareCallInBackground(room(`!r${i}`));
                await vi.advanceTimersByTimeAsync(0);
            }
            // The first fetch and LIMIT - 1 others fill the window; the last room waits for the next one.
            expect(fetched()).toHaveLength(BACKGROUND_TOKEN_LIMIT);
            // It is fetched once the window has passed, without anything else being queued.
            await vi.advanceTimersByTimeAsync(BACKGROUND_TOKEN_WINDOW_MS);
            // A timer set while timers run is due a millisecond later under fake timers.
            await vi.advanceTimersByTimeAsync(1);
            expect(fetched()).toContain(`!r${BACKGROUND_TOKEN_LIMIT}`);
            // A room fetched within the token's life is not fetched again in the background.
            await vi.advanceTimersByTimeAsync(TOKEN_REFRESH_MS - BACKGROUND_TOKEN_WINDOW_MS - 2);
            const before = fetched().length;
            prepareCallInBackground(room("!seen"));
            await vi.advanceTimersByTimeAsync(0);
            expect(fetched()).toHaveLength(before);
            cancel();
        });

        it("drops a background fetch still waiting for idle time at logout", async () => {
            const cancel = prepareElementCall(client);
            prepareCallInBackground(room("!voice"));
            cancel();
            await vi.advanceTimersByTimeAsync(1000);
            expect(fetched()).toEqual([]);
        });

        it("fetches nothing after logout", async () => {
            const cancel = prepareElementCall(client);
            cancel();
            prepareCallSoon(room("!voice"));
            prepareCallInBackground(room("!voice"));
            await vi.advanceTimersByTimeAsync(1000);
            expect(fetched()).toEqual([]);
        });
    });
});
