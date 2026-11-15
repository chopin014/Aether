/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "matrix-js-sdk/src/logger";

import {
    WatchQueueFullError,
    WatchTogetherSession,
    WatchTogetherSessionEvent,
    type WatchTransport,
} from "./WatchTogetherSession";
import {
    encodeMessage,
    parseMessage,
    WATCH_MAX_ITEMS,
    WATCH_START_LEAD_SECONDS,
    WATCH_STATE,
    WATCH_SYNC_REQUEST,
    type WatchItem,
} from "./WatchTogetherProtocol";

/** Call data between peers, delivered after `latency` milliseconds of fake time. */
class FakeCall {
    public latency = 50;
    private readonly listeners = new Map<string, Set<(payload: Uint8Array, sender: string) => void>>();
    public readonly sent: { from: string; payload: Uint8Array }[] = [];

    public transport(user: string): WatchTransport {
        return {
            send: async (payload) => {
                this.sent.push({ from: user, payload });
                for (const [other, listeners] of this.listeners) {
                    if (other === user) continue;
                    setTimeout(() => listeners.forEach((listener) => listener(payload, user)), this.latency);
                }
            },
            subscribe: (listener) => {
                if (!this.listeners.has(user)) this.listeners.set(user, new Set());
                this.listeners.get(user)!.add(listener);
                return () => this.listeners.get(user)!.delete(listener);
            },
        };
    }
}

const item = (id: string, patch: Partial<WatchItem> = {}): WatchItem => ({
    id,
    source: "youtube",
    ref: "aqz-KE-bpKQ",
    addedBy: "@alice:example.org",
    ...patch,
});

