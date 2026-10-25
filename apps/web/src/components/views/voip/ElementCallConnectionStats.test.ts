/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import EventEmitter from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type CallConnectionStats } from "../../../models/CallConnectionStats";

const require = createRequire(import.meta.url);
const componentPath = require.resolve("@element-hq/element-call-component");
const rxjs = createRequire(componentPath)("rxjs") as {
    Observable: new (subscribe: (observer: { next: (value: unknown) => void }) => () => void) => {
        subscribe: (next: (stats: CallConnectionStats) => void) => { unsubscribe: () => void };
    };
    BehaviorSubject: new <T>(value: T) => { next: (value: T) => void };
    Subject: new () => { next: () => void };
    takeUntil: (notifier: unknown) => unknown;
    combineLatest: unknown;
    switchMap: unknown;
};
const source = readFileSync(componentPath, "utf8");
const start = source.indexOf("function aetherObserveConnectionStats(");
const end = source.indexOf("// Aether's sidebar observes existing microphone tracks", start);
const observe = new Function("C", `${source.slice(start, end)}; return aetherObserveConnectionStats;`)(
    rxjs.Observable,
) as (
    room: unknown,
    ready: boolean,
    reconnecting: boolean,
    disconnected: boolean,
) => { subscribe: (next: (stats: CallConnectionStats) => void) => { unsubscribe: () => void } };

function stats(rtt: number | null = 0.017, sent = 100, lost = 0, fraction?: number) {
    return new Map(
        [
            { id: "transport", type: "transport", selectedCandidatePairId: "selected" },
            { id: "selected", type: "candidate-pair", currentRoundTripTime: rtt },
            { id: "audio", type: "outbound-rtp", kind: "audio", packetsSent: sent, remoteId: "remote" },
            { id: "remote", type: "remote-inbound-rtp", packetsLost: lost, fractionLost: fraction },
        ].map((value) => [value.id, value]),
    );
}

function fixture(ready = true) {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const publisher = { getStats: vi.fn().mockResolvedValue(stats(0.017, 100, 0, 0)) };
    const subscriber = { getStats: vi.fn().mockResolvedValue(undefined) };
    const room = Object.assign(new EventEmitter(), {
        state: "connected",
        localParticipant: { connectionQuality: "good" },
        engine: { pcManager: { publisher, subscriber } },
    });
    const received: CallConnectionStats[] = [];
    const subscription = observe(room, ready, false, false).subscribe((report) => received.push(report));
    return { room, publisher, subscriber, received, subscription, latest: () => received.at(-1)! };
}

