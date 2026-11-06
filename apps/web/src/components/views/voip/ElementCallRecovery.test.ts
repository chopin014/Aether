/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const source = readFileSync(require.resolve("@element-hq/element-call-component"), "utf8");
const start = source.indexOf("const aetherReconnectTimeoutMs");
const end = source.indexOf("//#region src/state/CallViewModel/localMember/HomeserverConnected.ts", start);

interface Watcher {
    update: (state: string) => void;
    dispose: () => void;
}

/** Loads the recovery helpers our Element Call patch adds, so they run exactly as shipped. */
function helpers(): {
    aetherWatchLivekitState: (
        isStopped: () => boolean,
        connectionLost: (reason: string) => unknown,
        publish: (state: unknown) => void,
        onStable?: () => void,
    ) => Watcher;
    aetherCanAutoReconnect: (error: object) => boolean;
    aetherAutoReconnectDelay: (roomId: string, error: object) => { delay: number; quiet: boolean };
    aetherConnectionHeld: (roomId: string) => void;
    aetherMembershipExpiryHeadroomMs: (expiryMs: number | undefined) => number | undefined;
} {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return new Function(
        `${source.slice(start, end)}; return { aetherWatchLivekitState, aetherAutoReconnectDelay, aetherConnectionHeld, aetherCanAutoReconnect, aetherMembershipExpiryHeadroomMs };`,
    )();
}

/** Watches LiveKit states the way a connection does, recording what it reports. */
function watch(
    isStopped = (): boolean => false,
    onStable?: () => void,
): { watcher: Watcher; published: unknown[]; reasons: string[] } {
    const published: unknown[] = [];
    const reasons: string[] = [];
    const watcher = helpers().aetherWatchLivekitState(
        isStopped,
        (reason) => {
            reasons.push(reason);
            return "lost";
        },
        (state) => published.push(state),
        onStable,
    );
    return { watcher, published, reasons };
}

