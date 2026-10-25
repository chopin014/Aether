/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";
import { LinuxPcmMixer } from "./LinuxPcmMixer.js";

interface FakeTimer {
    callback: () => void;
    deadlineNs: bigint;
    cancelled: boolean;
    unref: () => void;
}

class FakeClock {
    private currentNs = 0n;
    private readonly callbackJitterNs: bigint;
    private readonly timers: FakeTimer[] = [];

    public constructor(callbackJitterNs = 0n) {
        this.callbackJitterNs = callbackJitterNs;
    }

    public nowNs = (): bigint => this.currentNs;

    public setTimeout = (callback: () => void, delayMs: number): ReturnType<typeof setTimeout> => {
        const requestedNs = BigInt(Math.ceil(delayMs * 1_000_000));
        const timer: FakeTimer = {
            callback,
            deadlineNs: this.currentNs + requestedNs + this.callbackJitterNs,
            cancelled: false,
            unref: () => undefined,
        };
        this.timers.push(timer);
        return timer as unknown as ReturnType<typeof setTimeout>;
    };

    public clearTimeout = (handle: ReturnType<typeof setTimeout>): void => {
        const timer = handle as unknown as FakeTimer;
        timer.cancelled = true;
    };

    public advanceBy = (milliseconds: number): void => {
        this.advanceTo(this.currentNs + BigInt(milliseconds) * 1_000_000n);
    };

    public jumpBy = (milliseconds: number): void => {
        this.currentNs += BigInt(milliseconds) * 1_000_000n;
    };

    public runDueTimers = (): void => {
        this.advanceTo(this.currentNs, true);
    };

    private advanceTo(targetNs: bigint, keepCurrentTime = false): void {
        for (;;) {
            let nextIndex = -1;
            let nextDeadlineNs = targetNs + 1n;
            for (let index = 0; index < this.timers.length; index++) {
                const timer = this.timers[index];
                if (!timer.cancelled && timer.deadlineNs < nextDeadlineNs) {
                    nextIndex = index;
                    nextDeadlineNs = timer.deadlineNs;
                }
            }
            if (nextIndex < 0 || nextDeadlineNs > targetNs) break;

            const [timer] = this.timers.splice(nextIndex, 1);
            if (timer.cancelled) continue;
            if (!keepCurrentTime) this.currentNs = timer.deadlineNs;
            timer.callback();
        }
        this.currentNs = targetNs;
    }
}

describe("LinuxPcmMixer", () => {
    it("should keep output deadlines aligned despite recurring timer callback delay", () => {
        const clock = new FakeClock(1_000_000n);
        const chunks: Buffer[] = [];
        const mixer = new LinuxPcmMixer((pcm) => chunks.push(pcm), clock);

        mixer.start();
        clock.advanceBy(10_000);

        expect(chunks).toHaveLength(999);
        expect(chunks.every((pcm) => pcm.length === 480 * 2 * Float32Array.BYTES_PER_ELEMENT)).toBe(true);

        mixer.stop();
        clock.advanceBy(100);
        expect(chunks).toHaveLength(999);
    });

    it("should bound catch-up after a stall, preserve queued sample order, and stop scheduling", () => {
        const clock = new FakeClock();
        const chunks: Buffer[] = [];
        const mixer = new LinuxPcmMixer((pcm) => chunks.push(pcm), clock);
        const input = Buffer.alloc(2_000 * 8);
        for (let frame = 0; frame < 2_000; frame++) {
            input.writeFloatLE(frame / 10_000, frame * 8);
            input.writeFloatLE(frame / 10_000, frame * 8 + 4);
        }
        mixer.addSource("test");
        mixer.write("test", input);

        mixer.start();
        clock.advanceBy(10);
        expect(chunks).toHaveLength(1);

        clock.jumpBy(200);
        clock.runDueTimers();

        expect(chunks).toHaveLength(4);
        for (let chunk = 0; chunk < chunks.length; chunk++) {
            expect(chunks[chunk].readFloatLE(0)).toBeCloseTo((chunk * 480) / 10_000);
        }

        mixer.stop();
        clock.advanceBy(100);
        expect(chunks).toHaveLength(4);
    });
});
