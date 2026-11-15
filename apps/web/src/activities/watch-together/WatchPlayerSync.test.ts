/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WatchPlayerSync } from "./WatchPlayerSync";
import { WatchTogetherSession } from "./WatchTogetherSession";
import type { WatchItem, WatchSource } from "./WatchTogetherProtocol";
import type { WatchPlayer, WatchPlayerEvent, WatchPlayerStatus } from "./WatchPlayer";

/** A player that does what it is told instantly and plays at its speed on the test clock. */
class FakePlayer implements WatchPlayer {
    public readonly element = document.createElement("div");
    public itemId: string | null = null;
    public readonly calls: string[] = [];
    public volume = 1;
    public disposed = false;
    public playing = false;
    public buffering = false;
    public rate = 1;
    private base: number | null = null;
    private baseAt = 0;
    private readonly listeners = new Set<(event: WatchPlayerEvent) => void>();

    public constructor(public readonly source: WatchSource) {}

    /** Where the player is now, or null before it has loaded anything. */
    public get time(): number | null {
        if (this.base === null) return null;
        return this.playing && !this.buffering
            ? this.base + ((performance.now() - this.baseAt) / 1000) * this.rate
            : this.base;
    }
    public set time(value: number | null) {
        this.base = value;
        this.baseAt = performance.now();
    }
    /** Fixes the current position before playback state or speed changes how it advances. */
    private rebase(): void {
        const now = this.time;
        this.time = now;
    }