describe("WatchTogetherSession", () => {
    let call: FakeCall;
    const sessions: WatchTogetherSession[] = [];

    function join(name: string): WatchTogetherSession {
        const session = new WatchTogetherSession(`@${name}:example.org`, () => performance.now());
        session.setTransport(call.transport(name));
        sessions.push(session);
        return session;
    }

    beforeEach(() => {
        vi.useFakeTimers();
        call = new FakeCall();
    });

    afterEach(() => {
        sessions.splice(0).forEach((session) => session.dispose());
        vi.useRealTimers();
    });

    it("starts an item for everyone after a short countdown, then plays in step", async () => {
        const alice = join("alice");
        const bob = join("bob");
        alice.start([item("i1")]);
        expect(alice.position()).toBeCloseTo(-WATCH_START_LEAD_SECONDS);
        await vi.advanceTimersByTimeAsync(call.latency);
        expect(bob.current?.id).toBe("i1");
        expect(bob.state?.playing).toBe(true);
        await vi.advanceTimersByTimeAsync(10_000);
        // Bob counted from when the state reached him, one network delay later than Alice.
        expect(alice.position() - bob.position()).toBeCloseTo(call.latency / 1000, 2);
        expect(alice.position()).toBeCloseTo(10 + call.latency / 1000 - WATCH_START_LEAD_SECONDS, 2);
    });

    it("measures position on the receiver's clock, so the sender's clock never matters", async () => {
        const alice = join("alice");
        const bob = join("bob");
        alice.start([item("i1")]);
        await vi.advanceTimersByTimeAsync(5000);
        alice.seek(100);
        await vi.advanceTimersByTimeAsync(call.latency);
        expect(bob.position()).toBeCloseTo(100, 1);
        alice.setPlaying(false);
        await vi.advanceTimersByTimeAsync(call.latency + 3000);
        expect(bob.state?.playing).toBe(false);
        expect(bob.position()).toBeCloseTo(alice.position(), 1);
    });

    it("lets anyone control playback, and the newest change wins everywhere", async () => {
        const alice = join("alice");
        const bob = join("bob");
        alice.start([item("i1"), item("i2")]);
        await vi.advanceTimersByTimeAsync(call.latency);
        // Both act before hearing about the other's change.
        alice.setPlaying(false);
        bob.next();
        await vi.advanceTimersByTimeAsync(call.latency);
        expect(alice.state?.revision).toBe(bob.state?.revision);
        expect(alice.state).toEqual(bob.state);
    });

    it("catches up someone who joins late", async () => {
        const alice = join("alice");
        join("bob");
        alice.start([item("i1"), item("i2")]);
        await vi.advanceTimersByTimeAsync(30_000);
        const carol = join("carol");
        await vi.advanceTimersByTimeAsync(call.latency * 2);
        expect(carol.state?.items.map((i) => i.id)).toEqual(["i1", "i2"]);
        expect(carol.position()).toBeCloseTo(alice.position(), 0);
    });

    it("asks again when nobody answered the first sync request, and stops once caught up", async () => {
        const alice = join("alice");
        alice.start([item("i1")]);
        const listeners = new Set<(payload: Uint8Array, sender: string) => void>();
        const deaf: WatchTransport = {
            send: vi.fn().mockResolvedValue(undefined),
            subscribe: (listener) => {
                listeners.add(listener);
                return () => listeners.delete(listener);
            },
        };
        const bob = new WatchTogetherSession("@bob:example.org");
        sessions.push(bob);
        bob.setTransport(deaf);
        expect(deaf.send).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1000);
        expect(deaf.send).toHaveBeenCalledTimes(2);
        const answer = encodeMessage({ type: WATCH_STATE, state: alice.state! });
        listeners.forEach((listener) => listener(answer, "@alice:example.org"));
        await vi.advanceTimersByTimeAsync(10_000);
        expect(deaf.send).toHaveBeenCalledTimes(2);
        expect(bob.current?.id).toBe("i1");
    });

    it("does not answer sync requests when nothing is playing", async () => {
        join("alice");
        join("bob");
        await vi.advanceTimersByTimeAsync(10_000);
        const states = call.sent.filter((m) => parseMessage(m.payload)?.type === WATCH_STATE);
        expect(states).toHaveLength(0);
        expect(call.sent.every((m) => parseMessage(m.payload)?.type === WATCH_SYNC_REQUEST)).toBe(true);
    });

    it("keeps a stopped activity stopped when an older state arrives late", async () => {
        const alice = join("alice");
        const bob = join("bob");
        alice.start([item("i1")]);
        await vi.advanceTimersByTimeAsync(call.latency);
        const stale = encodeMessage({ type: WATCH_STATE, state: bob.state! });
        bob.stop();
        await vi.advanceTimersByTimeAsync(call.latency);
        expect(alice.active).toBe(false);
        const listener = vi.fn();
        alice.on(WatchTogetherSessionEvent.Changed, listener);
        (alice as unknown as { receive(p: Uint8Array): void }).receive(stale);
        expect(alice.active).toBe(false);
        expect(listener).not.toHaveBeenCalled();
    });

    it("starts a new activity after a stop with a higher revision", async () => {
        const alice = join("alice");
        const bob = join("bob");
        alice.start([item("i1")]);
        await vi.advanceTimersByTimeAsync(call.latency);
        bob.stop();
        await vi.advanceTimersByTimeAsync(call.latency);
        alice.start([item("i2")]);
        await vi.advanceTimersByTimeAsync(call.latency);
        expect(bob.current?.id).toBe("i2");
        expect(bob.state!.revision).toBeGreaterThan(2);
    });

    it("queues after the current item and starts a finished queue straight away", () => {
        const alice = join("alice");
        alice.enqueue([item("i1")]);
        expect(alice.current?.id).toBe("i1");
        alice.enqueue([item("i2")]);
        expect(alice.current?.id).toBe("i1");
        alice.next();
        alice.next();
        expect(alice.state).toMatchObject({ index: 1, playing: false, ended: true });
        alice.enqueue([item("i3")]);
        expect(alice.state).toMatchObject({ index: 2, playing: true, ended: false });
        expect(alice.position()).toBeCloseTo(-WATCH_START_LEAD_SECONDS);
    });

    it("plays a link now without losing the rest of the queue", () => {
        const alice = join("alice");
        alice.start([item("i1"), item("i2")]);
        alice.playNow([item("now")]);
        expect(alice.state?.items.map((i) => i.id)).toEqual(["i1", "now", "i2"]);
        expect(alice.current?.id).toBe("now");
    });

    it("starts a website paused at its beginning, and re-points it for everyone", async () => {
        const alice = join("alice");
        const bob = join("bob");
        const site = item("s1", { source: "site", ref: "https://archive.org/details/movie" });
        alice.start([site]);
        expect(alice.state).toMatchObject({ playing: false, position: 0 });
        alice.setPlaying(true, 42);
        alice.retarget("s1", "https://archive.org/details/movie/part-2", "Part 2");
        await vi.advanceTimersByTimeAsync(call.latency);
        expect(bob.current).toMatchObject({ ref: "https://archive.org/details/movie/part-2", title: "Part 2" });
        expect(bob.state).toMatchObject({ playing: false, position: 0 });
        // Only websites can be pointed elsewhere.
        alice.enqueue([item("y1")]);
        alice.retarget("y1", "https://example.org/");
        expect(alice.state?.items[1].ref).toBe("aqz-KE-bpKQ");
    });

    it("starts a t= link at its time without the countdown", () => {
        const alice = join("alice");
        alice.start([item("i1", { start: 90 })]);
        expect(alice.position()).toBe(90);
    });

    it("replays a finished queue from the start of the last item", () => {
        const alice = join("alice");
        alice.start([item("i1")]);
        alice.next();
        expect(alice.state?.ended).toBe(true);
        alice.setPlaying(true);
        expect(alice.state).toMatchObject({ playing: true, ended: false, index: 0 });
    });

    it("pauses at the start rather than at a negative time during the countdown", () => {
        const alice = join("alice");
        alice.start([item("i1")]);
        alice.setPlaying(false);
        expect(alice.state?.position).toBe(0);
    });

    it("goes back to the previous item only near the start of the current one", async () => {
        const alice = join("alice");
        alice.start([item("i1"), item("i2")]);
        alice.jump(1);
        await vi.advanceTimersByTimeAsync(10_000);
        alice.previous();
        expect(alice.current?.id).toBe("i2");
        expect(alice.position()).toBe(0);
        alice.previous();
        expect(alice.current?.id).toBe("i1");
    });

    it("removes items around the current one", () => {
        const alice = join("alice");
        alice.start([item("i1"), item("i2"), item("i3")]);
        alice.jump(1);
        alice.remove("i1");
        expect(alice.state).toMatchObject({ index: 0 });
        expect(alice.current?.id).toBe("i2");
        alice.remove("i3");
        expect(alice.current?.id).toBe("i2");
        alice.enqueue([item("i4")]);
        alice.remove("i2");
        expect(alice.current?.id).toBe("i4");
        alice.enqueue([item("i5")]);
        alice.remove("i5");
        alice.remove("i4");
        expect(alice.active).toBe(false);
    });

    it("marks the queue finished when the playing last item is removed", () => {
        const alice = join("alice");
        alice.start([item("i1"), item("i2")]);
        alice.jump(1);
        alice.remove("i2");
        expect(alice.state).toMatchObject({ index: 0, playing: false, ended: true });
    });

    it("advances once when every player reports the end of the same item", async () => {
        const alice = join("alice");
        const bob = join("bob");
        alice.start([item("i1"), item("i2"), item("i3")]);
        await vi.advanceTimersByTimeAsync(call.latency);
        alice.itemEnded("i1");
        bob.itemEnded("i1");
        await vi.advanceTimersByTimeAsync(call.latency);
        // Bob's late report for the item that already finished changes nothing.
        bob.itemEnded("i1");
        await vi.advanceTimersByTimeAsync(call.latency);
        expect(alice.current?.id).toBe("i2");
        expect(bob.current?.id).toBe("i2");
    });

    it("ignores speeds the players do not offer", () => {
        const alice = join("alice");
        alice.start([item("i1")]);
        alice.setRate(1.5);
        alice.setRate(3);
        expect(alice.state?.rate).toBe(1.5);
    });

    it("refuses to grow the queue past what one packet can carry", () => {
        const alice = join("alice");
        const long = (id: string): WatchItem =>
            item(id, {
                title: "t".repeat(120),
                channel: "c".repeat(60),
                source: "media",
                ref: `https://example.org/${"x".repeat(150)}.mp4`,
            });
        alice.start([long("first")]);
        expect(() => {
            for (let i = 0; i < WATCH_MAX_ITEMS; i++) alice.enqueue([long(`i${i}`)]);
        }).toThrow(WatchQueueFullError);
        const sizes = call.sent.map((m) => m.payload.byteLength);
        expect(Math.max(...sizes)).toBeLessThanOrEqual(8000);
    });

    it("forgets the activity locally on leaving, without telling anyone", async () => {
        const alice = join("alice");
        const bob = join("bob");
        alice.start([item("i1")]);
        await vi.advanceTimersByTimeAsync(call.latency);
        const sent = call.sent.length;
        bob.setTransport(null);
        expect(bob.state).toBeNull();
        expect(bob.connected).toBe(false);
        expect(call.sent.length).toBe(sent);
        expect(alice.active).toBe(true);
    });

    it("keeps working when the data channel throws synchronously", () => {
        const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
        const session = new WatchTogetherSession("@alice:example.org");
        sessions.push(session);
        session.setTransport({
            send: () => {
                throw new Error("not connected");
            },
            subscribe: () => () => {},
        });
        expect(() => session.start([item("i1")])).not.toThrow();
        expect(session.current?.id).toBe("i1");
        expect(warn).toHaveBeenCalled();
    });
});