describe("Element Call media connection statistics", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("does not call a Matrix join connected before the media transport is ready", async () => {
        const f = fixture(false);
        await vi.advanceTimersByTimeAsync(1000);
        expect(f.latest()).toMatchObject({ state: "connecting", quality: "unknown", rttMs: null, history: [] });
        expect(f.publisher.getStats).not.toHaveBeenCalled();
        f.subscription.unsubscribe();
    });

    it("reports measured media RTT and outgoing audio loss, with a rolling average", async () => {
        const f = fixture();
        expect(f.latest()).toMatchObject({ state: "connected", quality: "unknown", rttMs: null });
        await vi.advanceTimersByTimeAsync(0);
        expect(f.latest()).toEqual({
            state: "connected",
            quality: "good",
            rttMs: 17,
            averageRttMs: 17,
            outboundPacketLossPercent: 0,
            history: [17],
        });
        f.publisher.getStats.mockResolvedValue(stats(0.027, 200, 8));
        await vi.advanceTimersByTimeAsync(1000);
        expect(f.latest()).toMatchObject({
            quality: "poor",
            rttMs: 27,
            averageRttMs: 22,
            outboundPacketLossPercent: 8,
            history: [17, 27],
        });
        f.subscription.unsubscribe();
    });

    it.each([
        [0.25, 0.05, "good"],
        [0.251, 0.05, "poor"],
        [0.5, 0.1, "poor"],
        [0.501, 0, "bad"],
        [0.01, 0.051, "poor"],
        [0.01, 0.101, "bad"],
    ])("classifies %.3f s RTT and %.3f loss as %s", async (rtt, fraction, quality) => {
        const f = fixture();
        await vi.advanceTimersByTimeAsync(0);
        f.publisher.getStats.mockResolvedValue(stats(rtt, 1, 0, fraction));
        // Replacing the transport resets counters and the sample window.
        f.room.engine.pcManager.publisher = { getStats: f.publisher.getStats };
        await vi.advanceTimersByTimeAsync(1000);
        expect(f.latest().quality).toBe(quality);
        f.subscription.unsubscribe();
    });

    it("uses LiveKit's poor and lost local quality, ignoring remote participant changes", async () => {
        const f = fixture();
        await vi.advanceTimersByTimeAsync(0);
        f.room.localParticipant.connectionQuality = "poor";
        f.room.emit("connectionQualityChanged", "poor", f.room.localParticipant);
        expect(f.latest().quality).toBe("poor");
        f.room.localParticipant.connectionQuality = "lost";
        f.room.emit("connectionQualityChanged", "lost", f.room.localParticipant);
        expect(f.latest().quality).toBe("lost");
        const count = f.received.length;
        f.room.emit("connectionQualityChanged", "poor", {});
        expect(f.received).toHaveLength(count);
        f.subscription.unsubscribe();
    });

    it("leaves unavailable stats null rather than reporting a perfect network", async () => {
        const f = fixture();
        await vi.advanceTimersByTimeAsync(0);
        f.publisher.getStats.mockResolvedValue(undefined);
        await vi.advanceTimersByTimeAsync(1000);
        expect(f.latest()).toMatchObject({ quality: "unknown", rttMs: null, outboundPacketLossPercent: null });
        f.publisher.getStats.mockRejectedValue(new Error("transport closed"));
        await vi.advanceTimersByTimeAsync(1000);
        expect(f.latest()).toMatchObject({ quality: "unknown", rttMs: null, history: [17, null, null] });
        f.subscription.unsubscribe();
    });

    it("takes outgoing audio loss from remote reports, excluding received audio and video", async () => {
        const f = fixture();
        await vi.advanceTimersByTimeAsync(0);
        const report = stats(0.02, 200, 1);
        // Only the microphone's remote-inbound report belongs to sent audio loss.
        report.set("received", { id: "received", type: "inbound-rtp", packetsLost: 999, fractionLost: undefined });
        report.set("video", {
            id: "video",
            type: "outbound-rtp",
            kind: "video",
            packetsSent: 1,
            remoteId: "remote-video",
        });
        report.set("remote-video", {
            id: "remote-video",
            type: "remote-inbound-rtp",
            packetsLost: 100,
            fractionLost: undefined,
        });
        f.publisher.getStats.mockResolvedValue(report);
        await vi.advanceTimersByTimeAsync(1000);
        expect(f.latest().outboundPacketLossPercent).toBe(1);
        f.subscription.unsubscribe();
    });

    it("keeps thirty samples and resets both average and counters on a new transport", async () => {
        const f = fixture();
        await vi.advanceTimersByTimeAsync(35000);
        expect(f.latest().history).toHaveLength(30);
        f.room.engine.pcManager.publisher = { getStats: vi.fn().mockResolvedValue(stats(0.05)) };
        await vi.advanceTimersByTimeAsync(1000);
        expect(f.latest()).toMatchObject({ history: [50], averageRttMs: 50 });
        f.subscription.unsubscribe();
    });

    it("uses RTCP's reported interval before counters and ignores stale feedback", async () => {
        const f = fixture();
        await vi.advanceTimersByTimeAsync(0);
        f.publisher.getStats.mockResolvedValue(stats(0.017, 200, 8, 0.02));
        await vi.advanceTimersByTimeAsync(1000);
        expect(f.latest().outboundPacketLossPercent).toBe(2);
        const report = stats(0.017, 300, 9, 0.02);
        const outbound = report.get("audio")!;
        const remote = report.get("remote")!;
        Object.assign(outbound, { timestamp: 10000 });
        Object.assign(remote, { timestamp: 4000 });
        f.publisher.getStats.mockResolvedValue(report);
        await vi.advanceTimersByTimeAsync(1000);
        expect(f.latest().outboundPacketLossPercent).toBeNull();
        f.subscription.unsubscribe();
    });

    it("does not interpret missing RTCP or unsent packets as zero loss", async () => {
        const f = fixture();
        await vi.advanceTimersByTimeAsync(1000);
        expect(f.latest().outboundPacketLossPercent).toBeNull();
        const report = stats(0.017, 200);
        report.delete("remote");
        f.publisher.getStats.mockResolvedValue(report);
        await vi.advanceTimersByTimeAsync(1000);
        expect(f.latest().outboundPacketLossPercent).toBeNull();
        f.subscription.unsubscribe();
    });

    it("clears samples and quality during reconnection, then measures the new connection", async () => {
        const f = fixture();
        await vi.advanceTimersByTimeAsync(0);
        f.room.state = "reconnecting";
        f.room.emit("connectionStateChanged", "reconnecting");
        expect(f.latest()).toMatchObject({ state: "reconnecting", quality: "unknown", history: [], rttMs: null });
        f.room.state = "connected";
        f.room.emit("connectionStateChanged", "connected");
        await vi.advanceTimersByTimeAsync(0);
        expect(f.latest()).toMatchObject({ state: "connected", quality: "good", history: [17] });
        f.subscription.unsubscribe();
    });

    it("does not overlap slow measurements or report late results after disposing", async () => {
        const f = fixture();
        await vi.advanceTimersByTimeAsync(0);
        let resolve!: (value: ReturnType<typeof stats>) => void;
        f.publisher.getStats.mockImplementation(
            () => new Promise<ReturnType<typeof stats>>((done) => (resolve = done)),
        );
        await vi.advanceTimersByTimeAsync(5000);
        expect(f.publisher.getStats).toHaveBeenCalledTimes(2);
        const count = f.received.length;
        f.subscription.unsubscribe();
        expect(f.room.listenerCount("connectionStateChanged")).toBe(0);
        expect(f.room.listenerCount("connectionQualityChanged")).toBe(0);
        resolve(stats());
        await vi.advanceTimersByTimeAsync(5000);
        expect(f.received).toHaveLength(count);
        expect(f.publisher.getStats).toHaveBeenCalledTimes(2);
    });

    it("discards a delayed measurement from before reconnection", async () => {
        const f = fixture();
        await vi.advanceTimersByTimeAsync(0);
        let resolve!: (value: ReturnType<typeof stats>) => void;
        f.publisher.getStats.mockImplementationOnce(
            () => new Promise<ReturnType<typeof stats>>((done) => (resolve = done)),
        );
        await vi.advanceTimersByTimeAsync(1000);
        f.room.state = "reconnecting";
        f.room.emit("connectionStateChanged", "reconnecting");
        resolve(stats(0.9));
        await vi.advanceTimersByTimeAsync(0);
        expect(f.latest()).toMatchObject({ state: "reconnecting", history: [], rttMs: null });
        f.publisher.getStats.mockResolvedValue(stats(0.025));
        f.room.state = "connected";
        f.room.emit("connectionStateChanged", "connected");
        await vi.advanceTimersByTimeAsync(0);
        expect(f.latest()).toMatchObject({ state: "connected", history: [25], rttMs: 25 });
        f.subscription.unsubscribe();
    });

    it("wires the installed local-membership publisher to the host and clears it on scope disposal", async () => {
        const f = fixture();
        f.subscription.unsubscribe();
        await vi.advanceTimersByTimeAsync(0);
        const ready = new rxjs.BehaviorSubject(false);
        const disposed = new rxjs.Subject();
        const onEnd: (() => void)[] = [];
        const notifyConnectionStats = vi.fn().mockResolvedValue(undefined);
        const publisherStart = source.indexOf("// Aether: membership joins before media connects.");
        const publisherEnd = source.indexOf("// Forward real, unmuted speech activity", publisherStart);
        expect(publisherStart).toBeGreaterThan(-1);
        expect(publisherEnd).toBeGreaterThan(publisherStart);
        const publish = new Function(
            "A",
            "Lk",
            "wA",
            "e",
            "p",
            "l",
            "aetherObserveConnectionStats",
            source.slice(publisherStart, publisherEnd),
        );
        publish(
            {
                connection$: new rxjs.BehaviorSubject({ livekitRoom: f.room }),
                connected$: ready,
                reconnecting$: new rxjs.BehaviorSubject(false),
                disconnected$: new rxjs.BehaviorSubject(false),
            },
            rxjs.combineLatest,
            rxjs.switchMap,
            { bind: () => rxjs.takeUntil(disposed), onEnd: (callback: () => void) => onEnd.push(callback) },
            { notifyConnectionStats },
            { warn: vi.fn() },
            observe,
        );
        expect(notifyConnectionStats).toHaveBeenLastCalledWith(expect.objectContaining({ state: "connecting" }));
        ready.next(true);
        await vi.advanceTimersByTimeAsync(0);
        expect(notifyConnectionStats).toHaveBeenLastCalledWith(
            expect.objectContaining({ state: "connected", rttMs: 17 }),
        );
        disposed.next();
        onEnd.forEach((callback) => callback());
        expect(notifyConnectionStats).toHaveBeenLastCalledWith(
            expect.objectContaining({ state: "disconnected", history: [] }),
        );
        expect(f.room.listenerCount("connectionStateChanged")).toBe(0);
    });
});
