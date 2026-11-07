/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/** Why a room is subscribed, from the most to the least important. */
export type RoomSubscriptionPurpose = "view" | "call" | "space" | "prefetch";

/** A hold on a room's subscription. The room stays subscribed while any hold on it is held, and a while after. */
export interface RoomSubscriptionLease {
    /** The subscribed room. */
    readonly roomId: string;
    /** Why it is subscribed. */
    readonly purpose: RoomSubscriptionPurpose;
    /** Let go of the hold. Releasing twice has no further effect. */
    release(): void;
}

/** Timings and limits for {@link RoomSubscriptionLeases}. */
export interface RoomSubscriptionLeaseOptions {
    /** How long a room stays subscribed after its last hold of each purpose is released, in milliseconds. */
    graceMs: Record<RoomSubscriptionPurpose, number>;
    /** How long an intent to open a room keeps it subscribed, in milliseconds. */
    prefetchMs: number;
    /** The most rooms to keep subscribed. Rooms held for being open, in a call or a looked-at Space never count. */
    maxRooms: number;
    /** The most rooms subscribed only because someone might open them. */
    maxPrefetchRooms: number;
}

/** A clock and timers, replaceable in tests. */
export interface LeaseClock {
    now(): number;
    setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
    clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

export const DEFAULT_LEASE_OPTIONS: RoomSubscriptionLeaseOptions = {
    // Coming back to a room soon after leaving it finds its subscription, and live history, still in place.
    graceMs: { view: 60_000, call: 15_000, space: 60_000, prefetch: 0 },
    prefetchMs: 30_000,
    maxRooms: 16,
    maxPrefetchRooms: 4,
};

const PRIORITY: Record<RoomSubscriptionPurpose, number> = { view: 0, call: 1, space: 2, prefetch: 3 };

interface RoomEntry {
    /** Holds by purpose. */
    readonly holds: Map<RoomSubscriptionPurpose, number>;
    /** When this room was last held or released. */
    lastUsed: number;
    /** After its last hold is released, when the room stops being kept. */
    retainUntil: number;
    /** The automatic release of the current prefetch hold. */
    prefetchTimer?: ReturnType<typeof setTimeout>;
    prefetchLease?: RoomSubscriptionLease;
    /** When this room is next due to stop being kept. */
    expiryTimer?: ReturnType<typeof setTimeout>;
}

/**
 * Tracks which rooms should have a sliding sync subscription, and why.
 *
 * Holders take a {@link RoomSubscriptionLease} and release it when they no longer need the room, such as when
 * someone navigates away. A released room is kept for a grace period, so returning to it is instant, then dropped,
 * so subscriptions stop growing over a long session. When there are too many, rooms only kept for their grace
 * period or for a possible visit are dropped first.
 *
 * This class only keeps the books. It calls `onChange` when the set of rooms to subscribe changes; `urgent` is
 * true when someone is waiting for the room: they opened it, joined its call or switched to it as a Space.
 */
export class RoomSubscriptionLeases {
    private readonly rooms = new Map<string, RoomEntry>();
    private disposed = false;

    public constructor(
        private readonly onChange: (urgent: boolean) => void,
        private readonly options: RoomSubscriptionLeaseOptions = DEFAULT_LEASE_OPTIONS,
        private readonly clock: LeaseClock = {
            now: () => Date.now(),
            setTimeout: (callback, ms) => setTimeout(callback, ms),
            clearTimeout: (timer) => clearTimeout(timer),
        },
    ) {}

    /**
     * Hold a room's subscription.
     * @param roomId - The room to keep subscribed.
     * @param purpose - Why. Decides how urgently it is subscribed and how long it stays after release.
     * @returns The hold, to release when the room is no longer needed for this purpose.
     */
    public acquire(roomId: string, purpose: RoomSubscriptionPurpose): RoomSubscriptionLease {
        const entry = this.entry(roomId);
        const wasKept = this.isKept(entry);
        entry.holds.set(purpose, (entry.holds.get(purpose) ?? 0) + 1);
        entry.lastUsed = this.clock.now();
        this.clearExpiry(entry);
        let released = false;
        const lease: RoomSubscriptionLease = {
            roomId,
            purpose,
            release: () => {
                if (released || this.disposed) return;
                released = true;
                this.release(roomId, purpose);
            },
        };
        // Someone opening a room, joining a call or switching Space is waiting for it. A room that was already kept
        // for a possible visit needs no request.
        if (!wasKept || purpose !== "prefetch") this.onChange(purpose !== "prefetch");
        return lease;
    }

    /**
     * Note that someone is likely to open a room soon, such as by pointing at it. The room is kept for a short while;
     * noting it again extends that.
     * @param roomId - The room they may open.
     */
    public prefetch(roomId: string): void {
        if (this.disposed) return;
        const entry = this.entry(roomId);
        if (entry.prefetchTimer !== undefined) {
            this.clock.clearTimeout(entry.prefetchTimer);
            entry.lastUsed = this.clock.now();
        } else {
            entry.prefetchLease = this.acquire(roomId, "prefetch");
        }
        entry.prefetchTimer = this.clock.setTimeout(() => {
            entry.prefetchTimer = undefined;
            const lease = entry.prefetchLease;
            entry.prefetchLease = undefined;
            lease?.release();
        }, this.options.prefetchMs);
    }

