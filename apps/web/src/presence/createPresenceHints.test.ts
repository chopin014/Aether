/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { TypedEventEmitter } from "matrix-js-sdk/src/matrix";

import PlatformPeg from "../PlatformPeg";
import { type CallStore, CallStoreEvent } from "../stores/CallStore";
import { type Call } from "../models/Call";
import type BasePlatform from "../BasePlatform";
import { createPresenceHints } from "./createPresenceHints";

class FakeCallStore extends TypedEventEmitter<
    CallStoreEvent.ConnectedCalls,
    { [CallStoreEvent.ConnectedCalls]: (calls: Set<Call>, previous: Set<Call>) => void }
> {
    public connectedCalls = new Set<Call>();
}

describe("createPresenceHints", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("should report connected calls and follow their changes until unwatched", () => {
        const store = new FakeCallStore();
        const hints = createPresenceHints(store as unknown as CallStore);
        expect(hints.isInCall()).toBe(false);
        store.connectedCalls.add({} as Call);
        expect(hints.isInCall()).toBe(true);

        const listener = vi.fn();
        const unwatch = hints.watchCalls(listener);
        store.emit(CallStoreEvent.ConnectedCalls, store.connectedCalls, new Set());
        expect(listener).toHaveBeenCalledTimes(1);
        unwatch();
        store.emit(CallStoreEvent.ConnectedCalls, store.connectedCalls, new Set());
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it("should read system idle time from the platform, or null without one", async () => {
        const hints = createPresenceHints(new FakeCallStore() as unknown as CallStore);
        vi.spyOn(PlatformPeg, "get").mockReturnValue(null);
        await expect(hints.getSystemIdleTime()).resolves.toBeNull();
        vi.spyOn(PlatformPeg, "get").mockReturnValue({
            getSystemIdleTime: async () => 1234,
        } as unknown as BasePlatform);
        await expect(hints.getSystemIdleTime()).resolves.toBe(1234);
    });
});
