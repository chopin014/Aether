/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { TypedEventEmitter } from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";

import {
    encodeMessage,
    isNewer,
    parseMessage,
    WATCH_MAX_ITEMS,
    WATCH_MAX_PAYLOAD_BYTES,
    WATCH_RATES,
    WATCH_START_LEAD_SECONDS,
    WATCH_STATE,
    WATCH_SYNC_REQUEST,
    type WatchItem,
    type WatchState,
} from "./WatchTogetherProtocol";

/** The reliable, encrypted call data channel; senders are verified call participants. */
export interface WatchTransport {
    send(payload: Uint8Array): Promise<void>;
    subscribe(listener: (payload: Uint8Array, sender: string) => void): () => void;
}

/** Thrown when an item would make the shared state too large to send. */
export class WatchQueueFullError extends Error {
    public constructor() {
        super("queue_full");
    }
}

export enum WatchTogetherSessionEvent {
    Changed = "changed",
}

type Events = {
    /** `local` is true when this app made the change; false when it came from someone else in the call. */
    [WatchTogetherSessionEvent.Changed]: (
        state: WatchState | null,
        previous: WatchState | null,
        local: boolean,
    ) => void;
};

/** A joiner asks again at these delays, since people already in the call may not be listening to them yet. */
const SYNC_RETRY_MS = [1000, 3000, 7000];
/** Going back within this many seconds of an item's start goes to the previous item instead of restarting it. */
const PREVIOUS_RESTART_SECONDS = 3;

const randomId = (): string => crypto.randomUUID().replaceAll("-", "").slice(0, 16);

/**
 * One call's shared player. It holds the state everyone agrees on and works out where playback should be now;
 * players follow it rather than each other. Positions are measured on this device's clock from the moment a state
 * arrives, so clocks on different machines never need to match. The error is the network delay, about a tenth of a
 * second.
 */
export class WatchTogetherSession extends TypedEventEmitter<WatchTogetherSessionEvent, Events> {
    /** Identifies this app instance in revisions, so two devices of one user still order their changes. */
    public readonly origin = randomId();
    private _state: WatchState | null = null;
    /** This device's clock reading, in milliseconds, at which `state.position` was true. */
    private anchor = 0;
    /** The highest revision seen from anyone, so a new change always sorts after everything already sent. */
    private highestRevision = 0;
    private transport: WatchTransport | null = null;
    private unsubscribe?: () => void;
    private syncTimers: ReturnType<typeof setTimeout>[] = [];

    public constructor(
        private readonly userId: string,
        private readonly now: () => number = () => performance.now(),
    ) {
        super();
    }

    /** The shared state, or null before anyone has started an activity in this call. */
    public get state(): WatchState | null {
        return this._state;
    }

    /** True while something is queued; false before the first item and after someone stops the activity. */
    public get active(): boolean {
        return !!this._state?.items.length;
    }

    /** True while connected to the call, the only time changes can be shared. */
    public get connected(): boolean {
        return this.transport !== null;
    }

    public get current(): WatchItem | null {
        const state = this._state;
        return state?.items[state.index] ?? null;
    }

    /** Where playback should be now, in seconds; negative while a new item counts down to its start. */
    public position(at = this.now()): number {
        const state = this._state;
        if (!state) return 0;
        if (!state.playing) return state.position;
        return state.position + ((at - this.anchor) / 1000) * state.rate;
    }

    /** Connects to the call's data channel, or disconnects from it with null when leaving the call. */
    public setTransport(transport: WatchTransport | null): void {
        if (transport === this.transport) return;
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        this.clearSyncTimers();
        this.transport = transport;
        if (!transport) {
            // Someone who left is no longer watching; the people still in the call keep the activity going.
            this.adopt(null, false);
            return;
        }
        this.unsubscribe = transport.subscribe(this.receive);
        this.send({ type: WATCH_SYNC_REQUEST });
        this.syncTimers = SYNC_RETRY_MS.map((delay) =>
            setTimeout(() => {
                if (!this._state) this.send({ type: WATCH_SYNC_REQUEST });
            }, delay),
        );
    }

    /** Stops listening; the session cannot be used afterwards. */
    public dispose(): void {
        this.setTransport(null);
        this.removeAllListeners();
    }

    /** Replaces whatever is playing with a new queue and starts its first item for everyone. */
    public start(items: readonly WatchItem[]): void {
        if (!items.length) return;
        this.commit({
            session: randomId(),
            items: items.slice(0, WATCH_MAX_ITEMS),
            index: 0,
            playing: true,
            position: this.startPosition(items[0]),
            rate: this._state?.rate ?? 1,
            ended: false,
        });
    }

    /** Adds items to the end of the queue; starts the activity when nothing is playing. */
    public enqueue(items: readonly WatchItem[]): void {
        const state = this._state;
        if (!items.length) return;
        if (!state || !state.items.length) return this.start(items);
        if (state.items.length + items.length > WATCH_MAX_ITEMS) throw new WatchQueueFullError();
        const queue = [...state.items, ...items];
        if (state.ended) {
            const index = state.items.length;
            this.commit({
                items: queue,
                index,
                playing: true,
                position: this.startPosition(queue[index]),
                ended: false,
            });
        } else {
            this.commit({ items: queue });
        }
    }

    /** Plays items straight away, after the current one, keeping the rest of the queue to come after them. */
    public playNow(items: readonly WatchItem[]): void {
        const state = this._state;
        if (!items.length) return;
        if (!state || !state.items.length) return this.start(items);
        if (state.items.length + items.length > WATCH_MAX_ITEMS) throw new WatchQueueFullError();
        const index = state.index + 1;
        const queue = [...state.items.slice(0, index), ...items, ...state.items.slice(index)];
        this.commit({ items: queue, index, playing: true, position: this.startPosition(items[0]), ended: false });
    }

