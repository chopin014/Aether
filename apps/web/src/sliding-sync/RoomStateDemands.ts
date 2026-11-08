/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { MSC3575_STATE_KEY_LAZY, MSC3575_STATE_KEY_ME, MSC3575_WILDCARD } from "matrix-js-sdk/src/sliding-sync";

import { type LeaseClock } from "./RoomSubscriptionLeases";

/** Some of a room's state: one event type, with one state key or every key. */
export interface RoomStateSelector {
    /** A concrete event type. Every type at once is not a selector: it would bring every member of large rooms. */
    readonly type: string;
    /** The state key, or undefined for every key. */
    readonly stateKey?: string;
}

/** A hold on some of a room's state, asked of the server until it is released. */
export interface RoomStateDemand {
    readonly roomId: string;
    /**
     * Whether the state is here: the server has answered a request asking for all of it, and the answer has been
     * applied. A missing event is then one the room does not have.
     */
    isReady(): boolean;
    /**
     * Wait until the state is here.
     * @param timeoutMs - How long to wait.
     * @returns Resolves once ready, or straight away if already ready.
     * @throws {RoomStateUnavailableError} when the server answered without the room, the wait timed out, or the
     *     demand was released or cancelled.
     */
    whenReady(timeoutMs: number): Promise<void>;
    /** Stop asking for the state. Releasing twice has no further effect. */
    release(): void;
}

/** Why some room state could not be had. */
export class RoomStateUnavailableError extends Error {
    public constructor(
        public readonly reason: "absent" | "timeout" | "released",
        roomId: string,
    ) {
        super(`Room state for ${roomId} is unavailable: ${reason}`);
        this.name = "RoomStateUnavailableError";
    }
}

/** How long a room's state is kept asked for after its last demand is released, so repeated reads are instant. */
export const DEMAND_LINGER_MS = 30_000;

/**
 * The most rooms whose released state is kept asked for. Every request carries every subscription, so a reader of
 * many rooms, one after another, must not leave them all subscribed: the longest released are let go first.
 */
export const MAX_LINGERING_ROOMS = 8;

/** Protocol tokens that a state key cannot be sent as: such keys are asked for with every key, then picked out. */
const STATE_KEY_TOKENS = new Set<string>([MSC3575_WILDCARD, MSC3575_STATE_KEY_ME, MSC3575_STATE_KEY_LAZY]);

/**
 * The `required_state` entry that brings a selector.
 * @throws when the selector asks for every event type.
 */
export function requiredStateFor(selector: RoomStateSelector): [string, string] {
    if (!selector.type || selector.type === MSC3575_WILDCARD) {
        throw new Error("A room state selector needs a concrete event type");
    }
    const { stateKey } = selector;
    return [selector.type, stateKey === undefined || STATE_KEY_TOKENS.has(stateKey) ? MSC3575_WILDCARD : stateKey];
}

/** Whether a subscription's `required_state` brings a selector's state. */
export function requiredStateCovers(
    requiredState: readonly (readonly string[])[],
    selector: RoomStateSelector,
): boolean {
    const [type, stateKey] = requiredStateFor(selector);
    return requiredState.some(
        ([entryType, entryKey]) =>
            (entryType === MSC3575_WILDCARD && entryKey === MSC3575_WILDCARD) ||
            (entryType === type && (entryKey === MSC3575_WILDCARD || entryKey === stateKey)),
    );
}

interface Demand {
    readonly roomId: string;
    readonly selectors: readonly RoomStateSelector[];
    ready: boolean;
    released: boolean;
    readonly waiters: Set<{ resolve: () => void; reject: (error: RoomStateUnavailableError) => void }>;
}

interface RoomEntry {
    readonly demands: Set<Demand>;
    /**
     * Selectors of released demands, by their `required_state` entry, still asked for a while, and whether they have
     * arrived, so a new demand for them is ready at once.
     */
    readonly lingering: Map<string, { readonly selector: RoomStateSelector; ready: boolean }>;
    lingerTimer?: ReturnType<typeof setTimeout>;
}

const selectorKey = (selector: RoomStateSelector): string => JSON.stringify(requiredStateFor(selector));

const realClock: LeaseClock = {
    now: () => Date.now(),
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (timer) => clearTimeout(timer),
};

/**
 * Tracks the room state that readers outside the room view need, such as integration managers and widgets, which
 * may read any event type. Sliding sync sends a room only the state its subscriptions name, so each demanded room
 * is subscribed with those selectors added, and a demand is ready once an answer to a request naming them has been
 * applied.
 */
export class RoomStateDemands {
    private readonly rooms = new Map<string, RoomEntry>();
    // Rooms with released state still asked for, the longest released first.
    private readonly lingeringOrder = new Set<string>();

    /**
     * @param onChange - Called when the rooms or selectors asked for change, to send the change.
     * @param clock - Timers, replaceable in tests.
     */
    public constructor(
        private readonly onChange: () => void,
        private readonly clock: LeaseClock = realClock,
    ) {}

    /**
     * Ask for some of a room's state until the returned demand is released.
     * @throws when a selector asks for every event type.
     */
    public acquire(roomId: string, selectors: readonly RoomStateSelector[]): RoomStateDemand {
        for (const selector of selectors) requiredStateFor(selector);
        let entry = this.rooms.get(roomId);
        const covered = !!entry && this.isCovered(entry, selectors);
        if (!entry) {
            entry = { demands: new Set(), lingering: new Map() };
            this.rooms.set(roomId, entry);
        }
        const demand: Demand = {
            roomId,
            selectors: [...selectors],
            // State that arrived for an earlier demand, still asked for, is here already.
            ready: covered,
            released: false,
            waiters: new Set(),
        };
        entry.demands.add(demand);
        if (!covered) this.onChange();
        return {
            roomId,
            isReady: () => demand.ready,
            whenReady: (timeoutMs) => this.whenReady(demand, timeoutMs),
            release: () => this.release(demand),
        };
    }