    /**
     * Stop keeping a room for a possible visit straight away, such as when it turned out not to exist.
     * Holds for other purposes are unaffected.
     * @param roomId - The room.
     */
    public cancelPrefetch(roomId: string): void {
        const entry = this.rooms.get(roomId);
        if (!entry?.prefetchLease) return;
        if (entry.prefetchTimer !== undefined) this.clock.clearTimeout(entry.prefetchTimer);
        entry.prefetchTimer = undefined;
        const lease = entry.prefetchLease;
        entry.prefetchLease = undefined;
        lease.release();
        if (entry.holds.size === 0) {
            // No grace period: nobody asked to stay.
            entry.retainUntil = 0;
            this.clearExpiry(entry);
            this.rooms.delete(roomId);
            this.onChange(false);
        }
    }

    /**
     * Why a room is currently held. Rooms only kept for their grace period have no purposes.
     * @param roomId - The room.
     */
    public purposes(roomId: string): ReadonlySet<RoomSubscriptionPurpose> {
        return new Set(this.rooms.get(roomId)?.holds.keys());
    }

    /**
     * Whether a room should be subscribed now for one of the leases.
     * @param roomId - The room.
     */
    public has(roomId: string): boolean {
        return this.roomIds().includes(roomId);
    }

    /**
     * The rooms that should be subscribed now, most important first.
     */
    public roomIds(): string[] {
        const now = this.clock.now();
        const essential: [string, RoomEntry][] = [];
        const prefetched: [string, RoomEntry][] = [];
        const retained: [string, RoomEntry][] = [];
        for (const [roomId, entry] of this.rooms) {
            const purpose = this.topPurpose(entry);
            if (purpose === undefined) {
                if (entry.retainUntil > now) retained.push([roomId, entry]);
            } else if (purpose === "prefetch") {
                prefetched.push([roomId, entry]);
            } else {
                essential.push([roomId, entry]);
            }
        }
        const newestFirst = (a: [string, RoomEntry], b: [string, RoomEntry]): number => b[1].lastUsed - a[1].lastUsed;
        prefetched.sort(newestFirst);
        retained.sort(newestFirst);
        const result = essential.map(([roomId]) => roomId);
        for (const [roomId] of prefetched.slice(0, this.options.maxPrefetchRooms)) {
            if (result.length >= this.options.maxRooms) break;
            result.push(roomId);
        }
        for (const [roomId] of retained) {
            if (result.length >= this.options.maxRooms) break;
            result.push(roomId);
        }
        return result;
    }

    /** Release every hold and timer. Nothing is reported afterwards. */
    public dispose(): void {
        this.disposed = true;
        for (const entry of this.rooms.values()) {
            if (entry.prefetchTimer !== undefined) this.clock.clearTimeout(entry.prefetchTimer);
            this.clearExpiry(entry);
        }
        this.rooms.clear();
    }

    private release(roomId: string, purpose: RoomSubscriptionPurpose): void {
        const entry = this.rooms.get(roomId);
        if (!entry) return;
        const count = (entry.holds.get(purpose) ?? 0) - 1;
        if (count > 0) {
            entry.holds.set(purpose, count);
            return;
        }
        entry.holds.delete(purpose);
        const now = this.clock.now();
        entry.lastUsed = now;
        entry.retainUntil = Math.max(entry.retainUntil, now + this.options.graceMs[purpose]);
        if (entry.holds.size > 0) {
            // The room is still held for another purpose, which may be less important.
            this.onChange(false);
            return;
        }
        const graceMs = entry.retainUntil - now;
        if (graceMs <= 0) {
            this.rooms.delete(roomId);
        } else {
            entry.expiryTimer = this.clock.setTimeout(() => {
                entry.expiryTimer = undefined;
                if (entry.holds.size > 0) return;
                this.rooms.delete(roomId);
                this.onChange(false);
            }, graceMs);
        }
        this.onChange(false);
    }

    private entry(roomId: string): RoomEntry {
        let entry = this.rooms.get(roomId);
        if (!entry) {
            entry = { holds: new Map(), lastUsed: this.clock.now(), retainUntil: 0 };
            this.rooms.set(roomId, entry);
        }
        return entry;
    }

    private isKept(entry: RoomEntry): boolean {
        return entry.holds.size > 0 || entry.retainUntil > this.clock.now();
    }

    private topPurpose(entry: RoomEntry): RoomSubscriptionPurpose | undefined {
        let top: RoomSubscriptionPurpose | undefined;
        for (const purpose of entry.holds.keys()) {
            if (top === undefined || PRIORITY[purpose] < PRIORITY[top]) top = purpose;
        }
        return top;
    }

    private clearExpiry(entry: RoomEntry): void {
        if (entry.expiryTimer === undefined) return;
        this.clock.clearTimeout(entry.expiryTimer);
        entry.expiryTimer = undefined;
    }
}