    /** Plays or pauses for everyone; `at` is where this player actually is, when it knows better than the state. */
    public setPlaying(playing: boolean, at?: number): void {
        const state = this._state;
        if (!state?.items.length) return;
        if (playing && state.ended) {
            this.commit({ playing: true, position: this.startPosition(), ended: false });
            return;
        }
        if (state.playing === playing) return;
        const position = at ?? this.position();
        // Pausing during the countdown holds the item at its start rather than at a negative time.
        this.commit({ playing, position: playing ? position : Math.max(0, position) });
    }

    public seek(position: number): void {
        if (!this._state?.items.length || !Number.isFinite(position)) return;
        this.commit({ position: Math.max(0, position), ended: false });
    }

    public setRate(rate: number): void {
        const state = this._state;
        if (!state?.items.length || !WATCH_RATES.includes(rate) || state.rate === rate) return;
        this.commit({ rate, position: this.position() });
    }

    /** Plays the queue item at `index` from its start. */
    public jump(index: number): void {
        const state = this._state;
        if (!state || index < 0 || index >= state.items.length) return;
        this.commit({ index, playing: true, position: this.startPosition(state.items[index]), ended: false });
    }

    public next(): void {
        const state = this._state;
        if (!state?.items.length) return;
        if (state.index + 1 < state.items.length) this.jump(state.index + 1);
        else this.commit({ playing: false, position: Math.max(0, this.position()), ended: true });
    }

    /** Restarts the item, or goes to the previous one when it has only just started. */
    public previous(): void {
        const state = this._state;
        if (!state?.items.length) return;
        if (this.position() > PREVIOUS_RESTART_SECONDS || state.index === 0) this.seek(0);
        else this.jump(state.index - 1);
    }

    /** Removes an item; removing the one playing moves on to the next, and removing the last one stops. */
    public remove(itemId: string): void {
        const state = this._state;
        const removed = state?.items.findIndex((item) => item.id === itemId) ?? -1;
        if (!state || removed < 0) return;
        const items = state.items.filter((item) => item.id !== itemId);
        if (!items.length) return this.stop();
        if (removed < state.index) {
            this.commit({ items, index: state.index - 1 });
        } else if (removed > state.index) {
            this.commit({ items });
        } else if (removed < items.length) {
            this.commit({ items, position: this.startPosition(items[removed]), ended: false });
        } else {
            this.commit({ items, index: items.length - 1, playing: false, position: 0, ended: true });
        }
    }

    /** Ends the activity for everyone in the call. */
    public stop(): void {
        if (!this._state?.items.length) return;
        this.commit({ items: [], index: -1, playing: false, position: 0, ended: false });
    }

    /**
     * Reports that this device played an item to its end. Every player reports it, and all of them make the same
     * change, so whichever arrives first wins and the rest agree with it.
     */
    public itemEnded(itemId: string): void {
        const state = this._state;
        if (!state?.playing || this.current?.id !== itemId) return;
        this.next();
    }

    /** A new item waits for everyone's player to load; a `t=` link starts at its time without waiting. */
    private startPosition(item?: WatchItem): number {
        return item?.start ?? -WATCH_START_LEAD_SECONDS;
    }

    private commit(patch: Partial<Omit<WatchState, "revision" | "author" | "origin">>): void {
        const base = this._state;
        const at = this.now();
        const next: WatchState = {
            session: base?.session ?? randomId(),
            items: [],
            index: -1,
            playing: false,
            rate: 1,
            ended: false,
            ...base,
            ...patch,
            position: patch.position ?? this.position(at),
            revision: Math.max(this.highestRevision, base?.revision ?? 0) + 1,
            author: this.userId,
            origin: this.origin,
        };
        if (encodeMessage({ type: WATCH_STATE, state: next }).byteLength > WATCH_MAX_PAYLOAD_BYTES) {
            throw new WatchQueueFullError();
        }
        this.highestRevision = next.revision;
        this.adopt(next, true, at);
        this.broadcast();
    }

    private broadcast(): void {
        const state = this._state;
        if (!state) return;
        this.send({ type: WATCH_STATE, state: { ...state, position: this.position() } });
    }

    private send(message: Parameters<typeof encodeMessage>[0]): void {
        if (!this.transport) return;
        try {
            this.transport.send(encodeMessage(message)).catch((error) => {
                logger.warn("Watch Together: could not send", error);
            });
        } catch (error) {
            // The transport throws synchronously while the call's data channel is not ready.
            logger.warn("Watch Together: could not send", error);
        }
    }

    private readonly receive = (payload: Uint8Array): void => {
        const message = parseMessage(payload);
        if (!message) return;
        if (message.type === WATCH_SYNC_REQUEST) {
            if (this.active) this.broadcast();
            return;
        }
        this.highestRevision = Math.max(this.highestRevision, message.state.revision);
        if (this._state && !isNewer(message.state, this._state)) return;
        this.clearSyncTimers();
        this.adopt(message.state, false);
    };

    private adopt(state: WatchState | null, local: boolean, at = this.now()): void {
        const previous = this._state;
        if (state === previous) return;
        this._state = state;
        this.anchor = at;
        this.emit(WatchTogetherSessionEvent.Changed, state, previous, local);
    }

    private clearSyncTimers(): void {
        for (const timer of this.syncTimers) clearTimeout(timer);
        this.syncTimers = [];
    }
}