describe("Element Call connection recovery", () => {
    it("reports a lost connection when LiveKit gives up after joining", () => {
        const { watcher, published, reasons } = watch();
        // The room starts out disconnected before it connects; that is not a loss.
        for (const state of ["disconnected", "connecting", "connected", "reconnecting", "disconnected"]) {
            watcher.update(state);
        }
        expect(published).toEqual(["disconnected", "connecting", "connected", "reconnecting", "lost"]);
        expect(reasons).toEqual(["disconnected after joining"]);
        // Later states from the dead room are not reported over the loss.
        watcher.update("disconnected");
        expect(published.at(-1)).toBe("lost");
    });

    it("does not report a loss when the call stopped the connection itself", () => {
        let stopped = false;
        const { watcher, published } = watch(() => stopped);
        watcher.update("connected");
        stopped = true;
        watcher.update("disconnected");
        expect(published).not.toContain("lost");
    });

    it("reports a lost connection when LiveKit keeps reconnecting for too long", () => {
        vi.useFakeTimers();
        try {
            const { watcher, published, reasons } = watch();
            watcher.update("connected");
            watcher.update("signalReconnecting");
            vi.advanceTimersByTime(30_000);
            // Moving between reconnect phases does not restart the clock.
            watcher.update("reconnecting");
            vi.advanceTimersByTime(29_999);
            expect(published).not.toContain("lost");
            vi.advanceTimersByTime(1);
            expect(published.at(-1)).toBe("lost");
            expect(reasons).toEqual(["still reconnecting after 60000ms"]);
        } finally {
            vi.useRealTimers();
        }
    });

    it("lets LiveKit finish a reconnect that succeeds in time", () => {
        vi.useFakeTimers();
        try {
            const { watcher, published } = watch();
            watcher.update("connected");
            watcher.update("reconnecting");
            vi.advanceTimersByTime(59_000);
            watcher.update("connected");
            vi.advanceTimersByTime(120_000);
            expect(published).toEqual(["connected", "reconnecting", "connected"]);
        } finally {
            vi.useRealTimers();
        }
    });

    it("stops watching when the connection ends", () => {
        vi.useFakeTimers();
        try {
            const { watcher, published } = watch();
            watcher.update("connected");
            watcher.update("reconnecting");
            watcher.dispose();
            vi.advanceTimersByTime(120_000);
            expect(published).not.toContain("lost");
        } finally {
            vi.useRealTimers();
        }
    });

    it("reports a connection that has stayed up, so a later loss starts the rejoin schedule over", () => {
        vi.useFakeTimers();
        try {
            const onStable = vi.fn();
            const { watcher } = watch(() => false, onStable);
            watcher.update("connected");
            vi.advanceTimersByTime(20_000);
            // A connection that drops before it has held does not count.
            watcher.update("reconnecting");
            watcher.update("connected");
            vi.advanceTimersByTime(29_999);
            expect(onStable).not.toHaveBeenCalled();
            vi.advanceTimersByTime(1);
            expect(onStable).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });

    it("rejoins quickly at first, then keeps retrying while showing the connection error", () => {
        const { aetherAutoReconnectDelay } = helpers();
        const plans = Array.from({ length: 8 }, () => aetherAutoReconnectDelay("!room", {}));
        expect(plans.map((plan) => plan.delay)).toEqual([1000, 2000, 5000, 10000, 20000, 30000, 30000, 30000]);
        expect(plans.map((plan) => plan.quiet)).toEqual([true, true, true, true, true, true, false, false]);
        // Another room has its own attempts.
        expect(aetherAutoReconnectDelay("!other", {}).delay).toBe(1000);
    });

    it("counts each lost connection once, even when it is scheduled again", () => {
        const { aetherAutoReconnectDelay } = helpers();
        const error = {};
        expect(aetherAutoReconnectDelay("!room", error).delay).toBe(1000);
        expect(aetherAutoReconnectDelay("!room", error).delay).toBe(1000);
        expect(aetherAutoReconnectDelay("!room", {}).delay).toBe(2000);
    });

    it("starts the rejoin schedule over once the connection holds", () => {
        const { aetherAutoReconnectDelay, aetherConnectionHeld } = helpers();
        for (let i = 0; i < 8; i++) aetherAutoReconnectDelay("!room", {});
        aetherConnectionHeld("!room");
        expect(aetherAutoReconnectDelay("!room", {})).toEqual({ delay: 1000, quiet: true });
    });
});

describe("automatic rejoin error classification", () => {
    it("continues retrying when the replacement connection cannot reach the SFU", () => {
        const { aetherCanAutoReconnect } = helpers();
        expect(aetherCanAutoReconnect({ code: "CONNECTION_LOST_ERROR" })).toBe(true);
        for (const reason of [undefined, "ServerUnreachable", "Timeout", "WebSocket"]) {
            expect(
                aetherCanAutoReconnect({
                    code: "SFU_ERROR",
                    category: "NETWORK_CONNECTIVITY",
                    localisedMessageValues: { reason },
                }),
            ).toBe(true);
        }
    });

    it("does not retry permission, capacity, encryption, configuration or deliberate leave failures", () => {
        const { aetherCanAutoReconnect } = helpers();
        for (const reason of ["NotAllowed", "Cancelled", "LeaveRequest", "ServiceNotFound", "InternalError"]) {
            expect(
                aetherCanAutoReconnect({
                    code: "SFU_ERROR",
                    category: "NETWORK_CONNECTIVITY",
                    localisedMessageValues: { reason },
                }),
            ).toBe(false);
        }
        for (const code of ["INSUFFICIENT_CAPACITY_ERROR", "E2EE_NOT_SUPPORTED", "OPEN_ID_ERROR", "UNKNOWN_ERROR"]) {
            expect(aetherCanAutoReconnect({ code })).toBe(false);
        }
        expect(aetherCanAutoReconnect({ code: "SFU_ERROR", category: "CONFIGURATION_ISSUE" })).toBe(false);
    });
});

describe("call membership renewal", () => {
    it("renews well before memberships expire", () => {
        const { aetherMembershipExpiryHeadroomMs } = helpers();
        // Aether's five minute memberships are renewed after three minutes, not five seconds before they expire.
        expect(aetherMembershipExpiryHeadroomMs(5 * 60_000)).toBe(2 * 60_000);
        expect(aetherMembershipExpiryHeadroomMs(60_000)).toBe(30_000);
        expect(aetherMembershipExpiryHeadroomMs(4 * 60 * 60_000)).toBe(2 * 60_000);
        expect(aetherMembershipExpiryHeadroomMs(undefined)).toBeUndefined();
    });

    it("passes the headroom to the membership manager", () => {
        expect(source).toMatch(
            /membershipEventExpiryHeadroomMs: aetherMembershipExpiryHeadroomMs\(l\.membership_event_expiry_ms\)/,
        );
    });
});