    public load(item: WatchItem, position: number, play: boolean): void {
        this.itemId = item.id;
        this.calls.push(`load ${item.id} ${position.toFixed(1)} ${play}`);
        this.time = position;
        this.playing = play;
    }
    public play(): void {
        this.calls.push("play");
        this.rebase();
        this.playing = true;
    }
    public pause(): void {
        this.calls.push("pause");
        this.rebase();
        this.playing = false;
    }
    public seek(position: number): void {
        this.calls.push(`seek ${position.toFixed(2)}`);
        this.time = position;
    }
    public setRate(rate: number): void {
        this.calls.push(`rate ${rate}`);
        this.rebase();
        this.rate = rate;
    }
    public setVolume(volume: number): void {
        this.volume = volume;
    }
    public status(): WatchPlayerStatus {
        return {
            ready: true,
            playing: this.playing,
            buffering: this.buffering,
            time: this.time,
            duration: 600,
            rate: this.rate,
            hasVideo: true,
        };
    }
    public subscribe(listener: (event: WatchPlayerEvent) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    public dispose(): void {
        this.disposed = true;
    }
    public emit(event: WatchPlayerEvent): void {
        this.listeners.forEach((listener) => listener(event));
    }
}

const item = (id: string, source: WatchSource = "youtube"): WatchItem => ({
    id,
    source,
    ref: source === "youtube" ? "aqz-KE-bpKQ" : "https://example.org/a.mp4",
    addedBy: "@alice:example.org",
});

describe("WatchPlayerSync", () => {
    let session: WatchTogetherSession;
    let sync: WatchPlayerSync;
    let players: FakePlayer[];
    let shown: (WatchPlayer | null)[];
    const player = (): FakePlayer => players[players.length - 1];

    beforeEach(() => {
        vi.useFakeTimers();
        players = [];
        shown = [];
        session = new WatchTogetherSession("@alice:example.org");
        session.setTransport({ send: vi.fn().mockResolvedValue(undefined), subscribe: () => () => {} });
        sync = new WatchPlayerSync(session, {
            createPlayer: (source) => {
                const created = new FakePlayer(source);
                players.push(created);
                return created;
            },
            onPlayerChanged: (p) => shown.push(p),
        });
    });

    afterEach(() => {
        sync.dispose();
        session.dispose();
        vi.useRealTimers();
    });

    it("loads the first item paused during the countdown, then starts it", async () => {
        session.start([item("i1")]);
        expect(shown).toEqual([player()]);
        expect(player().calls).toEqual(["load i1 0.0 false"]);
        await vi.advanceTimersByTimeAsync(1500);
        expect(player().calls).toContain("play");
    });

    it("pauses, resumes and changes speed when the session does", async () => {
        session.start([item("i1")]);
        await vi.advanceTimersByTimeAsync(5000);
        session.setPlaying(false);
        expect(player().calls.at(-1)).toBe("pause");
        session.setRate(1.5);
        expect(player().calls).toContain("rate 1.5");
        session.setPlaying(true);
        expect(player().calls.at(-1)).toBe("play");
    });

    it("moves a drifting player back to the shared position, aiming a little ahead", async () => {
        session.start([item("i1")]);
        await vi.advanceTimersByTimeAsync(5000);
        player().time = session.position() - 2;
        player().calls.length = 0;
        await vi.advanceTimersByTimeAsync(500);
        const seek = player().calls.find((c) => c.startsWith("seek"));
        expect(Number(seek?.split(" ")[1])).toBeCloseTo(session.position() + 0.25, 0);
    });

    it("does not correct small drift, a single late report, or a buffering player", async () => {
        session.start([item("i1")]);
        await vi.advanceTimersByTimeAsync(5000);
        player().calls.length = 0;
        player().time = session.position() - 0.3;
        sync.reconcile();
        player().time = session.position() - 3;
        player().buffering = true;
        sync.reconcile();
        sync.reconcile();
        expect(player().calls.filter((c) => c.startsWith("seek"))).toEqual([]);
    });

    it("waits for a seek to land before correcting again", async () => {
        session.start([item("i1")]);
        await vi.advanceTimersByTimeAsync(5000);
        session.seek(100);
        player().time = 50;
        player().calls.length = 0;
        await vi.advanceTimersByTimeAsync(1500);
        expect(player().calls.filter((c) => c.startsWith("seek"))).toEqual([]);
        await vi.advanceTimersByTimeAsync(1000);
        expect(player().calls.filter((c) => c.startsWith("seek"))).toHaveLength(1);
    });

    it("shares a pause the user made by clicking the video", async () => {
        session.start([item("i1")]);
        await vi.advanceTimersByTimeAsync(5000);
        player().pause();
        player().time = 3.7;
        player().emit("paused");
        expect(session.state).toMatchObject({ playing: false, position: 3.7 });
    });

    it("does not mistake the result of its own command for the user", async () => {
        session.start([item("i1")]);
        await vi.advanceTimersByTimeAsync(5000);
        session.setPlaying(false);
        const revision = session.state!.revision;
        player().emit("playing");
        player().emit("paused");
        expect(session.state!.revision).toBe(revision);
    });

    it("ignores the pause of a player that was just moved in the page", async () => {
        session.start([item("i1")]);
        await vi.advanceTimersByTimeAsync(5000);
        sync.notePlayerMoved();
        player().emit("paused");
        expect(session.state?.playing).toBe(true);
    });

    it("moves on when the item ends, and reloads after the embed restarts", async () => {
        session.start([item("i1"), item("i2")]);
        await vi.advanceTimersByTimeAsync(5000);
        player().emit("ended");
        expect(session.current?.id).toBe("i2");
        expect(player().calls.at(-1)).toMatch(/^load i2/);
        player().calls.length = 0;
        player().emit("reset");
        expect(player().calls[0]).toMatch(/^load i2/);
    });

    it("swaps players when the source changes and drops them when the activity ends", async () => {
        session.start([item("i1"), item("i2", "media")]);
        const youtube = player();
        session.next();
        expect(youtube.disposed).toBe(true);
        expect(player().source).toBe("media");
        sync.setVolume(0.4);
        expect(player().volume).toBe(0.4);
        session.stop();
        expect(player().disposed).toBe(true);
        expect(shown.at(-1)).toBeNull();
    });

    it("stops checking once nothing is playing", async () => {
        session.start([item("i1")]);
        session.stop();
        const spy = vi.spyOn(sync, "reconcile");
        await vi.advanceTimersByTimeAsync(5000);
        expect(spy).not.toHaveBeenCalled();
    });
});
