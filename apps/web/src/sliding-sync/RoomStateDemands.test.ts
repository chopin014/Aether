/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    DEMAND_LINGER_MS,
    RoomStateDemands,
    RoomStateUnavailableError,
    requiredStateCovers,
    requiredStateFor,
} from "./RoomStateDemands";

const INSTALLATIONS = "io.element.integrations.installations";

describe("RoomStateDemands", () => {
    describe("selectors", () => {
        it("asks for one state key, or every key", () => {
            expect(requiredStateFor({ type: INSTALLATIONS, stateKey: "abc" })).toEqual([INSTALLATIONS, "abc"]);
            expect(requiredStateFor({ type: INSTALLATIONS, stateKey: "" })).toEqual([INSTALLATIONS, ""]);
            expect(requiredStateFor({ type: INSTALLATIONS })).toEqual([INSTALLATIONS, "*"]);
        });

        it("asks for every key when the state key is a protocol token, which it cannot be sent as", () => {
            for (const stateKey of ["*", "$ME", "$LAZY"]) {
                expect(requiredStateFor({ type: INSTALLATIONS, stateKey })).toEqual([INSTALLATIONS, "*"]);
            }
        });

        it("refuses every event type, which would bring every member of large rooms", () => {
            expect(() => requiredStateFor({ type: "*" })).toThrow();
            expect(() => requiredStateFor({ type: "" })).toThrow();
        });

        it("knows what a subscription brings", () => {
            expect(requiredStateCovers([[INSTALLATIONS, "*"]], { type: INSTALLATIONS, stateKey: "x" })).toBe(true);
            expect(requiredStateCovers([[INSTALLATIONS, "x"]], { type: INSTALLATIONS, stateKey: "x" })).toBe(true);
            expect(requiredStateCovers([[INSTALLATIONS, "x"]], { type: INSTALLATIONS, stateKey: "y" })).toBe(false);
            expect(requiredStateCovers([[INSTALLATIONS, "x"]], { type: INSTALLATIONS })).toBe(false);
            expect(requiredStateCovers([["*", "*"]], { type: INSTALLATIONS })).toBe(true);
            expect(requiredStateCovers([["*", ""]], { type: INSTALLATIONS, stateKey: "" })).toBe(false);
        });
    });

    describe("demands", () => {
        let onChange: () => void;
        let demands: RoomStateDemands;

        beforeEach(() => {
            vi.useFakeTimers();
            onChange = vi.fn();
            demands = new RoomStateDemands(onChange, {
                now: () => Date.now(),
                setTimeout: (callback, ms) => setTimeout(callback, ms),
                clearTimeout: (timer) => clearTimeout(timer),
            });
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it("is ready once an answer to a request naming its state has been applied", async () => {
            const demand = demands.acquire("!room", [{ type: INSTALLATIONS }]);
            expect(onChange).toHaveBeenCalledTimes(1);
            expect(demands.selectorsFor("!room")).toEqual([{ type: INSTALLATIONS }]);
            expect(demand.isReady()).toBe(false);
            const ready = demand.whenReady(1000);

            // An answer to a request sent before the demand does not name its state.
            demands.answered("!room", [["m.room.create", ""]]);
            expect(demand.isReady()).toBe(false);
            demands.answered("!room", [
                ["m.room.create", ""],
                [INSTALLATIONS, "*"],
            ]);
            expect(demand.isReady()).toBe(true);
            await expect(ready).resolves.toBeUndefined();
        });

        it("gives up waiting after the timeout, or when the server does not serve the room", async () => {
            const slow = demands.acquire("!room", [{ type: INSTALLATIONS }]).whenReady(1000);
            vi.advanceTimersByTime(1000);
            await expect(slow).rejects.toEqual(new RoomStateUnavailableError("timeout", "!room"));

            const missing = demands.acquire("!gone", [{ type: INSTALLATIONS }]).whenReady(1000);
            demands.absent("!gone");
            await expect(missing).rejects.toMatchObject({ reason: "absent" });
        });

        it("keeps released state asked for a while, ready for the next read", async () => {
            const first = demands.acquire("!room", [{ type: INSTALLATIONS }]);
            demands.answered("!room", [[INSTALLATIONS, "*"]]);
            first.release();
            first.release();
            expect(demands.has("!room")).toBe(true);
            expect(demands.selectorsFor("!room")).toEqual([{ type: INSTALLATIONS }]);

            vi.mocked(onChange).mockClear();
            const again = demands.acquire("!room", [{ type: INSTALLATIONS, stateKey: "abc" }]);
            expect(again.isReady()).toBe(true);
            expect(onChange).not.toHaveBeenCalled();
            again.release();

            vi.advanceTimersByTime(DEMAND_LINGER_MS);
            expect(demands.has("!room")).toBe(false);
            expect(onChange).toHaveBeenCalledTimes(1);
        });

        it("rejects a released demand's wait", async () => {
            const demand = demands.acquire("!room", [{ type: INSTALLATIONS }]);
            const ready = demand.whenReady(1000);
            demand.release();
            await expect(ready).rejects.toMatchObject({ reason: "released" });
            await expect(demand.whenReady(1000)).rejects.toMatchObject({ reason: "released" });
        });

        it("asks again on a new connection, and waits for it", async () => {
            const demand = demands.acquire("!room", [{ type: INSTALLATIONS }]);
            demands.answered("!room", [[INSTALLATIONS, "*"]]);
            demands.reset();
            expect(demand.isReady()).toBe(false);
            const ready = demand.whenReady(1000);
            demands.answered("!room", [[INSTALLATIONS, "*"]]);
            await expect(ready).resolves.toBeUndefined();
        });

        it("cancels every wait when disposed", async () => {
            const ready = demands.acquire("!room", [{ type: INSTALLATIONS }]).whenReady(1000);
            demands.dispose();
            await expect(ready).rejects.toMatchObject({ reason: "released" });
            expect(demands.has("!room")).toBe(false);
        });
    });
});