    /** The rooms with state asked for. */
    public roomIds(): IterableIterator<string> {
        return this.rooms.keys();
    }

    /** Whether any of a room's state is asked for. */
    public has(roomId: string): boolean {
        return this.rooms.has(roomId);
    }

    /** Every selector asked for in a room, from open and lingering demands. */
    public selectorsFor(roomId: string): RoomStateSelector[] {
        const entry = this.rooms.get(roomId);
        if (!entry) return [];
        return [
            ...[...entry.lingering.values()].map(({ selector }) => selector),
            ...[...entry.demands].flatMap((demand) => demand.selectors),
        ];
    }

    /**
     * Note that an answer has been applied to a request that subscribed a room with this `required_state`.
     * Demands whose selectors it named are ready.
     */
    public answered(roomId: string, requiredState: readonly (readonly string[])[]): void {
        const entry = this.rooms.get(roomId);
        if (!entry) return;
        for (const lingering of entry.lingering.values()) {
            if (requiredStateCovers(requiredState, lingering.selector)) lingering.ready = true;
        }
        for (const demand of entry.demands) {
            if (demand.ready || !demand.selectors.every((selector) => requiredStateCovers(requiredState, selector))) {
                continue;
            }
            demand.ready = true;
            for (const waiter of demand.waiters) waiter.resolve();
            demand.waiters.clear();
        }
    }

    /** Note that the server answered a request asking about a room without it, so it does not serve that room. */
    public absent(roomId: string): void {
        const entry = this.rooms.get(roomId);
        if (!entry) return;
        for (const demand of entry.demands) this.settle(demand, "absent");
    }

    /**
     * Forget what has arrived, for a new connection: its first answer brings each room's state afresh. Waiters keep
     * waiting for it.
     */
    public reset(): void {
        for (const entry of this.rooms.values()) {
            for (const lingering of entry.lingering.values()) lingering.ready = false;
            for (const demand of entry.demands) demand.ready = false;
        }
    }

    /** Release every demand and cancel every wait, such as on logout. */
    public dispose(): void {
        for (const entry of this.rooms.values()) {
            if (entry.lingerTimer !== undefined) this.clock.clearTimeout(entry.lingerTimer);
            for (const demand of entry.demands) {
                demand.released = true;
                this.settle(demand, "released");
            }
        }
        this.rooms.clear();
        this.lingeringOrder.clear();
    }

    private isCovered(entry: RoomEntry, selectors: readonly RoomStateSelector[]): boolean {
        const readyState = [
            ...[...entry.lingering.values()].filter(({ ready }) => ready).map(({ selector }) => selector),
            ...[...entry.demands].filter((demand) => demand.ready).flatMap((demand) => demand.selectors),
        ].map(requiredStateFor);
        return selectors.every((selector) => requiredStateCovers(readyState, selector));
    }

    private whenReady(demand: Demand, timeoutMs: number): Promise<void> {
        if (demand.ready) return Promise.resolve();
        if (demand.released) return Promise.reject(new RoomStateUnavailableError("released", demand.roomId));
        return new Promise((resolve, reject) => {
            const waiter = {
                resolve: (): void => {
                    this.clock.clearTimeout(timer);
                    resolve();
                },
                reject: (error: RoomStateUnavailableError): void => {
                    this.clock.clearTimeout(timer);
                    reject(error);
                },
            };
            const timer = this.clock.setTimeout(() => {
                demand.waiters.delete(waiter);
                reject(new RoomStateUnavailableError("timeout", demand.roomId));
            }, timeoutMs);
            demand.waiters.add(waiter);
        });
    }

    private settle(demand: Demand, reason: RoomStateUnavailableError["reason"]): void {
        for (const waiter of demand.waiters) waiter.reject(new RoomStateUnavailableError(reason, demand.roomId));
        demand.waiters.clear();
    }

    private release(demand: Demand): void {
        if (demand.released) return;
        demand.released = true;
        this.settle(demand, "released");
        const entry = this.rooms.get(demand.roomId);
        if (!entry?.demands.delete(demand)) return;
        // The state stays asked for a while, so the next read of it is instant.
        for (const selector of demand.selectors) {
            const key = selectorKey(selector);
            const ready = demand.ready || entry.lingering.get(key)?.ready === true;
            entry.lingering.set(key, { selector, ready });
        }
        if (entry.lingerTimer !== undefined) this.clock.clearTimeout(entry.lingerTimer);
        entry.lingerTimer = this.clock.setTimeout(() => this.stopLingering(demand.roomId), DEMAND_LINGER_MS);
        // Most recently released last.
        this.lingeringOrder.delete(demand.roomId);
        this.lingeringOrder.add(demand.roomId);
        for (const roomId of this.lingeringOrder) {
            if (this.lingeringOrder.size <= MAX_LINGERING_ROOMS) break;
            this.stopLingering(roomId);
        }
    }

    /** Stop asking for a room's released state. */
    private stopLingering(roomId: string): void {
        this.lingeringOrder.delete(roomId);
        const entry = this.rooms.get(roomId);
        if (!entry) return;
        if (entry.lingerTimer !== undefined) this.clock.clearTimeout(entry.lingerTimer);
        entry.lingerTimer = undefined;
        entry.lingering.clear();
        if (entry.demands.size === 0) this.rooms.delete(roomId);
        this.onChange();
    }
}
