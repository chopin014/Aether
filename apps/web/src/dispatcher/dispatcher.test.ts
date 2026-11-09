/*
Copyright 2024 New Vector Ltd.
Copyright 2023 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// @vitest-environment happy-dom

import { vi, describe, it, expect } from "vitest";

import defaultDispatcher, { MatrixDispatcher } from "./dispatcher";
import { Action } from "./actions";
import { AsyncActionPayload } from "./payloads";

describe("MatrixDispatcher", () => {
    it("should throw error if unregistering unknown token", () => {
        expect(() => defaultDispatcher.unregister("not-a-real-token")).toThrow(
            "Dispatcher.unregister(...): 'not-a-real-token' does not map to a registered callback.",
        );
    });

    it("should execute callbacks in registered order", async () => {
        const deferred1 = Promise.withResolvers<number>();
        const deferred2 = Promise.withResolvers<number>();

        const fn1 = vi.fn(() => deferred1.resolve(1));
        const fn2 = vi.fn(() => deferred2.resolve(2));

        defaultDispatcher.register(fn1);
        defaultDispatcher.register(fn2);

        defaultDispatcher.dispatch({ action: Action.OnLoggedIn });
        const res = await Promise.race([deferred1.promise, deferred2.promise]);

        expect(res).toBe(1);
    });

    it("should skip the queue for the given callback", async () => {
        const deferred1 = Promise.withResolvers<number>();
        const deferred2 = Promise.withResolvers<number>();

        const fn1 = vi.fn(() => deferred1.resolve(1));
        const fn2 = vi.fn(() => deferred2.resolve(2));

        defaultDispatcher.register(() => {
            defaultDispatcher.waitFor([id2]);
        });
        defaultDispatcher.register(fn1);
        const id2 = defaultDispatcher.register(fn2);

        defaultDispatcher.dispatch({ action: Action.OnLoggedIn });
        const res = await Promise.race([deferred1.promise, deferred2.promise]);

        expect(res).toBe(2);
    });

    it("should not fire callback which was added during a dispatch", () => {
        const fn2 = vi.fn();

        defaultDispatcher.register(() => {
            defaultDispatcher.register(fn2);
        });

        defaultDispatcher.dispatch({ action: Action.OnLoggedIn }, true);

        expect(fn2).not.toHaveBeenCalled();
    });

    it("keeps no bookkeeping once a dispatch is over, however many callbacks come and go", () => {
        const dispatcher = new MatrixDispatcher();
        for (let i = 0; i < 50; i++) {
            const token = dispatcher.register(vi.fn());
            dispatcher.dispatch({ action: Action.OnLoggedIn }, true);
            dispatcher.unregister(token);
        }
        dispatcher.dispatch({ action: Action.OnLoggedIn }, true);

        // Private, so read as the dispatcher holds them: an entry here for every callback ever registered was the leak.
        const internals = dispatcher as unknown as { isPending: Map<string, boolean>; isHandled: Map<string, boolean> };
        expect(internals.isPending.size).toBe(0);
        expect(internals.isHandled.size).toBe(0);
    });

    it("still lets a callback wait for one that unregistered itself in the same dispatch", () => {
        const dispatcher = new MatrixDispatcher();
        const first = dispatcher.register(() => dispatcher.unregister(first));
        const second = vi.fn(() => dispatcher.waitFor([first]));
        dispatcher.register(second);

        expect(() => dispatcher.dispatch({ action: Action.OnLoggedIn }, true)).not.toThrow();
        expect(second).toHaveBeenCalledTimes(1);
    });

    it("calls a callback registered during a dispatch from the next one", () => {
        const dispatcher = new MatrixDispatcher();
        const late = vi.fn();
        let registered = false;
        dispatcher.register(() => {
            if (!registered) dispatcher.register(late);
            registered = true;
        });

        dispatcher.dispatch({ action: Action.OnLoggedIn }, true);
        expect(late).not.toHaveBeenCalled();
        dispatcher.dispatch({ action: Action.OnLoggedIn }, true);
        expect(late).toHaveBeenCalledTimes(1);
    });

    it("should handle AsyncActionPayload", () => {
        const fn = vi.fn();
        defaultDispatcher.register(fn);

        const readyFn = vi.fn((dispatch) => {
            dispatch({ action: "test" });
        });
        defaultDispatcher.dispatch(new AsyncActionPayload(readyFn), true);

        expect(fn).toHaveBeenLastCalledWith(expect.objectContaining({ action: "test" }));
    });
});
